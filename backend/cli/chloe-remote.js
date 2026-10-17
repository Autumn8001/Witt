#!/usr/bin/env node
"use strict";

const net = require("node:net");
const MAX_FRAME = 4 * 1024 * 1024;
const HELP = `chloe-remote list [path]
chloe-remote read <path>
chloe-remote search <query>
chloe-remote patch '<JSON: path, expected_sha256, before, after>'
chloe-remote write '<JSON: path, expected_sha256, content>'
chloe-remote exec <program> '<JSON argv array>' [cwd]
chloe-remote status | diff | info
All operations use the single session selected by the operator.
Edits and commands follow the customer's session consent: full-access sessions
need no per-operation approval; restricted sessions retain local confirmations.
Pause, revoke and expiry stop access. Never retry uncertain writes.`;

function parseArgs(argv) {
  const [verb, ...args] = argv;
  if (["list", "read"].includes(verb) && args.length <= 1 && (verb === "list" || args.length === 1)) {
    return { operation: "workspace." + verb, args: { path: args[0] || "." } };
  }
  if (verb === "search" && args.length === 1) return { operation: "workspace.search", args: { query: args[0] } };
  if (["patch", "write"].includes(verb) && args.length === 1) return { operation: "workspace." + verb, args: JSON.parse(args[0]) };
  if (verb === "exec" && args.length >= 2 && args.length <= 3) {
    return { operation: "workspace.exec", args: { program: args[0], argv: JSON.parse(args[1]), cwd: args[2] || "." } };
  }
  const operation = { status: "git_status", diff: "git_diff", info: "system_info" }[verb];
  if (operation && !args.length) return { operation: "workspace." + operation, args: {} };
  throw Error("INVALID_CLI_ARGUMENTS");
}

function call(socketPath, request) {
  return new Promise((resolve, reject) => {
    if (!socketPath) { reject(Error("NO_BOUND_SESSION")); return; }
    const frame = JSON.stringify(request) + "\n";
    if (Buffer.byteLength(frame) > MAX_FRAME) { reject(Error("REQUEST_TOO_LARGE")); return; }
    const socket = net.createConnection(socketPath);
    let data = Buffer.alloc(0), done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true; socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.setTimeout(370_000, () => finish(Error("EXECUTION_STATE_UNKNOWN")));
    socket.on("connect", () => socket.write(frame));
    socket.on("error", () => finish(Error("CONNECTION_LOST_CHECK_BEFORE_RETRY")));
    socket.on("end", () => finish(Error("EXECUTION_STATE_UNKNOWN")));
    socket.on("data", chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length > MAX_FRAME) { finish(Error("RESULT_TOO_LARGE")); return; }
      const end = data.indexOf(10);
      if (end < 0) return;
      try {
        const result = JSON.parse(data.subarray(0, end));
        if (!result.ok) finish(Error(result.error || "REMOTE_OPERATION_FAILED"));
        else finish(null, result.result);
      } catch { finish(Error("INVALID_REMOTE_RESPONSE")); }
    });
  });
}

if (require.main === module) {
  (async () => {
    if (process.argv[2] === "--help") { console.log(HELP); return; }
    const result = await call(process.env.CHLOE_REMOTE_SOCKET, parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result));
    if (typeof result?.exit_code === "number" && result.exit_code !== 0) process.exitCode = 1;
  })().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
}

module.exports = { parseArgs, call, HELP };
