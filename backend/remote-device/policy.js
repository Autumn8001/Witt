"use strict";

function checkCommand(tool, args) {
  if (tool === "system" && args && typeof args === "object" &&
      args.command === "hostname" && Object.keys(args).every((key) => key === "command")) {
    return { risk: "safe", tool: "system", args: { command: "hostname" } };
  }
  const error = new Error("command_not_allowed");
  error.code = "COMMAND_NOT_ALLOWED";
  throw error;
}

module.exports = { checkCommand };
