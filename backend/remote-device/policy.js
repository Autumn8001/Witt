"use strict";

const { isPlainObject, validRootAlias, validateRelativePath } = require("./protocol");

function exactKeys(args, keys) {
  return isPlainObject(args) && Object.keys(args).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(args, key));
}

function checkCommand(tool, args) {
  if (tool === "system" && exactKeys(args, ["command"]) &&
      (args.command === "hostname" || args.command === "info")) {
    return {
      risk: "safe", capability: `system.${args.command}`, tool: "system",
      args: { command: args.command },
    };
  }
  if (tool === "filesystem") {
    if (!exactKeys(args, ["operation", "root", "path"]) ||
        (args.operation !== "list" && args.operation !== "read") || !validRootAlias(args.root)) {
      const error = new Error("invalid_arguments");
      error.code = "INVALID_ARGUMENTS";
      throw error;
    }
    try {
      validateRelativePath(args.path);
    } catch {
      const error = new Error("invalid_path");
      error.code = "INVALID_ARGUMENTS";
      throw error;
    }
    return {
      risk: "safe", capability: `filesystem.${args.operation}`, tool: "filesystem",
      args: { operation: args.operation, root: args.root, path: args.path || "." },
    };
  }
  if (tool === "screen") {
    if (!exactKeys(args, ["operation"]) || args.operation !== "capture") {
      const error = new Error("invalid_arguments");
      error.code = "INVALID_ARGUMENTS";
      throw error;
    }
    return {
      risk: "safe", capability: "screen.capture", tool: "screen",
      args: { operation: "capture" },
    };
  }
  const error = new Error("command_not_allowed");
  error.code = "COMMAND_NOT_ALLOWED";
  throw error;
}

module.exports = { checkCommand };
