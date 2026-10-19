"use strict";

const { WebSocketServer } = require("ws");
const { decodeMessage, validateDeviceRegistration, MAX_MESSAGE_BYTES } = require("./protocol");
const { DeviceRegistry } = require("./device-registry");
const { CommandDispatcher } = require("./command-dispatcher");

class DeviceGateway {
  constructor(options = {}) {
    this.registry = options.registry || new DeviceRegistry({
      file: options.configFile || process.env.WITT_DEVICE_CONFIG || "/root/.witt/devices.json",
    });
    this.now = options.now || Date.now;
    this.onDisconnect = options.onDisconnect || (() => {});
    this.canConnect = options.canConnect || (() => true);
    this.dispatcher = options.dispatcher || new CommandDispatcher(this.registry, { now: this.now });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
    this.sweepTimer = setInterval(() => this.sweep(), 20000);
    this.sweepTimer.unref?.();
  }

  attach(server) {
    server.on("upgrade", (req, socket, head) => {
      let pathname;
      try { pathname = new URL(req.url, "http://localhost").pathname; }
      catch { socket.destroy(); return; }
      if (pathname !== "/device/ws") { socket.destroy(); return; }
      const deviceId = req.headers["x-witt-device-id"];
      const authorization = String(req.headers.authorization || "");
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!this.registry.authenticate(deviceId, token) || !this.canConnect(deviceId)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.connected(deviceId, ws));
    });
    return this;
  }

  connected(deviceId, ws) {
    const session = {
      deviceId, ws, registered: false, lastSeen: this.now(),
      hostname: null, agentVersion: null,
    };
    const registerTimer = setTimeout(() => {
      if (!session.registered) ws.close(1008, "register_required");
    }, 10000);
    registerTimer.unref?.();

    ws.on("message", (data, binary) => {
      if (binary) { ws.close(1003, "json_only"); return; }
      let message;
      try { message = decodeMessage(data); }
      catch { ws.close(1008, "invalid_message"); return; }
      if (message.type === "register") {
        let registration;
        try { registration = validateDeviceRegistration(message); } catch {
          ws.close(1008, "invalid_register"); return;
        }
        if (session.registered || message.device_id !== deviceId) {
          ws.close(1008, "invalid_register"); return;
        }
        session.registered = true;
        session.hostname = message.hostname;
        session.agentVersion = message.agent_version;
        const negotiated = this.registry.negotiate(deviceId, registration.capabilities, registration.roots);
        session.capabilities = negotiated.capabilities;
        session.roots = negotiated.roots;
        session.lastSeen = this.now();
        clearTimeout(registerTimer);
        const previous = this.registry.replace(deviceId, session);
        if (previous && previous !== session) {
          this.dispatcher.disconnect(previous);
          previous.ws.close(4001, "replaced");
        }
        ws.send(JSON.stringify({ v: 1, type: "registered", device_id: deviceId,
          capabilities: session.capabilities, roots: session.roots }));
        return;
      }
      if (!session.registered || this.registry.session(deviceId) !== session) {
        ws.close(1008, "register_required"); return;
      }
      if (message.type === "heartbeat") {
        session.lastSeen = this.now();
        ws.send(JSON.stringify({ v: 1, type: "heartbeat_ack", id: message.id || "" }));
      } else if (message.type === "result" && typeof message.id === "string" &&
          message.device_id === deviceId) {
        session.lastSeen = this.now();
        this.dispatcher.result(session, message);
      } else {
        ws.close(1008, "unsupported_message");
      }
    });
    ws.on("close", () => {
      clearTimeout(registerTimer);
      this.dispatcher.disconnect(session);
      if (this.registry.remove(deviceId, session)) this.onDisconnect(deviceId);
    });
    ws.on("error", () => {});
  }

  sweep() {
    const now = this.now();
    for (const session of this.registry.sessions.values()) {
      if (now - session.lastSeen > 60000) {
        this.dispatcher.disconnect(session);
        session.ws.close(4000, "heartbeat_timeout");
        this.registry.remove(session.deviceId, session);
      }
    }
  }

  close() {
    clearInterval(this.sweepTimer);
    for (const session of this.registry.sessions.values()) {
      this.dispatcher.disconnect(session);
      session.ws.close(1001, "server_shutdown");
    }
    for (const ws of this.wss.clients) ws.close(1001, "server_shutdown");
    this.wss.close();
  }
}

module.exports = { DeviceGateway };
