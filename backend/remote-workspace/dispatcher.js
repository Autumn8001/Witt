"use strict";

const { SAFE, CONFIRM, DENY, classifyWorkspaceOperation } = require("./policy");
const { randomUUID } = require("node:crypto");

class WorkspaceDispatchError extends Error { constructor(code) { super(code); this.code = code; } }

const UNCERTAIN_CODES = new Set(["DEVICE_DISCONNECTED", "COMMAND_TIMEOUT", "DEVICE_OFFLINE", "ECONNRESET", "ETIMEDOUT", "EXECUTION_STATE_UNKNOWN"]);
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
    this.deviceOperations = new Map();
    this.maxQueuedOperations = options.maxQueuedOperations ?? 8;
    this.waitTimeoutMs = options.waitTimeoutMs ?? 360_000;
    this.onWait = options.onWait || (() => {});
  }

  async execute(request) {
    if (request.signal?.aborted) throw new WorkspaceDispatchError("OPERATION_CANCELLED");
    const binding = this.workspaceStore.get(request.workspace_id);
    if (!binding || !binding.device_id.startsWith("assist-")) return this.executeNow(request);
    if (binding.state !== "active") throw new WorkspaceDispatchError("WORKSPACE_NOT_ACTIVE");
    // Validate before retaining a bounded copy. Revalidate policy and the live
    // binding again after waiting; a queued operation never reserves consent.
    classifyWorkspaceOperation(request.operation, request.args, {
      fullAccess: this.fullAccessFor(binding.device_id) === true,
      assistCommands: this.assistCommandsFor(binding.device_id) === true,
    });
    const { signal, ...input } = request;
    const snapshot = { ...structuredClone(input), signal };
    let lane = this.deviceOperations.get(binding.device_id);
    if (!lane) {
      lane = { count: 0, tail: Promise.resolve({ uncertain: false }) };
      this.deviceOperations.set(binding.device_id, lane);
    }
    if (lane.count >= this.maxQueuedOperations + 1) throw new WorkspaceDispatchError("DEVICE_QUEUE_FULL");
    const waiting = lane.count > 0, previous = lane.tail, id = randomUUID();
    let release, timer, check, cancel, uncertain = false, resumed = false;
    lane.tail = new Promise(resolve => { release = resolve; });
    lane.count++;
    const notify = state => { try { this.onWait(binding, { id, state }); } catch {} };
    try {
      let prior;
      if (waiting) {
        notify("waiting");
        prior = await Promise.race([previous, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new WorkspaceDispatchError("DEVICE_WAIT_TIMEOUT")), this.waitTimeoutMs);
          cancel = () => reject(new WorkspaceDispatchError("OPERATION_CANCELLED"));
          signal?.addEventListener("abort", cancel, { once: true });
          if (signal?.aborted) cancel();
          check = setInterval(() => {
            if (this.workspaceStore.get(binding.workspace_id)?.state !== "active")
              reject(new WorkspaceDispatchError("WORKSPACE_NOT_ACTIVE"));
          }, 250);
          check.unref?.();
        })]);
      } else prior = await previous;
      clearTimeout(timer);
      clearInterval(check);
      if (prior.uncertain) throw new WorkspaceDispatchError("EXECUTION_STATE_UNKNOWN");
      resumed = true;
      if (waiting) notify("resumed");
      return await this.executeNow(snapshot);
    } catch (error) {
      uncertain = error?.code === "EXECUTION_STATE_UNKNOWN";
      if (waiting && !resumed) notify("cancelled");
      throw error;
    } finally {
      clearTimeout(timer);
      clearInterval(check);
      if (cancel) signal?.removeEventListener("abort", cancel);
      // If a waiting caller times out/cancels, keep its place until the prior
      // operation settles. Never release the device while it is still busy.
      previous.then(prior => {
        release({ uncertain: uncertain || prior.uncertain });
        if (--lane.count === 0 && this.deviceOperations.get(binding.device_id) === lane)
          this.deviceOperations.delete(binding.device_id);
      });
    }
  }

  async executeNow({ workspace_id, operation, args, approval_id, signal }) {
    if (signal?.aborted) throw new WorkspaceDispatchError("OPERATION_CANCELLED");
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
      if (MUTATING_OPERATIONS.has(classified.operation) && result?.error === "EXECUTION_STATE_UNKNOWN")
        throw new WorkspaceDispatchError("EXECUTION_STATE_UNKNOWN");
      const failed = Boolean(result?.error) || (Number.isInteger(result?.exit_code) && result.exit_code !== 0);
      const status = failed ? "failed" : "completed";
      audit(status);
      return { status, result };
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
