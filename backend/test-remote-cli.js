"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), net = require("node:net");
const { parseArgs, call } = require("./cli/chloe-remote");
const { GrokBuildAdapter } = require("./runtime/grok-build-adapter");

test("CLI preserves structured Windows argv without shell interpolation or session selectors", () => {
  assert.deepEqual(parseArgs(["exec", "powershell.exe", '["-NoProfile","-File","check.ps1"]']), {
    operation: "workspace.exec", args: { program: "powershell.exe", argv: ["-NoProfile", "-File", "check.ps1"], cwd: "." },
  });
  assert.throws(() => parseArgs(["read", "README.md", "--device", "other"]));
  assert.throws(() => parseArgs(["--session", "other", "read", "README.md"]));
});

test("CLI never retries after connection drops with an uncertain write", async () => {
  let requests = 0;
  const socketPath = process.platform === "win32" ? "\\\\.\\pipe\\chloe-cli-test-" + process.pid : "/tmp/chloe-cli-test-" + process.pid + ".sock";
  const server = net.createServer(socket => socket.once("data", () => { requests++; socket.end(); }));
  await new Promise(resolve => server.listen(socketPath, resolve));
  try {
    await assert.rejects(() => call(socketPath, parseArgs(["write", '{"path":"x","content":"test","expected_sha256":""}'])), /EXECUTION_STATE_UNKNOWN/);
    assert.equal(requests, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("development Grok CLI mode exposes the actual native Shell id and no MCP credential", () => {
  assert.throws(() => new GrokBuildAdapter({ remoteCli: {} }), /ISOLATED_REMOTE_CLI_REQUIRED/);
  assert.throws(() => new GrokBuildAdapter({ remoteCli: { isolated: true }, remoteWorkspace: {} }));
  const adapter = new GrokBuildAdapter({ remoteCli: { isolated: true, cwd: "/work", socketPath: "/channel/control.sock" } });
  const args = adapter.buildArgs({ prompt: "test" });
  assert.equal(args[args.indexOf("--tools") + 1], "run_terminal_cmd");
  assert.equal(args[args.indexOf("--cwd") + 1], "/work");
  assert.equal(adapter.childEnv().WITT_REMOTE_WORKSPACE_CREDENTIAL_FILE, undefined);
  assert.ok(!args.some(arg => arg.includes("MCPTool")));
  assert.ok(!new GrokBuildAdapter().buildArgs().includes("--tools"));
});
