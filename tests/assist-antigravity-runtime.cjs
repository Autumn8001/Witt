"use strict";
// Trusted development-only factory, injected into the real server in NODE_ENV=test.
// Every binding gets a different socket/home; there are no model-selectable ids.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { createRemoteCliBridge } = require("../backend/remote-assist/cli-bridge");
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
module.exports = async (binding, execute, authorization = {}) => {
  const repo = path.resolve(__dirname, ".."), base = process.env.ASSIST_TEST_DIR;
  const directory = fs.mkdtempSync(path.join(base, "agy-cli-"));
  const channel = path.join(directory, "channel"), home = path.join(directory, "home"), cwd = path.join(directory, "work");
  for (const p of [channel, home, cwd]) fs.mkdirSync(p, { mode: 0o755 });
  const settings = path.join(home, ".gemini/antigravity-cli");
  fs.mkdirSync(settings, { recursive: true });
  // Use native fine-grained rules, retaining request-review for everything else.
  fs.writeFileSync(path.join(settings, "settings.json"), JSON.stringify({
    modelProvider: "gemini", toolPermission: "request-review", allowNonWorkspaceAccess: false,
    enableTelemetry: false, permissions: { allow: ["command(chloe-remote)"],
      deny: ["read_file(/root)", "read_file(/etc)", "read_file(/proc)", "read_file(/channel)", "command(sudo)", "mcp(*)"], ask: [] },
  }), { mode: 0o444 });
  for (const p of [home, path.join(home, ".gemini"), settings]) fs.chownSync(p, 10001, 10001);
  const bridge = await createRemoteCliBridge({ socketPath: path.join(channel, "control.sock"), uid: 10001, execute,
    fullAccessFor: authorization.fullAccessFor });
  fs.writeFileSync(path.join(directory, "chloe-remote"), '#!/bin/sh\nexec /tools/node /tools/chloe-remote.js "$@"\n', { mode: 0o555 });
  const envFile = path.join(directory, "model.env");
  fs.writeFileSync(envFile, ["GEMINI_API_KEY=" + (process.env.GEMINI_API_KEY || ""), "GOOGLE_GEMINI_BASE_URL=" + (process.env.GOOGLE_GEMINI_BASE_URL || "")].join("\n") + "\n", { mode: 0o600 });
  const name = "chloe-agy-test-" + crypto.randomBytes(6).toString("hex");
  const args = ["run", "--rm", "--user", "10001:10001", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "2g", "--cpus", "2", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "--tmpfs", "/work:rw,nosuid,nodev,size=32m,uid=10001,gid=10001", "--workdir", "/work",
    "-v", channel + ":/channel:ro", "-v", home + ":/home/assist:rw",
    "-v", "/root/.local/bin/agy.orig-elf:/tools/agy:ro", "-v", "/usr/bin/qemu-x86_64:/tools/qemu:ro",
    "-v", "/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu:ro", "-v", "/usr/local/bin/node:/tools/node:ro",
    "-v", path.join(repo, "backend/cli/chloe-remote.js") + ":/tools/chloe-remote.js:ro", "-v", path.join(directory, "chloe-remote") + ":/tools/chloe-remote:ro",
    "--env-file", envFile, "-e", "HOME=/home/assist", "-e", "PATH=/tools:/usr/bin:/bin", "-e", "CHLOE_REMOTE_SOCKET=/channel/control.sock", "python:3.11-slim-bookworm"];
  fs.writeFileSync(path.join(directory, "container-args.json"), JSON.stringify(args), { mode: 0o600 });
  const launcher = path.join(directory, "agy-isolated");
  const evidence = path.join(directory, "process-evidence.jsonl");
  const recorder = path.join(directory, "record-events.py");
  // Forward the original NDJSON unchanged. Persist metadata only, never prompts,
  // model keys or customer file contents in this process evidence log.
  fs.writeFileSync(recorder, `import sys,json\nfor line in sys.stdin:\n sys.stdout.write(line);sys.stdout.flush()\n try:\n  d=json.loads(line);event=d.get('event');data=d.get(event,{})\n  if event=='init':v={'event':event,'model':data.get('model'),'permission_mode':data.get('permission_mode'),'tools':data.get('tools')}\n  elif event=='step_update' and data.get('tool_info'):v={'event':event,'state':data.get('state'),'tool':data['tool_info'].get('name')}\n  else:continue\n  with open(sys.argv[1],'a') as f:f.write(json.dumps(v)+'\\n')\n except (ValueError,TypeError):pass\n`, { mode: 0o600 });
  fs.writeFileSync(launcher, `#!/bin/bash\nset -euo pipefail\nname=${quote(name)}-$$\ntrap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT HUP INT TERM\n` +
    `docker ${args.map(quote).join(" ").replace(/^'run' /, "run --name \"$name\" ")} /tools/qemu -cpu max /tools/agy "$@" | python3 -u ${quote(recorder)} ${quote(path.join(directory, "native-events.jsonl"))} &\npid=$!\n` +
    `for n in 1 2 3 4 5; do\n if docker inspect "$name" --format '{{json .State.Pid}} {{json .Path}} {{json (index .Args 2)}} {{json .Config.User}}' >> ${quote(evidence)} 2>/dev/null; then break; fi\n /bin/sleep 0.2\ndone\nwait "$pid"\n`, { mode: 0o700 });
  return { cwd, home: "/home/assist", geminiBin: launcher,
    remoteCli: { isolated: true, socketPath: "/channel/control.sock" },
    close: async () => { await bridge.close(); fs.rmSync(envFile, { force: true }); },
  };
};
