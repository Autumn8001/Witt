"use strict";
// Opt-in disposable development probe. Invoked over SSH by assist-cli-spike.py.
// The Docker daemon is existing infrastructure; no service/config is installed.
const fs = require("node:fs"), path = require("node:path"), https = require("node:https");
const assert = require("node:assert/strict");
const { execFileSync, execFile } = require("node:child_process");
const runFile = require("node:util").promisify(execFile);
const { createRemoteCliBridge } = require("../backend/remote-assist/cli-bridge");
const { call } = require("../backend/cli/chloe-remote");
const { GrokBuildAdapter } = require("../backend/runtime/grok-build-adapter");
const base = path.resolve(__dirname, ".."), context = JSON.parse(fs.readFileSync(path.join(base, "context.json")));
// Test-only SSH stdio relay to the loopback Windows gateway. It avoids opening
// any public listener or changing sshd forwarding policy. Production uses an
// in-process execute callback with the same existing service/dispatcher.
const pending = new Map();let requestId = 0;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const response=JSON.parse(line), waiter=pending.get(response.id);if(!waiter)return;
  pending.delete(response.id);clearTimeout(waiter.timer);
  if(response.error)waiter.reject(Error(response.error));else waiter.resolve(response.result);
});
const request = (route, body, control = false) => new Promise((resolve,reject) => {
  const id=++requestId,timer=setTimeout(()=>{pending.delete(id);reject(Error('RELAY_TIMEOUT'))},100000);
  pending.set(id,{resolve,reject,timer});
  console.log(JSON.stringify({rpc:true,id,route,body,control}));
});
const operation = (operation, args) => request("/internal/remote-workspaces/mcp", { operation, args }).then(v => v.result);

