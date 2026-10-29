"use strict";
const assert = require("node:assert/strict");
const { workspaceOverview } = require("./workspace-overview");
(async () => {
  const first = await workspaceOverview({ workDir: "/data/chloe", admin: true, projects: [] });
  assert.ok(Array.isArray(first.services));
  assert.equal(first.connections.length, 1);
  assert.equal(first.connections[0].id, "open-terminal");
  assert.ok(first.notice.includes("Open WebUI"));
  const other = await workspaceOverview({ workDir: "/tmp", admin: false, projects: [] });
  assert.equal(other.connections.length, 0);
  assert.equal(other.services.length, 0);
  console.log("workspace overview tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
