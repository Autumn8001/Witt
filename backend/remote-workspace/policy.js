"use strict";

const { validateWorkspaceOperation } = require("./validation");

const SAFE = "SAFE";
const CONFIRM = "CONFIRM";
const DENY = "DENY";
const DENIED_PROGRAMS = new Set([
  "cmd", "command", "powershell", "pwsh", "bash", "sh", "zsh", "fish",
  "diskpart", "format", "bcdedit", "reg", "sc", "net", "netsh", "schtasks",
  "takeown", "icacls", "cipher", "vssadmin", "wevtutil", "wmic", "shutdown",
  "restart-computer", "stop-computer", "rm", "rmdir", "del", "erase", "rd",
]);
const CONFIRM_PROGRAMS = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "poetry", "mvn", "gradle", "gradlew", "docker", "kubectl", "winget", "choco", "scoop", "git"]);
const DESTRUCTIVE_GIT = new Set(["reset", "clean"]);

function hasSensitivePath(path) {
  return typeof path === "string" && path.split("/").some((part) =>
    [".git", ".ssh", ".gnupg"].includes(part.toLowerCase()));
}

function classifyWorkspaceOperation(operation, args, options = {}) {
  const valid = validateWorkspaceOperation(operation, args, options);
  if (options.fullAccess === true) return { category: SAFE, reason: "DEVICE_FULL_ACCESS", ...valid };
  const path = valid.args.path || valid.args.cwd || null;
  if (hasSensitivePath(path)) return { category: DENY, reason: "SENSITIVE_PATH", ...valid };
  if (["workspace.list", "workspace.stat", "workspace.read", "workspace.read_image", "workspace.search", "workspace.git_status", "workspace.git_diff", "workspace.system_info"].includes(operation)) {
    return { category: SAFE, reason: "READ_ONLY", ...valid };
  }
  if (["workspace.write", "workspace.patch"].includes(operation)) {
    return { category: SAFE, reason: "BOUNDED_WORKSPACE_EDIT", ...valid };
  }
  // SAFE here means dispatch to the connector; Assist still requires local
  // approval for every command, including read-only diagnostics. Never fullAccess.
  if (operation === "workspace.exec" && options.assistCommands === true) return { category: SAFE, reason: "CLIENT_COMMAND_APPROVAL_REQUIRED", ...valid };
  if (operation === "workspace.exec") return classifyExec(valid);
  return { category: DENY, reason: "UNKNOWN_OPERATION", ...valid };
}

function classifyExec(valid) {
  const program = valid.args.program.toLowerCase();
  const argv = valid.args.argv.map((value) => value.toLowerCase());
  if (DENIED_PROGRAMS.has(program)) return { category: DENY, reason: "DENIED_PROGRAM", ...valid };
  if (argv.some((value) => /(?:^|[\\/])(format|diskpart|bcdedit|powershell|cmd)(?:\.exe)?$/.test(value))) {
    return { category: DENY, reason: "DENIED_ARGUMENT", ...valid };
  }
  if (program === "git" && DESTRUCTIVE_GIT.has(argv[0])) return { category: DENY, reason: "DESTRUCTIVE_GIT", ...valid };
  if (program === "git" && ["commit", "push", "fetch", "pull", "clone", "submodule", "config", "remote"].includes(argv[0])) {
    return { category: CONFIRM, reason: "GIT_EXTERNAL_OR_COMMIT", ...valid };
  }
  if (program === "git" && ["status", "diff", "log", "show", "rev-parse", "branch"].includes(argv[0])) {
    return { category: SAFE, reason: "GIT_INSPECTION", ...valid };
  }
  if (CONFIRM_PROGRAMS.has(program) && /^(?:test|install|add|update|upgrade|remove|uninstall|publish|deploy|start|stop|restart|run|exec)$/i.test(argv[0] || "")) {
    if (["npm", "pnpm", "yarn", "bun", "mvn", "gradle", "gradlew"].includes(program) &&
        ((argv[0] === "test") || (argv[0] === "run" && argv[1] === "test"))) {
      return { category: SAFE, reason: "PROJECT_TEST", ...valid };
    }
    return { category: CONFIRM, reason: "DEPENDENCY_OR_SERVICE_CHANGE", ...valid };
  }
  if (program === "node" && (["--version", "-v", "--test"].includes(argv[0]) || (argv[0] === "--test"))) {
    return { category: SAFE, reason: "DEVELOPMENT_TEST_OR_VERSION", ...valid };
  }
  if (["python", "python3"].includes(program) && (["--version", "-v"].includes(argv[0]) ||
      (argv[0] === "-m" && ["pytest", "unittest"].includes(argv[1])))) {
    return { category: SAFE, reason: "DEVELOPMENT_TEST_OR_VERSION", ...valid };
  }
  if (program === "java" && ["-version", "--version"].includes(argv[0])) {
    return { category: SAFE, reason: "DEVELOPMENT_TEST_OR_VERSION", ...valid };
  }
  if (program === "go" && ["version", "test", "vet", "build"].includes(argv[0]) && !argv.includes("-w")) {
    return { category: SAFE, reason: "DEVELOPMENT_TEST_OR_VERSION", ...valid };
  }
  if (program === "dotnet" && ["--info", "--version", "test", "build"].includes(argv[0])) {
    return { category: SAFE, reason: "DEVELOPMENT_TEST_OR_VERSION", ...valid };
  }
  return { category: CONFIRM, reason: "UNCLASSIFIED_EXEC", ...valid };
}

module.exports = { SAFE, CONFIRM, DENY, classifyWorkspaceOperation };
