"use strict";

const { SAFE, CONFIRM, DENY, classifyWorkspaceOperation } = require("./policy");

class WorkspaceDispatchError extends Error { constructor(code) { super(code); this.code = code; } }

const UNCERTAIN_CODES = new Set(["DEVICE_DISCONNECTED", "COMMAND_TIMEOUT", "DEVICE_OFFLINE", "ECONNRESET", "ETIMEDOUT"]);
const MUTATING_OPERATIONS = new Set(["workspace.write", "workspace.patch", "workspace.exec"]);

function operationPath(args) { return args.path || args.cwd || null; }

class WorkspaceDispatcher {
  constructor(options) {
    if (!options?.workspaceStore || !options?.transport || typeof options.transport.dispatch !== "function" ||
        !options?.approvals || !options?.audit) throw new WorkspaceDispatchError("INVALID_DEPENDENCIES");
    this.workspaceStore = options.workspaceStore;
    this.transport = options.transport;
    this.approvals = options.approvals;
    this.audit = options.audit;
    this.now = options.now || (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.assistCommandsFor = options.assistCommandsFor || (() => false);
    this.fullAccessFor = options.fullAccessFor || (() => false);
  }

  async execute({ workspace_id, operation, args, approval_id }) {
    const binding = this.workspaceStore.get(workspace_id);
    if (!binding) throw new WorkspaceDispatchError("WORKSPACE_NOT_FOUND");
    if (binding.state !== "active") throw new WorkspaceDispatchError("WORKSPACE_NOT_ACTIVE");
    const assistCommands = this.assistCommandsFor(binding.device_id) === true;
    const classified = classifyWorkspaceOperation(operation, args, { fullAccess: this.fullAccessFor(binding.device_id) === true, assistCommands });
    const started = this.now();
    const audit = (status) => this.audit.record({ workspace_id: binding.workspace_id, device_id: binding.device_id,
      operation: classified.operation, path: operationPath(classified.args), category: classified.category,
      duration_ms: Math.max(0, this.now() - started), status });
    if (classified.category === DENY) {
      audit("denied");
      throw new WorkspaceDispatchError("OPERATION_DENIED");
    }
    const intent = { operation: classified.operation, args: classified.args };
    if (classified.category === CONFIRM) {
      if (!approval_id) {
        const approval = this.approvals.create(binding.workspace_id, intent);
        audit("approval_required");
        return { status: "approval_required", approval };
      }
      try { this.approvals.consume(approval_id, binding.workspace_id, intent); }
      catch (error) { audit("approval_rejected"); throw error; }
    }
    try {
      const { timeout_ms: executionTimeout, ...deviceArgs } = classified.args;
      const commandArgs = {
        operation: classified.operation,
        ...deviceArgs,
        ...(assistCommands && operation === "workspace.exec" ? { timeout_ms: executionTimeout || 30_000 } : {}),
        ...(classified.operation === "workspace.system_info" ? {} : { root: binding.root_alias }),
      };
      const result = await this.transport.dispatch(binding.device_id, "workspace", commandArgs,
        assistCommands && operation === "workspace.exec" ? (executionTimeout || 30_000) + 60_000 : this.timeoutMs, {
        workspaceSessionId: binding.workspace_id,
        ...(approval_id ? { approval: { id: approval_id, confirmed: true } } : {}),
      });
      audit("completed");
      return { status: "completed", result };
    } catch (error) {
      if (MUTATING_OPERATIONS.has(classified.operation) && UNCERTAIN_CODES.has(error?.code || error?.message)) {
        audit("execution_state_unknown");
        throw new WorkspaceDispatchError("EXECUTION_STATE_UNKNOWN");
      }
      audit("failed");
      throw error;
    }
  }
}

module.exports = { WorkspaceDispatcher, WorkspaceDispatchError, UNCERTAIN_CODES };
