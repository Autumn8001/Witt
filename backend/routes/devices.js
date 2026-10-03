"use strict";

const { validDeviceId } = require("../remote-device/protocol");

function createDeviceRoutes({ gateway, sendJson, authorized }) {
  const local = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
  const internal = (req) => local(req) && !req.headers["x-forwarded-for"] &&
    !req.headers["x-real-ip"] && !req.headers["x-forwarded-proto"] && authorized(req);
  const describe = (id) => validDeviceId(id) ? gateway.registry.describe(id) : null;

  function hostname(res, id) {
    if (!validDeviceId(id) || !gateway.registry.describe(id)) {
      sendJson(res, 404, { error: "device_not_found" }); return;
    }
    Promise.resolve().then(() => gateway.dispatcher.dispatch(id, "system", { command: "hostname" }))
      .then((result) => sendJson(res, 200, { result }))
      .catch((error) => sendJson(res,
        error.code === "COMMAND_TIMEOUT" ? 504 : error.code === "DEVICE_BUSY" ? 409 :
        ["DEVICE_OFFLINE", "DEVICE_DISCONNECTED"].includes(error.code) ? 503 : 500,
        { error: error.code || "DEVICE_ERROR" }));
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
