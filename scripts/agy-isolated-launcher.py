#!/usr/bin/python3
"""Trusted systemd launcher: full-access administrators stay unrestricted.

Ordinary users get a private DynamicUser, StateDirectory, HOME and mount
namespace. A missing/invalid server identity fails closed. Install root-owned
beside a verified copy of agy.orig-elf; never run this from a user-writable path.
"""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import uuid

LIB = Path('/usr/local/lib/chloe-antigravity')
BINARY = LIB / 'agy.orig-elf'
SELF = LIB / 'launcher.py'
QEMU = '/usr/bin/qemu-x86_64'
SCOPE = re.compile(r'^[0-9a-f]{32}$')
IDENTITY = ('# Chloe\n\n你是 Chloe，面向当前用户的 AI 助手。不要将维护者、'
            '开发者或客户的姓名作为自己的身份，不要主动披露维护者个人信息。\n')
ENV_KEYS = {'PATH', 'LANG', 'TZ', 'GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL',
            'WITT_CPA_KEY', 'SSL_CERT_FILE', 'SSL_CERT_DIR'}


def root_for(scope):
    if not SCOPE.fullmatch(scope):
        raise ValueError('ANTIGRAVITY_AUTHENTICATED_SCOPE_REQUIRED')
    return Path('/var/lib') / ('chloe-antigravity-' + scope)


def sandbox_command(scope, unit, cwd, environment_file, writable=True, command=None):
    root = root_for(scope)
    workspace = root / 'workspace'
    if workspace.is_symlink() or (workspace.exists() and workspace.resolve().parent != root.resolve()):
        raise ValueError('ANTIGRAVITY_WORKSPACE_SYMLINK_REFUSED')
    # Validate both lexical and resolved paths: no sibling/prefix/symlink escape.
    requested = Path(cwd).absolute()
    if not (requested.is_relative_to(workspace) or requested.is_relative_to(workspace.resolve())) or not requested.resolve().is_relative_to(workspace.resolve()):
        raise ValueError('ANTIGRAVITY_WORKSPACE_OUTSIDE_USER_SCOPE')
    # systemd moves DynamicUser state under /var/lib/private. The host's cwd
    # resolves there on the second turn, but the service must use its public bind.
    requested = workspace / requested.resolve().relative_to(workspace.resolve())
    properties = [
        'DynamicUser=yes', 'User=cag' + scope[:20],
        'StateDirectory=chloe-antigravity-' + scope, 'StateDirectoryMode=0700',
        'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes',
        'PrivateDevices=yes', 'ProtectProc=invisible', 'ProcSubset=pid',
        'NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'AmbientCapabilities=',
        'RestrictSUIDSGID=yes', 'RestrictNamespaces=yes', 'LockPersonality=yes',
        'ProtectKernelTunables=yes', 'ProtectKernelModules=yes',
        'ProtectControlGroups=yes', 'RestrictRealtime=yes', 'UMask=0077',
        'KillMode=control-group', 'TimeoutStopSec=5s', 'RuntimeMaxSec=30min',
        'EnvironmentFile=' + str(environment_file),
        'InaccessiblePaths=-/run/witt -/run/chloe-antigravity-env -/run/docker.sock -/run/podman -/run/dbus -/run/systemd/private',
    ]
    cgroup = Path('/proc/self/cgroup').read_text()
    parent = re.search(r'/system\.slice/(witt(?:-worker)?\.service)(?:/|$)', cgroup, re.M)
    if parent:
        # A backend/worker restart must also terminate its transient tool groups.
        properties.append('BindsTo=' + parent.group(1))
    inputs = Path('/run/chloe-antigravity-inputs') / scope
    if inputs.is_dir():
        properties.append(f'BindReadOnlyPaths={inputs}:/inputs')
    if not writable:
        # StateDirectory is mounted from /var/lib/private. Protect both its
        # physical path and the public alias against that implicit RW bind.
        properties.append('ReadOnlyPaths=' + str(workspace) + ' ' + str(workspace.resolve()))
        properties.append(f'BindReadOnlyPaths={workspace.resolve()}:{workspace}')
    args = ['systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--service-type=exec',
            '--description=Chloe isolated coding session', '--unit=' + unit]
    for prop in properties:
        args += ['--property=' + prop]
    return args + (command or ['/usr/bin/python3', str(SELF), '--inside', scope, str(requested)])


