"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SOCKET = process.env.WITT_WORKER_SOCKET || "/run/witt/worker.sock";
const FALLBACK_SOCKET = "/root/witt-data/worker.sock";

class WorkerClient {
  /**
   * @param {object} [options]
   * @param {string} [options.socketPath]
   */
  constructor(options = {}) {
    this.explicitSocket = options.socketPath || null;
  }

  get socketPath() {
    if (this.explicitSocket) return this.explicitSocket;
    if (fs.existsSync(DEFAULT_SOCKET)) return DEFAULT_SOCKET;
    if (fs.existsSync(FALLBACK_SOCKET)) return FALLBACK_SOCKET;
    return DEFAULT_SOCKET;
  }

  _request(method, reqPath, body = null, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const socket = this.socketPath;
      const payload = body ? JSON.stringify(body) : null;
      const headers = {
        "Accept": "application/json",
      };
      if (payload) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload);
      }

      const req = http.request({
        socketPath: socket,
        path: reqPath,
        method,
        headers,
        timeout: timeoutMs,
      }, (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => raw += chunk);
        res.on("end", () => {
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch {
            data = { raw };
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, status: res.statusCode, data });
          } else {
            resolve({
              ok: false,
              status: res.statusCode,
              error: data?.error || `HTTP ${res.statusCode}`,
              data,
            });
          }
        });
      });

      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, error: "timeout" });
      });

      req.on("error", (err) => {
        resolve({ ok: false, error: err.message || String(err) });
      });

      if (payload) req.write(payload);
      req.end();
    });
  }

  async isAvailable() {
    try {
      const res = await this._request("GET", "/health", null, 1500);
      return res.ok && res.data?.ok === true;
    } catch {
      return false;
    }
  }

  async startTurn(params) {
    return this._request("POST", "/turns/start", params, 10000);
  }

  async getTurnStatus(conversationId, messageId) {
    const res = await this._request(
      "GET",
      `/turns/${encodeURIComponent(conversationId)}/${encodeURIComponent(messageId)}/status`,
      null,
      3000
    );
    if (!res.ok) return res.status === 404 ? null : { ok: false, unavailable: true, error: res.error };
    return res.data;
  }

  async interruptTurn(conversationId, messageId, reason = "user_interrupt") {
    return this._request(
      "POST",
      `/turns/${encodeURIComponent(conversationId)}/${encodeURIComponent(messageId)}/interrupt`,
      { reason },
      10000
    );
  }

  async resolveApproval(conversationId, messageId, approvalId, decision, choiceId = null) {
    return this._request(
      "POST",
      `/turns/${encodeURIComponent(conversationId)}/${encodeURIComponent(messageId)}/approvals/${encodeURIComponent(approvalId)}`,
      { decision, choiceId },
      5000
    );
  }

  /**
   * Subscribe to SSE events from the Worker for a turn.
   * Returns a function to cancel the subscription.
   */
  subscribeTurnEvents(conversationId, messageId, options = {}) {
    let fromSeq = options.fromSeq !== undefined ? options.fromSeq : 0;
    let cancelled = false;
    let req = null;
    let retryTimer = null;
    let terminal = false;
    const retry = () => {
      if (cancelled || terminal || retryTimer) return;
      retryTimer = setTimeout(() => { retryTimer = null; startStream(); }, 500);
      retryTimer.unref?.();
    };

    const startStream = () => {
      if (cancelled) return;
      const targetPath = `/turns/${encodeURIComponent(conversationId)}/${encodeURIComponent(messageId)}/events?fromSeq=${fromSeq}`;

      req = http.request({
        socketPath: this.socketPath,
        path: targetPath,
        method: "GET",
        headers: {
          "Accept": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          if (options.onError) options.onError(new Error(`Worker SSE returned HTTP ${res.statusCode}`));
          res.resume();
          if (res.statusCode !== 404) retry();
          else if (options.onEnd) options.onEnd();
          return;
        }

        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffer += chunk;
          const lines = buffer.split("\n\n");
          buffer = lines.pop(); // keep last incomplete block

          for (const block of lines) {
            if (!block.trim()) continue;
            let eventType = "message";
            let dataStr = "";
            for (const line of block.split("\n")) {
              if (line.startsWith("event: ")) eventType = line.slice(7).trim();
              else if (line.startsWith("data: ")) dataStr += (dataStr ? "\n" : "") + line.slice(6);
            }
            let payload;
            try { payload = dataStr ? JSON.parse(dataStr) : null; } catch { continue; }
            if (Number.isInteger(payload?.seq)) {
              if (payload.seq < fromSeq) continue;
              fromSeq = payload.seq + 1;
            }
            {
              if (options.onEvent) options.onEvent(eventType, payload);
              if (eventType === "finish" && options.onFinish) {
                terminal = true;
                options.onFinish(payload?.data || payload);
              }
            }
          }
        });

        res.on("end", () => {
          if (!cancelled && options.onEnd) options.onEnd();
          retry();
        });
        res.on("error", (error) => { if (!cancelled && options.onError) options.onError(error); retry(); });
        res.on("close", retry);
      });

      req.on("error", (err) => {
        if (!cancelled && options.onError) options.onError(err);
        retry();
      });

      req.end();
    };

    startStream();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      if (req) {
        try { req.destroy(); } catch {}
      }
    };
  }
}

module.exports = { WorkerClient, DEFAULT_SOCKET, FALLBACK_SOCKET };
