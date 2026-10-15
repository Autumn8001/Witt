"use strict";

function createAssistRoutes({ sessions, chatFor, readJsonBody, sendJson }) {
  const json = (req) => new Promise((resolve, reject) => readJsonBody(req, 8192, (e, b) => e ? reject(e) : resolve(b || {})));
  const bearer = req => String(req.headers.authorization || "").replace(/^Bearer /, "");
  const handle = (req, res, work) => {
    res.setHeader("Cache-Control", "no-store");
    Promise.resolve().then(work).then(body => sendJson(res, 200, body)).catch(e =>
      sendJson(res, /RATE_LIMIT|SESSION_LIMIT/.test(e.code) ? 429 : /NOT_FOUND/.test(e.code) ? 404 : 403, { error: e.code || "ASSIST_REQUEST_FAILED" }));
    return true;
  };
  function handleCustomer(req, res, url) {
    if (!url.pathname.startsWith("/assist/")) return false;
    // These endpoints accept no browser cookies and permit no cross-origin API.
    if (req.headers.origin || req.headers.cookie) { sendJson(res, 403, {error:"NATIVE_CLIENT_REQUIRED"}); return true; }
    return handle(req, res, async () => {
      if (req.method === "POST" && url.pathname === "/assist/preview") return sessions.preview((await json(req)).code, req.socket.remoteAddress);
      if (req.method === "POST" && url.pathname === "/assist/authorize") return sessions.authorize(await json(req));
      const s = sessions.customer(bearer(req));
      if (req.method === "POST" && url.pathname === "/assist/state") return sessions.transition(s, (await json(req)).state);
      if (req.method === "GET" && url.pathname === "/assist/status") return { session: sessions.public(s), audit: sessions.audit(s) };
      throw Object.assign(new Error(), {code:"INVALID_ROUTE"});
    });
  }
  function handleOperator(req, res, url, principal) {
    if (!url.pathname.startsWith("/remote-assist/")) return false;
    if (!principal?.admin || !principal.userId) { sendJson(res, 403, {error:"admin_required"}); return true; }
    return handle(req, res, async () => {
      if (url.pathname === "/remote-assist/sessions") {
        if (req.method === "POST") return sessions.create(principal, await json(req));
        if (req.method === "GET") { sessions.sweep(); return {sessions:[...sessions.sessions.values()].filter(s => s.operator_id === principal.userId).map(s => sessions.public(s))}; }
      }
      const m = url.pathname.match(/^\/remote-assist\/sessions\/([a-f0-9-]{36})\/(workspace|revoke|audit)$/);
      if (m) {
        const s = sessions.owned(m[1], principal);
        if (req.method === "POST" && m[2] === "workspace") return sessions.bindWorkspace(s, chatFor(principal), await json(req));
        if (req.method === "POST" && m[2] === "revoke") return sessions.transition(s, "revoked");
        if (req.method === "GET" && m[2] === "audit") return {audit:sessions.audit(s)};
      }
      throw Object.assign(new Error(), {code:"INVALID_ROUTE"});
    });
  }
  return { handleCustomer, handleOperator };
}
module.exports = { createAssistRoutes };
