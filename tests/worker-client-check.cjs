"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { WorkerClient } = require("../backend/worker-client");

const event = (type, seq, data = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, seq, data })}\n\n`;

test("SSE reconnect resumes from the next sequence, drops replay duplicates, and finishes once", async (t) => {
  const name = `witt-worker-client-${process.pid}-${crypto.randomUUID()}`;
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
  const requests = [];
  let finishCalls = 0;
  const observed = [];
  let complete;
  const completed = new Promise((resolve) => { complete = resolve; });
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url });
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    if (requests.length === 1) {
      res.write(event("text_delta", 0, { text: "A" }));
      res.write(event("activity", 1, { label: "working" }));
      // Simulate a network drop after the client has consumed seq 0 and 1.
      setImmediate(() => res.destroy());
      return;
    }
    if (requests.length === 2) {
      // Replay the last delivered event as SSE servers commonly do after reconnect.
      res.write(event("activity", 1, { label: "working" }));
      res.write(event("text_delta", 2, { text: "B" }));
      const finish = event("finish", 3, { status: "completed", text: "done" });
      res.write(finish);
      res.write(finish);
      res.end();
      return;
    }
    res.end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    stop();
    await new Promise((resolve) => server.close(resolve));
  });

  const client = new WorkerClient({ socketPath });
  const stop = client.subscribeTurnEvents(
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    {
      fromSeq: 0,
      onEvent(type, payload) { observed.push({ type, seq: payload.seq }); },
      onFinish(result) {
        finishCalls += 1;
        complete(result);
      },
    },
  );

  let timeout;
  const result = await Promise.race([
    completed,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Worker SSE did not reconnect")), 3000);
    }),
  ]);
  clearTimeout(timeout);
  // Let the duplicated finish block, if incorrectly delivered, pass through parsing.
  await new Promise((resolve) => setTimeout(resolve, 20));
  stop();

  assert.equal(result.status, "completed");
  assert.equal(finishCalls, 1, "a replayed finish event must not complete the turn twice");
  assert.deepEqual(observed.map((item) => item.seq), [0, 1, 2, 3]);
  assert.ok(requests.length >= 2, "the SSE client should reconnect after the socket closes");
  assert.match(requests[0].url, /fromSeq=0(?:&|$)/);
  assert.match(requests[1].url, /fromSeq=2(?:&|$)/,
    "the reconnect cursor must start after the last accepted sequence");
});