def inside(scope, cwd, cli_args):
    root = root_for(scope)
    home = root / 'home'
    home.mkdir(mode=0o700, exist_ok=True)
    workspace = root / 'workspace'
    workspace.mkdir(mode=0o700, exist_ok=True)
    requested = Path(cwd).resolve()
    if not requested.is_relative_to(workspace.resolve()):
        raise ValueError('ANTIGRAVITY_WORKSPACE_OUTSIDE_USER_SCOPE')
    os.environ.update(HOME=str(home), USER=os.environ.get('USER', 'chloe'),
                      TMPDIR='/tmp', XDG_CONFIG_HOME=str(home / '.config'),
                      XDG_CACHE_HOME=str(home / '.cache'))
    state = home / '.gemini/antigravity-cli'
    scratch = state / 'scratch'
    scratch.mkdir(parents=True, mode=0o700, exist_ok=True)
    identity = scratch / 'GEMINI.md'
    if not identity.exists():
        identity.write_text(IDENTITY, encoding='utf-8')
    settings = state / 'settings.json'
    if not settings.exists():
        settings.write_text(json.dumps({'modelProvider': 'gemini', 'trustedWorkspaces': [str(workspace)]}), encoding='utf-8')
    os.chdir(requested)
    if cli_args[:1] == ['--grok']:
        config = home / '.grok/config.toml'
        config.parent.mkdir(mode=0o700, exist_ok=True)
        if not config.exists():
            config.write_bytes((LIB / 'grok-config.toml').read_bytes())
        binary = str(LIB / 'grok.orig-elf')
        os.execv(binary, [binary, *cli_args[1:]])
    os.execv(QEMU, [QEMU, '-cpu', 'max', str(BINARY), *cli_args])


def main(args):
    if args[:1] == ['--inside']:
        if os.geteuid() == 0:
            raise ValueError('SANDBOX_MUST_NOT_RUN_AS_ROOT')
        inside(args[1], args[2], args[3:])
    if os.geteuid() != 0:
        raise ValueError('TRUSTED_SERVICE_REQUIRED')
    grok = args[:1] == ['--grok']
    if grok:
        args = args[1:]
    if os.environ.get('CHLOE_AGY_ADMIN_EXECUTION') == '1':
        # Preserve existing administrator sessions and full filesystem access.
        os.environ.update(HOME='/home/agytest', USER='root')
        if grok:
            binary = str(LIB / 'grok.orig-elf')
            os.execv(binary, [binary, *args])
        os.execv(QEMU, [QEMU, '-cpu', 'max', str(BINARY), *args])
    if args in (['--version'], ['models']):
        os.environ.update(HOME='/home/agytest', USER='root')
        if grok:
            binary = str(LIB / 'grok.orig-elf')
            os.execv(binary, [binary, *args])
        os.execv(QEMU, [QEMU, '-cpu', 'max', str(BINARY), *args])
    scope = os.environ.get('CHLOE_AGY_USER_SCOPE', '')
    root = root_for(scope)
    workspace = root / 'workspace'
    # Before systemd changes ownership, only root creates the initial state.
    if not root.exists():
        workspace.mkdir(parents=True, mode=0o700)
    if not workspace.is_dir():
        raise ValueError('ANTIGRAVITY_WORKSPACE_MISSING')
    unit = 'chloe-agy-' + scope + '-' + uuid.uuid4().hex[:10]
    env_dir = Path('/run/chloe-antigravity-env')
    env_dir.mkdir(mode=0o700, exist_ok=True)
    fd, filename = tempfile.mkstemp(prefix='env-', dir=env_dir)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as env_file:
            for key in sorted(ENV_KEYS):
                value = os.environ.get(key)
                if value is not None:
                    # systemd EnvironmentFile quoting, never shell evaluation.
                    if '\n' in value or '\r' in value or '\x00' in value:
                        raise ValueError('INVALID_HARNESS_ENVIRONMENT')
                    env_file.write(key + '="' + value.replace('\\', '\\\\').replace('"', '\\"') + '"\n')
        command = sandbox_command(scope, unit, os.getcwd(), filename,
                                  os.environ.get('CHLOE_AGY_WORKSPACE_WRITE') != '0') + (['--grok'] if grok else []) + args
        child = subprocess.Popen(command)
        def stop(signum, _frame):
            # Killing the local pipe client alone must never leave remote tools running.
            subprocess.run(['systemctl', 'stop', unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=12)
            if child.poll() is None:
                child.terminate()
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        return child.wait()
    finally:
        Path(filename).unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print('Chloe Antigravity isolation refused: ' + str(error), file=sys.stderr)
        sys.exit(126)