(async () => {
  const channel = path.join(base, "channel"), home = path.join(base, "model-home");
  fs.mkdirSync(channel, { mode: 0o755 }); fs.mkdirSync(home, { mode: 0o700 }); fs.chownSync(home, 10001, 10001);
  const socketPath = path.join(channel, "control.sock");
  const bridge = await createRemoteCliBridge({ socketPath, uid: 10001, execute: operation });
  const report = {}, events = [], name = "chloe-cli-spike-" + process.pid;
  try {
    await assert.rejects(() => request("/internal/remote-workspaces/mcp", { operation: "workspace.read", args: { path: "README.md" } }, "invalid"));
    await assert.rejects(() => call(socketPath, { operation: "workspace.read", args: { path: "../outside.txt" } }), /INVALID_PATH/);
    await assert.rejects(() => call(socketPath, { operation: "workspace.read", args: { path: context.root + "/README.md" } }), /INVALID_PATH/);
    await assert.rejects(() => call(socketPath, { operation: "workspace.read", args: { path: "README.md" }, device_id: "other" }), /INVALID_REQUEST/);
    await assert.rejects(() => call(socketPath, { operation: "workspace.read", args: { path: "escape/secret.txt" } }), /PATH_OUTSIDE_ROOT|PATH_NOT_FOUND/);
    report.binding = "PASS: invalid auth, traversal, absolute paths, Windows junction escape and device selector refused";
    // Use the documented custom provider format, with a private server-side key.
    // No Assist secret, customer credentials or server paths enter the container.
    fs.mkdirSync(path.join(home, ".grok"), { mode: 0o700 }); fs.chownSync(path.join(home, ".grok"), 10001, 10001);
    const env = {};
    for (const line of fs.readFileSync("/root/.witt/app.env", "utf8").split(/\r?\n/)) {
      const at = line.indexOf("="); if (at > 0 && !line.startsWith("#")) env[line.slice(0, at)] = line.slice(at + 1).replace(/^['"]|['"]$/g, "");
    }
    fs.writeFileSync(path.join(base, "model.env"), "WITT_CPA_KEY=" + env.WITT_CPA_API_KEY + "\n", { mode: 0o600 });
    fs.writeFileSync(path.join(home, ".grok/config.toml"), `[model.cli-test]\nmodel = "gemini-3.8-flash-high"\nbase_url = "https://cpa.stellarbit.site/v1"\nenv_key = "WITT_CPA_KEY"\napi_backend = "chat_completions"\n[shell_environment_policy]\ninherit = "none"\ninclude_only = ["PATH", "HOME", "CHLOE_REMOTE_SOCKET"]\nset = { PATH = "/tools:/usr/bin:/bin", HOME = "/home/assist", CHLOE_REMOTE_SOCKET = "/channel/control.sock" }\n`, { mode: 0o444 });
    fs.writeFileSync(path.join(base, "chloe-remote"), '#!/bin/sh\nexec /tools/node /tools/chloe-remote.js "$@"\n', { mode: 0o555 });
    const dockerArgs = ["run", "--rm", "--name", name, "--user", "10001:10001", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "1g", "--cpus", "1", "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m", "--tmpfs", "/work:rw,nosuid,nodev,size=16m,uid=10001,gid=10001", "--workdir", "/work",
      "-v", channel + ":/channel:ro", "-v", home + ":/home/assist:rw", "-v", "/root/.grok/downloads/grok-linux-x86_64:/tools/grok:ro", "-v", "/usr/local/bin/node:/tools/node:ro", "-v", path.join(base, "backend/cli/chloe-remote.js") + ":/tools/chloe-remote.js:ro", "-v", path.join(base, "chloe-remote") + ":/tools/chloe-remote:ro", "--env-file", path.join(base, "model.env"), "-e", "HOME=/home/assist", "-e", "PATH=/tools:/usr/bin:/bin", "-e", "CHLOE_REMOTE_SOCKET=/channel/control.sock", "python:3.11-slim-bookworm"];
    // Verify actual kernel/container isolation, independently of model promises.
    const checkName = name + "-isolation";
    const checkArgs = [...dockerArgs]; checkArgs[checkArgs.indexOf(name)] = checkName;
    const isolation = await runFile("docker", [...checkArgs, "sh", "-c", "test ! -e /root/.witt/app.env && test ! -e /opt/witt && test ! -e /var/run/docker.sock && test ! -e /context.json && ! touch /etc/chloe-write-check 2>/dev/null && chloe-remote read README.md"], { encoding: "utf8", timeout: 30000 });
    assert.ok(isolation.stdout.includes(context.marker)); report.isolation = "PASS: non-root read-only container, no production files/Docker socket/customer credentials mounted";
    const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
    const launcher = path.join(base, "isolated-grok");
    fs.writeFileSync(launcher, "#!/bin/sh\nexec docker " + dockerArgs.map(quote).join(" ") + ' /tools/grok "$@"\n', { mode: 0o700 });
    const adapter = new GrokBuildAdapter({ bin: launcher, model: "cli-test", cwd: base, remoteCli: { isolated: true, socketPath: "/channel/control.sock", cwd: "/work" }, permissionMode: "dontAsk", timeoutMs: 180000 });
    const prompt = `This is an explicitly authorized Windows development fixture. Use ONLY native bash calls to chloe-remote, never MCP or local file tools. Run chloe-remote --help first. Read README.md, list the project, read verification.txt (JSON includes sha256). Patch verification.txt replacing the marker with the same marker plus -edited, preserving newline and using the actual expected_sha256. Customer will approve the diff. Then execute powershell.exe with argv ["-NoProfile","-NonInteractive","-File","check.ps1"] in cwd "." using chloe-remote exec. Customer will approve that command. Report project structure, the before/after diff from the patch result, test stdout including OS and CWD. Never git commit. If an operation fails, report failure, do not retry writes or commands.`;
    const handle = adapter.sendPrompt({ prompt, maxTurns: 16 });
    handle.events.on("event", event => events.push(event));
    const result = await handle.done;
    fs.writeFileSync(path.join(base, "model-events.json"), JSON.stringify({ result, events }, null, 2), { mode: 0o600 });
    const text = JSON.stringify(events);
    const modified = await operation("workspace.read", { path: "verification.txt" });
    report.harness = result.ok && JSON.stringify(modified).includes(context.marker + "-edited") && text.includes("TEST_PASS") && text.includes("Win32NT")
      ? "PASS: real Grok Build native bash -> CLI -> WSS -> Windows read/edit/PowerShell test (Gemini test upstream)"
      : "FAIL: inspect private model-events.json; no E2E claim";
    report.upstream = "NOT TESTED: Grok model unavailable in current model catalog; actual Grok Build used Gemini test upstream";
    // Still exercise channel operations if the upstream failed, without claiming
    // a scripted operation was performed by the model.
    if (!JSON.stringify(modified).includes(context.marker + "-edited")) {
      const read = await operation("workspace.read", { path: "verification.txt" });
      await operation("workspace.patch", { path: "verification.txt", expected_sha256: JSON.parse(read.stdout).sha256, before: context.marker, after: context.marker + "-edited" });
    }
    const test = await operation("workspace.exec", { program: "powershell.exe", argv: ["-NoProfile", "-NonInteractive", "-File", "check.ps1"], cwd: "." });
    assert.ok(JSON.stringify(test).includes("TEST_PASS")); assert.ok(JSON.stringify(test).includes("Win32NT"));
    report.windows = "PASS: real Windows test stdout and authorized cwd verified";
    await request("/fixture/pause", {}, true);
    await assert.rejects(() => call(socketPath, { operation: "workspace.read", args: { path: "README.md" } }));
    report.pause = "PASS: new CLI read refused";
    await request("/fixture/resume", {}, true);
    await request("/fixture/revoke", {}, true);
    await assert.rejects(() => call(socketPath, { operation: "workspace.read", args: { path: "README.md" } }));
    report.revoke = "PASS: new CLI read refused";
    fs.writeFileSync(path.join(base, "results.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    process.stdin.destroy();
  } finally {
    try { execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }); } catch {}
    try { execFileSync("docker", ["rm", "-f", name + "-isolation"], { stdio: "ignore" }); } catch {}
    await bridge.close();
    for (const waiter of pending.values()) clearTimeout(waiter.timer);
    pending.clear();
    fs.rmSync(path.join(base, "model.env"), { force: true });
  }
})().catch(error => { console.error(error.code === "ERR_ASSERTION" ? error.stack : (error.code || error.message)); process.exitCode = 1; process.stdin.destroy(); });
