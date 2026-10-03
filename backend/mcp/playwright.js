"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

if (process.env.WITT_BROWSER_MCP_ENABLED !== "1") {
  process.stderr.write("PLAYWRIGHT_MCP_NOT_AUTHORIZED\n");
  process.exit(1);
}

const cli = path.join(path.dirname(require.resolve("@playwright/mcp")), "cli.js");
const child = spawn(process.execPath, [
  cli,
  "--headless",
  "--isolated",
  "--browser", "chromium",
  "--caps", "devtools",
  "--console-level", "error",
  "--image-responses", "omit",
  "--block-service-workers",
  "--no-sandbox",
  "--viewport-size", "1440x900",
], { stdio: "inherit", env: process.env });

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.once("error", (error) => {
  process.stderr.write(`PLAYWRIGHT_MCP_START_FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = Number.isInteger(code) ? code : (signal ? 1 : 0);
});
