"use strict";

const { validDeviceId, isPlainObject } = require("../remote-device/protocol");

function createDeviceRoutes({ gateway, sendJson, authorized }) {
  const local = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
  const internal = (req) => local(req) && !req.headers["x-forwarded-for"] &&
    !req.headers["x-real-ip"] && !req.headers["x-forwarded-proto"] && authorized(req);
  const describe = (id) => validDeviceId(id) ? gateway.registry.describe(id) : null;

  function body(req, limit = 16 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      let done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        error ? reject(error) : resolve(value);
      };
      req.on("data", (chunk) => {
        if (done) return;
        size += chunk.length;
        if (size > limit) {
          finish(Object.assign(new Error("request_too_large"), { code: "REQUEST_TOO_LARGE" }));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (done) return;
        if (size === 0) { finish(null, {}); return; }
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          finish(null, value);
        } catch {
          finish(Object.assign(new Error("invalid_json"), { code: "INVALID_ARGUMENTS" }));
        }
      });
      req.on("error", () => finish(Object.assign(new Error("request_error"), { code: "REQUEST_ERROR" })));
    });
  }

  function statusFor(error) {
    if (["INVALID_ARGUMENTS", "COMMAND_NOT_ALLOWED", "INVALID_TIMEOUT"].includes(error.code)) return 400;
    if (["CAPABILITY_NOT_ALLOWED", "ROOT_NOT_ALLOWED"].includes(error.code)) return 403;
    if (error.code === "COMMAND_TIMEOUT") return 504;
    if (error.code === "DEVICE_BUSY") return 409;
    if (["DEVICE_OFFLINE", "DEVICE_DISCONNECTED"].includes(error.code)) return 503;
    if (["INVALID_ATTACHMENT", "ATTACHMENT_TOO_LARGE"].includes(error.code)) return 502;
    if (error.code === "REQUEST_TOO_LARGE") return 413;
    return 500;
  }

  function command(res, id, tool, args) {
    if (!validDeviceId(id) || !gateway.registry.describe(id)) {
      sendJson(res, 404, { error: "device_not_found" }); return;
    }
    Promise.resolve().then(() => gateway.dispatcher.dispatch(id, tool, args))
      .then((result) => sendJson(res, 200, { result }))
      .catch((error) => sendJson(res, statusFor(error), { error: error.code || "DEVICE_ERROR" }));
  }

  function hostname(res, id) {
    command(res, id, "system", { command: "hostname" });
  }

  function systemInfo(res, id) {
    command(res, id, "system", { command: "info" });
  }

  function fileCommand(req, res, id, operation) {
    body(req).then((value) => {
      if (!isPlainObject(value)) throw Object.assign(new Error("invalid_arguments"), { code: "INVALID_ARGUMENTS" });
      command(res, id, "filesystem", { operation, root: value.root, path: value.path });
    }).catch((error) => sendJson(res, statusFor(error), { error: error.code || "INVALID_ARGUMENTS" }));
  }

  function screenshot(req, res, id) {
    body(req).then((value) => {
      if (!isPlainObject(value) || Object.keys(value).length !== 0) {
        throw Object.assign(new Error("invalid_arguments"), { code: "INVALID_ARGUMENTS" });
      }
      command(res, id, "screen", { operation: "capture" });
    }).catch((error) => sendJson(res, statusFor(error), { error: error.code || "INVALID_ARGUMENTS" }));
  }

  function handleInternal(req, res, url) {
    if (!url.pathname.startsWith("/internal/devices")) return false;
    if (!internal(req)) { sendJson(res, 403, { error: "internal_access_required" }); return true; }
    if (url.pathname === "/internal/devices" && req.method === "GET") {
      sendJson(res, 200, { devices: gateway.registry.list() }); return true;
    }
    const get = url.pathname.match(/^\/internal\/devices\/([^/]+)$/);
    if (get && req.method === "GET") {
      const device = describe(get[1]);
      sendJson(res, device ? 200 : 404, device ? { device } : { error: "device_not_found" });
      return true;
    }
    const command = url.pathname.match(/^\/internal\/devices\/([^/]+)\/hostname$/);
    if (command && req.method === "POST") { hostname(res, command[1]); return true; }
    const info = url.pathname.match(/^\/internal\/devices\/([^/]+)\/system-info$/);
    if (info && req.method === "POST") { systemInfo(res, info[1]); return true; }
    const list = url.pathname.match(/^\/internal\/devices\/([^/]+)\/files\/list$/);
    if (list && req.method === "POST") { fileCommand(req, res, list[1], "list"); return true; }
    const read = url.pathname.match(/^\/internal\/devices\/([^/]+)\/files\/read$/);
    if (read && req.method === "POST") { fileCommand(req, res, read[1], "read"); return true; }
    const shot = url.pathname.match(/^\/internal\/devices\/([^/]+)\/screenshot$/);
    if (shot && req.method === "POST") { screenshot(req, res, shot[1]); return true; }
    sendJson(res, 405, { error: "method_not_allowed" }); return true;
  }

  function handlePublic(req, res, url, principal) {
    if (url.pathname !== "/customer-devices" && !url.pathname.startsWith("/customer-devices/")) return false;
    if (!principal.admin) { sendJson(res, 403, { error: "admin_required" }); return true; }
    if (url.pathname === "/customer-devices" && req.method === "GET") {
      sendJson(res, 200, { devices: gateway.registry.list() }); return true;
    }
    const command = url.pathname.match(/^\/customer-devices\/([^/]+)\/hostname$/);
    if (command && req.method === "POST") { hostname(res, command[1]); return true; }
    const info = url.pathname.match(/^\/customer-devices\/([^/]+)\/system-info$/);
    if (info && req.method === "POST") { systemInfo(res, info[1]); return true; }
    const list = url.pathname.match(/^\/customer-devices\/([^/]+)\/files\/list$/);
    if (list && req.method === "POST") { fileCommand(req, res, list[1], "list"); return true; }
    const read = url.pathname.match(/^\/customer-devices\/([^/]+)\/files\/read$/);
    if (read && req.method === "POST") { fileCommand(req, res, read[1], "read"); return true; }
    const shot = url.pathname.match(/^\/customer-devices\/([^/]+)\/screenshot$/);
    if (shot && req.method === "POST") { screenshot(req, res, shot[1]); return true; }
    const get = url.pathname.match(/^\/customer-devices\/([^/]+)$/);
    if (get && req.method === "GET") {
      const device = describe(get[1]);
      sendJson(res, device ? 200 : 404, device ? { device } : { error: "device_not_found" });
      return true;
    }
    sendJson(res, 405, { error: "method_not_allowed" }); return true;
  }

  return { handleInternal, handlePublic };
}

module.exports = { createDeviceRoutes };
