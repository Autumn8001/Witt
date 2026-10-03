"use strict";
function createCpaQuotaRoutes({ service, sendJson }) {
  return (req, res, url, principal) => {
    if (url.pathname !== "/providers/cpa/quotas") return false;
    if (!principal?.admin) { sendJson(res, 403, { error: "admin_required" }); return true; }
    if (req.method !== "GET") { sendJson(res, 405, { error: "method_not_allowed" }); return true; }
    res.setHeader("Cache-Control", "no-store");
    service.read().then((body) => sendJson(res, 200, body))
      .catch(() => sendJson(res, 503, { error: "quota_unavailable" }));
    return true;
  };
}
module.exports = { createCpaQuotaRoutes };
