"use strict";

const crypto = require("node:crypto");
const { validDeviceId } = require("../remote-device/protocol");

function plainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function errorStatus(error) {
  const code = error?.code || "";
  if (/^(?:INVALID|UNKNOWN)_/.test(code) || code === "OPERATION_DENIED") return 400;
  if (code === "WORKSPACE_NOT_ACTIVE" || code === "DEVICE_OFFLINE") return 409;
  if (code === "DEVICE_DISCONNECTED") return 503;
  if (code === "COMMAND_TIMEOUT") return 504;
  return 500;
}

function createRemoteWorkspaceRoutes({ gateway, service, chatFor, runtimeProfiles, sendJson, readJsonBody }) {
  const local = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
  const mcpInternal = (req) => local(req) && !req.headers["x-forwarded-for"] && !req.headers["x-real-ip"];
  const requiredCapabilities = [
    "workspace.list", "workspace.stat", "workspace.read", "workspace.search", "workspace.write",
    "workspace.patch", "workspace.exec", "workspace.git_status", "workspace.git_diff", "workspace.system_info",
  ];

  const models = () => [{ id: "grok-4.7-high", name: "Grok Build", harness: "grok-build", reasoning: "high" }, ...(runtimeProfiles?.list?.() || [])]
    .filter((profile) => ["grok-build", "codex", "google-antigravity"].includes(profile.harness))
    .filter((profile, index, all) => all.findIndex((item) => (item.model || item.id) === (profile.model || profile.id)) === index)
    .map((profile) => ({ id: profile.model || profile.id, name: profile.name, harness: profile.harness, reasoning: profile.reasoning }));
  const options = () => gateway.registry.list().map((device) => ({
    customer_id: gateway.registry.definition(device.device_id)?.customerId || device.customer_name || device.device_id,
    device_id: device.device_id, device_label: device.label, status: device.status,
    roots: device.allowed_roots.map((alias) => ({
      root_alias: alias,
      display_path: gateway.registry.definition(device.device_id)?.workspaceRoots?.[alias] || alias,
    })),
    ready: requiredCapabilities.every((capability) => device.capabilities.includes(capability)), models: models(),
  }));

  function handleInternal(req, res, url) {
    if (url.pathname !== "/internal/remote-workspaces/mcp") return false;
    if (req.method !== "POST" || !mcpInternal(req)) { sendJson(res, 403, { error: "internal_access_required" }); return true; }
    const authorization = String(req.headers.authorization || "");
    const secret = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    readJsonBody(req, 600 * 1024, (error, body) => {
      if (error || !plainObject(body)) { sendJson(res, 400, { error: "INVALID_ARGUMENTS" }); return; }
      Promise.resolve().then(() => service.executeMcp(secret, body.operation, body.args))
        .then((result) => sendJson(res, 200, { result }))
        .catch((reason) => sendJson(res, errorStatus(reason), { error: reason?.code || "WORKSPACE_ERROR" }));
    });
    return true;
  }

  function handlePublic(req, res, url, principal) {
    if (url.pathname !== "/remote-workspaces" && !url.pathname.startsWith("/remote-workspaces/")) return false;
    if (!principal.admin) { sendJson(res, 403, { error: "admin_required" }); return true; }
    if (req.method === "GET" && url.pathname === "/remote-workspaces/options") {
      sendJson(res, 200, { devices: options() }); return true;
    }
    if (req.method === "POST" && url.pathname === "/remote-workspaces") {
      readJsonBody(req, 16 * 1024, (error, body) => {
        if (error || !plainObject(body) || !validDeviceId(body.device_id) || typeof body.root_alias !== "string") {
          sendJson(res, 400, { error: "INVALID_ARGUMENTS" }); return;
        }
        const described = gateway.registry.describe(body.device_id);
        const definition = gateway.registry.definition(body.device_id);
        if (!described || !definition || described.status !== "online") { sendJson(res, 409, { error: "DEVICE_OFFLINE" }); return; }
        if (!described.allowed_roots.includes(body.root_alias) || !requiredCapabilities.every((capability) => described.capabilities.includes(capability))) {
          sendJson(res, 409, { error: "WORKSPACE_CAPABILITY_UNAVAILABLE" }); return;
        }
        const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "grok-4.7-high";
        const sessionId = crypto.randomUUID();
        try {
          const chat = chatFor(principal);
          const conversation = chat.createRemoteWorkspaceConversation({
            title: body.title, model, reasoning: body.reasoning, harnessSessionId: sessionId,
          });
          const workspace = service.workspaceStore.create({
            workspace_id: crypto.randomUUID(), conversation_id: conversation.id,
            customer_id: definition.customerId || described.customer_name || described.device_id,
            device_id: described.device_id, root_alias: body.root_alias,
            display_path: definition.workspaceRoots?.[body.root_alias] || body.root_alias,
            harness_id: conversation.harnessId, model_id: conversation.model, harness_session_id: sessionId,
          });
          sendJson(res, 201, { workspace, conversation: chat.publicConversation(conversation) });
        } catch (createError) {
          sendJson(res, 400, { error: createError.code || createError.message || "WORKSPACE_CREATE_FAILED" });
        }
      });
      return true;
    }
    const state = url.pathname.match(/^\/remote-workspaces\/([a-f0-9-]{36})\/(pause|resume|close)$/);
    if (state && req.method === "POST") {
      try {
        const next = state[2] === "pause" ? "paused" : state[2] === "resume" ? "active" : "closed";
        sendJson(res, 200, { workspace: service.workspaceStore.setState(state[1], next) });
      } catch (error) { sendJson(res, 400, { error: error.code || "WORKSPACE_STATE_FAILED" }); }
      return true;
    }
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  return { handleInternal, handlePublic };
}

module.exports = { createRemoteWorkspaceRoutes };
