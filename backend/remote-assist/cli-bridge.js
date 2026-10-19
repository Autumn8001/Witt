"use strict";

// One bridge = one server-selected workspace. The caller never receives a
// workspace id, device credential or gateway token. This is NOT a public API.
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { validateWorkspaceOperation } = require("../remote-workspace/validation");
const MAX_FRAME = 4 * 1024 * 1024;

async function createRemoteCliBridge({ socketPath, execute, uid, gid, fullAccessFor = () => false }) {
  if (process.platform !== "linux") throw Error("LINUX_BRIDGE_REQUIRED");
  if (typeof execute !== "function") throw Error("INVALID_EXECUTOR");
  // The parent must be a newly-created, private operator-owned directory.
  // Never unlink an existing socket: it might belong to another live session.
  if (process.platform !== "win32") {
    const parent = fs.lstatSync(path.dirname(socketPath));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022)) {
      throw Error("UNSAFE_SOCKET_DIRECTORY");
    }
    if (fs.existsSync(socketPath)) throw Error("SOCKET_ALREADY_EXISTS");
  }
  const clients = new Set();
  const server = net.createServer(socket => {
    const controller = new AbortController();
    clients.add(socket);
    let data = Buffer.alloc(0), used = false;
    socket.setTimeout(13 * 60_000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("close", () => { clients.delete(socket); controller.abort(); });
    socket.on("data", async chunk => {
      if (used) return;
      data = Buffer.concat([data, chunk]);
      if (data.length > MAX_FRAME) { used = true; socket.destroy(); return; }
      const end = data.indexOf(10);
      if (end < 0) return;
      used = true;
      try {
        const request = JSON.parse(data.subarray(0, end));
        if (!request || Object.keys(request).length !== 2 ||
            !Object.hasOwn(request, "operation") || !Object.hasOwn(request, "args")) {
          throw Error("INVALID_REQUEST");
        }
        // Only the trusted session resolver can grant full access. Request
        // parameters cannot select a device or raise the authorization level.
        const valid = validateWorkspaceOperation(request.operation, request.args, {
          assistCommands: true, fullAccess: fullAccessFor() === true,
        });
        let result = await execute(valid.operation, valid.args, { signal: controller.signal });
        if (result && typeof result.exit_code === "number") {
          if (result.error || (result.exit_code !== 0 && valid.operation !== "workspace.exec")) {
            throw Error(result.error || "REMOTE_OPERATION_FAILED");
          }
          if (valid.operation !== "workspace.exec") result = JSON.parse(result.stdout);
        }
        const frame = JSON.stringify({ ok: true, result }) + "\n";
        if (Buffer.byteLength(frame) > MAX_FRAME) throw Error("RESULT_TOO_LARGE");
        if (!socket.destroyed) socket.end(frame);
      } catch (error) {
        // Only stable codes; errors may otherwise contain credentials or paths.
        const code = String(error.code || error.message || "REMOTE_OPERATION_FAILED");
        const safe = /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : "REMOTE_OPERATION_FAILED";
        if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: safe }) + "\n");
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      try {
        if (process.platform !== "win32") {
          fs.chmodSync(socketPath, 0o600);
          if (uid !== undefined) fs.chownSync(socketPath, uid, gid ?? uid);
        }
        server.removeListener("error", reject);
        resolve();
      } catch (error) { server.close(); reject(error); }
    });
  });
  return {
    socketPath,
    async close() {
      for (const client of clients) client.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = { createRemoteCliBridge };
