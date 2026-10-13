"use strict";

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { AuthService } = require("./auth-service");
const {
  ChatService, ALLOWED_ACCESS, NON_ADMIN_MODELS, servePublicArtifactPreview, servePublicArtifactSource,
} = require("./chat-service");
const { CodexAccountService } = require("./codex-account-service");
const { CpaQuotaService } = require("./cpa-quota");
const { createCpaQuotaRoutes } = require("./routes/cpa-quota");
const { claimStandby } = require("./failover");
const { ProviderRegistry } = require("./runtime/provider-registry");
const { RuntimeProfileStore } = require("./runtime/runtime-profiles");
const { overview: serverOverview } = require("./runtime/server-center");
const { harnessInventory } = require("./runtime/index");
const { createDevelopmentRoutes } = require("./routes/development");
const { DeviceGateway } = require("./remote-device/device-gateway");
const { createDeviceRoutes } = require("./routes/devices");
const { WorkspaceStore, WorkspaceAuditStore, ApprovalGate, WorkspaceDispatcher } = require("./remote-workspace");
const { RemoteWorkspaceService } = require("./remote-workspace-service");
const { createRemoteWorkspaceRoutes } = require("./routes/remote-workspaces");
const { WorkerClient } = require("./worker-client");

const host = "127.0.0.1";
const port = Number(process.env.DROP_VAULT_PORT || 3003);
const dataDir = process.env.DROP_VAULT_DATA_DIR || "/data/drop-vault/files";
const taskDir = process.env.DROP_VAULT_TASK_DIR || "/data/drop-vault/tasks";
const chatDir = process.env.DROP_VAULT_CHAT_DIR || "/data/drop-vault/chat";
const imageDir = process.env.DROP_VAULT_IMAGE_DIR || "/data/drop-vault/chat-images";
const usersDir = process.env.DROP_VAULT_USERS_DIR || "/data/drop-vault/users";
const authDir = process.env.DROP_VAULT_AUTH_DIR || "/data/drop-vault/auth";
const tokenFile = process.env.DROP_VAULT_TOKEN_FILE || "/home/ubuntu/.config/drop-vault/api-token";
const codexBin = process.env.DROP_VAULT_CODEX_BIN || "/home/ubuntu/.local/bin/codex";
const codexWorkDir = process.env.DROP_VAULT_CODEX_WORKDIR || "/home/ubuntu/Documents/Codex/2026-07-26-xlsb";
const sub2api = process.env.CHLOE_SUB2API_ENABLED === "1" ? {
  baseUrl: process.env.WITT_SUB2API_URL || "http://127.0.0.1:8080/v1",
  routerBaseUrl: process.env.CHLOE_SUB2API_ROUTER_URL || "",
  plusKey: process.env.CHLOE_SUB2API_PLUS_KEY || "",
  freeKey: process.env.CHLOE_SUB2API_FREE_KEY || "",
  codexHomeRoot: process.env.CHLOE_SUB2API_CODEX_HOME || "/root/.witt/codex-sub2api",
} : null;
const codexProfiles = {
  default: {
    id: "default",
    label: "Chloe 默认账号",
    codexHome: "/home/ubuntu/.codex",
    workDir: codexWorkDir,
  },
  xuanyu: {
    id: "xuanyu",
    label: "子账号",
    codexHome: "/home/ubuntu/.codex-xuanyu",
    workDir: "/data/xuanyu-build-console",
  },
  account4: {
    id: "account4",
    label: "账号 4",
    codexHome: "/home/ubuntu/.codex-account-4",
    workDir: "/home/ubuntu",
  },
  account5: {
    id: "account5",
    label: "账号 5",
    codexHome: "/home/ubuntu/.codex-account-5",
    workDir: "/home/ubuntu",
  },
};
const licreBuildDir = "/data/builds";
const licreConsoleDir = "/data/xuanyu-build-console";
const xuanyuPreviewDir = "/data/xuanyu-build-console/repo/build/web";
const maxBytes = 500 * 1024 * 1024;
const maxPromptBytes = 32 * 1024;
const maxTaskOutputBytes = 2 * 1024 * 1024;
const token = fs.readFileSync(tokenFile, "utf8").trim();

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(taskDir, { recursive: true });
fs.mkdirSync(usersDir, { recursive: true, mode: 0o700 });

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  const header = req.headers.authorization || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = Buffer.from(token);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function safeFileName(name) {
  const raw = String(name || "file").replace(/\\/g, "/");
  const base = path.basename(raw).normalize("NFC");
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+|[. ]+$/g, "");
  const fallback = cleaned || "file";
  const extension = path.extname(fallback);
  let stem = extension ? fallback.slice(0, -extension.length) : fallback;
  const budget = Math.max(1, 180 - Buffer.byteLength(extension, "utf8"));
  while (Buffer.byteLength(stem, "utf8") > budget) stem = Array.from(stem).slice(0, -1).join("");
  return (stem || "file") + extension;
}

function parseName(value) {
  try {
    return safeFileName(decodeURIComponent(String(value || "file")));
  } catch {
    return safeFileName(value);
  }
}

function metadataPath(id, directory = dataDir) {
  return path.join(directory, `${id}.json`);
}

function readRecords(directory = dataDir) {
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

function taskPath(id) {
  return path.join(taskDir, `${id}.json`);
}

function writeTask(task) {
  const destination = taskPath(task.id);
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(task)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, destination);
}

function readTask(id) {
  if (!/^[a-f0-9-]{36}$/.test(String(id || ""))) return null;
  try {
    return JSON.parse(fs.readFileSync(taskPath(id), "utf8"));
  } catch {
    return null;
  }
}

function publicTask(task) {
  return {
    id: task.id,
    prompt: task.prompt,
    status: task.status,
    createdAt: task.createdAt,
    startedAt: task.startedAt || null,
    completedAt: task.completedAt || null,
    result: task.result || "",
    error: task.error || "",
  };
}

function readTasks() {
  return fs.readdirSync(taskDir)
    .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(taskDir, name), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function readJsonBody(req, limit, callback) {
  const chunks = [];
  let size = 0;
  let finished = false;
  const fail = (message) => {
    if (finished) return;
    finished = true;
    callback(new Error(message));
  };
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > limit) {
      fail("请求内容过大");
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (finished) return;
    finished = true;
    try {
      callback(null, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      callback(new Error("请求格式不正确"));
    }
  });
  req.on("error", () => fail("请求连接异常"));
}

// Non-Codex harness configuration. Secrets are read from the environment only;
// nothing here is persisted into the repository or sent to a browser.
const harnessOptions = {
  grok: {
    bin: process.env.WITT_GROK_BIN || undefined,
    providerId: "cpa",
    envKey: process.env.WITT_GROK_ENV_KEY || "WITT_CPA_KEY",
    envValue: process.env.WITT_CPA_API_KEY || "",
    permissionMode: process.env.WITT_GROK_PERMISSION_MODE || null,
    reasoningEffort: process.env.WITT_GROK_REASONING || null,
  },
  antigravity: {
    bin: process.env.WITT_AGY_BIN || undefined,
    providerId: "sub2api",
    apiKeyEnv: "GEMINI_API_KEY",
    apiKeyValue: process.env.GEMINI_API_KEY || "",
    baseUrl: process.env.GOOGLE_GEMINI_BASE_URL || "",
  },
};

const providerRegistry = new ProviderRegistry({
  file: process.env.WITT_PROVIDER_REGISTRY || path.join(authDir, "providers.json"),
});
const runtimeProfiles = new RuntimeProfileStore(sub2api ? [
  { id: "codex-plus", name: "Sol · Plus 账号组", harness: "codex", provider: "sub2api", model: "gpt-6.1-sol", reasoning: "high" },
  { id: "codex-free", name: "Luna · Free 账号组", harness: "codex", provider: "sub2api", model: "gpt-6-luna", reasoning: "high" },
  { id: "codex-terra", name: "Terra · Free 账号组", harness: "codex", provider: "sub2api", model: "gpt-5.6-terra", reasoning: "high" },
  { id: "gemini-fast", name: "Gemini", harness: "google-antigravity", provider: "google-antigravity", model: "gemini-3.8-flash-high", reasoning: "medium" },
] : undefined);
const cpaQuotaRoutes = createCpaQuotaRoutes({ service: new CpaQuotaService(), sendJson });

// Seed the registry with the gateways that actually exist on this host. Values
// come from the environment so no endpoint or secret is hardcoded in source.
function seedProviders() {
  const seeds = [
    {
      id: "cpa", name: "CPA", type: "gateway",
      base_url: process.env.WITT_CPA_URL || "http://127.0.0.1:8317/v1",
      protocol: "openai-responses",
      secret_ref: "WITT_CPA_API_KEY",
      model_discovery: `${(process.env.WITT_CPA_URL || "http://127.0.0.1:8317/v1").replace(/\/$/, "")}/models`,
      capabilities: { streaming: true, tools: true, responses: true, messages: true, chat_completions: true },
    },
    {
      id: "sub2api", name: "Sub2API", type: "gateway",
      base_url: process.env.WITT_SUB2API_URL || "http://127.0.0.1:8080/v1",
      protocol: "openai-chat-completions",
      secret_ref: "WITT_SUB2API_API_KEY",
      model_discovery: `${(process.env.WITT_SUB2API_URL || "http://127.0.0.1:8080/v1").replace(/\/$/, "")}/models`,
      capabilities: { streaming: true, tools: true },
    },
  ];
  for (const seed of seeds) {
    if (providerRegistry.get(seed.id)) continue;
    try {
      providerRegistry.upsert(seed, { persist: true });
    } catch (error) {
      console.error(`[providers] seed ${seed.id} failed: ${error.message}`);
    }
  }
}
seedProviders();

// Device transport remains useful for diagnostics, while Remote Workspace is
// the only path that grants a harness access to a customer project.
const deviceGateway = new DeviceGateway();
const remoteWorkspaceDir = process.env.WITT_REMOTE_WORKSPACE_DIR || path.join(authDir, "remote-workspaces");
const remoteWorkspaceStore = new WorkspaceStore(remoteWorkspaceDir);
const remoteWorkspaceAudit = new WorkspaceAuditStore(remoteWorkspaceDir);
const remoteWorkspaceApprovals = new ApprovalGate();
const remoteWorkspaceDispatcher = new WorkspaceDispatcher({
  workspaceStore: remoteWorkspaceStore, transport: deviceGateway.dispatcher,
  approvals: remoteWorkspaceApprovals, audit: remoteWorkspaceAudit,
});
const remoteWorkspaceService = new RemoteWorkspaceService({
  workspaceStore: remoteWorkspaceStore, dispatcher: remoteWorkspaceDispatcher,
  approvals: remoteWorkspaceApprovals, audit: remoteWorkspaceAudit,
  runtimeDir: path.join(remoteWorkspaceDir, "runtime"), apiBase: `http://127.0.0.1:${port}`,
  notifyApproval: (binding, approval) => {
    const services = [chatService, ...userChatServices.values()];
    const chat = services.find((service) => service?.readConversation(binding.conversation_id));
    if (!chat) throw new Error("REMOTE_WORKSPACE_TURN_NOT_ACTIVE");
    chat.requestRemoteWorkspaceApproval(binding, approval);
  },
});

const workerClient = new WorkerClient();

const chatService = new ChatService({
  sub2api,
  chatDir,
  imageDir,
  dataDir,
  codexBin,
  codexWorkDir,
  sendJson,
  readJsonBody,
  codexProfiles,
  harnessOptions: { ...harnessOptions, grok: {
    ...harnessOptions.grok,
    remoteDeviceMcpEnabled: process.env.WITT_REMOTE_DEVICE_MCP_ENABLED === "1",
    remoteDeviceTokenFile: process.env.DROP_VAULT_TOKEN_FILE || "",
    browserMcpEnabled: process.env.WITT_BROWSER_MCP_ENABLED === "1",
  }, antigravity: { ...harnessOptions.antigravity, runAsAdmin: true } },
  remoteWorkspaceService,
  // The owner-facing service is not model-restricted, so harness-served models
  // such as grok-4.7-high stay selectable and can bind to their own harness.
  allowedModels: null,
  workerClient,
});
const authService = new AuthService({ dir: authDir, sendJson, readJsonBody });
const codexAccountService = new CodexAccountService({
  codexBin,
  profiles: codexProfiles,
  sendJson,
});
const userChatServices = new Map();

function userDirectory(userId) {
  if (!/^[a-f0-9-]{36}$/.test(String(userId || ""))) throw new Error("无效用户");
  const directory = path.join(usersDir, userId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function principalFor(req) {
  const principal = authService.authenticate(req.headers.authorization);
  if (principal) return principal;
  const cookies = String(req.headers.cookie || "").split(";");
  const session = cookies.find((item) => item.trim().startsWith("witt_session="));
  if (session) {
    const value = session.trim().slice("witt_session=".length);
    try {
      const browserPrincipal = authService.authenticateToken(decodeURIComponent(value));
      if (browserPrincipal) return browserPrincipal;
    } catch {}
  }
  // The legacy client is accepted only until the owner initializes access.
  if (!authService.initialized() && authorized(req)) {
    return { userId: "legacy", deviceId: "legacy", admin: true, legacy: true, label: "旧版管理员" };
  }
  return null;
}

function browserCookieRequest(req) {
  return !String(req.headers.authorization || "").startsWith("Bearer ") &&
    String(req.headers.cookie || "").split(";")
      .some((item) => item.trim().startsWith("witt_session="));
}

function browserOriginAllowed(req) {
  const protocol = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  return req.headers.origin === `${protocol}://${req.headers.host}`;
}

function chatFor(principal) {
  if (principal.legacy) return chatService;
  if (userChatServices.has(principal.userId)) return userChatServices.get(principal.userId);
  const directory = userDirectory(principal.userId);
  const service = new ChatService({
    sub2api,
    chatDir: path.join(directory, "chat"),
    imageDir: path.join(directory, "chat-images"),
    dataDir: path.join(directory, "files"),
    codexBin,
    codexWorkDir,
    sendJson,
    readJsonBody,
    allowedModels: principal.admin || principal.unrestrictedModels ? null : NON_ADMIN_MODELS,
    allowedAccessModes: principal.admin
      ? [...ALLOWED_ACCESS]
      : ["read-only", "workspace-write"],
    defaultAccessMode: principal.admin ? "danger-full-access" : "workspace-write",
    // New sessions start on the verified production harness (Grok via CPA).
    // Existing sessions keep whatever they already have stored.
    defaultModel: "grok-4.7-high",
    defaultProviderId: "cpa",
    // Invitation status is not a quota measurement. Let the model provider
    // enforce its real limits; the allowlist above still controls model access.
    quotaExhausted: false,
    codexProfiles,
    harnessOptions: { ...harnessOptions, grok: {
      ...harnessOptions.grok,
      remoteDeviceMcpEnabled: principal.admin && process.env.WITT_REMOTE_DEVICE_MCP_ENABLED === "1",
      remoteDeviceTokenFile: principal.admin ? (process.env.DROP_VAULT_TOKEN_FILE || "") : "",
      browserMcpEnabled: principal.admin && process.env.WITT_BROWSER_MCP_ENABLED === "1",
    }, antigravity: { ...harnessOptions.antigravity, runAsAdmin: Boolean(principal.admin) } },
    remoteWorkspaceService,
    workerClient,
    ownerUserId: principal.userId,
    allowedCodexProfiles: principal.admin
      ? Object.keys(codexProfiles)
      : (principal.codexProfiles || ["default"]),
  });
  userChatServices.set(principal.userId, service);
  return service;
}

const { handleDevelopmentWorkflow, handleDevelopmentWorkflowAction, developmentWorkflow } =
  createDevelopmentRoutes({ chatFor, sendJson, readJsonBody });
const deviceRoutes = createDeviceRoutes({ gateway: deviceGateway, sendJson, authorized });
const remoteWorkspaceRoutes = createRemoteWorkspaceRoutes({
  gateway: deviceGateway, service: remoteWorkspaceService, chatFor, sendJson, readJsonBody,
});

function filesFor(principal) {
  return principal.legacy ? dataDir : path.join(userDirectory(principal.userId), "files");
}

let activeTaskId = null;

function extractCodexResult(output) {
  let answer = "";
  for (const line of output.split("\n")) {
    try {
      const event = JSON.parse(line);
      const item = event.item || {};
      if (event.type === "item.completed" && item.type === "agent_message" && item.text) {
        answer = item.text;
      }
    } catch {}
  }
  return answer.trim();
}

function runNextTask() {
  if (activeTaskId) return;
  const task = readTasks().reverse().find((item) => item.status === "queued");
  if (!task) return;

  activeTaskId = task.id;
  task.status = "running";
  task.startedAt = new Date().toISOString();
  task.error = "";
  writeTask(task);

  const context = [
    "你通过 Chloe 应用运行在用户私人服务器上，负责协助用户完成开发任务。",
    `固定工作目录：${codexWorkDir}`,
    `Chloe 文件目录：${dataDir}`,
    "只处理用户这条消息明确要求的任务；保留现有数据和未提交修改。",
    "禁止展示、记录或回传凭据原文。用户明确授权时，允许认证程序使用指定的本地凭据文件完成认证，不将凭据或生成的 Token 输出到聊天及日志。",
    "如果任务需要超出上述项目目录的写入、对外发送消息、删除数据或其他高风险操作，只说明需要用户确认，不要执行。",
    "",
    `用户通过 Chloe 发来的消息：${task.prompt}`,
  ].join("\n");
  const args = [
    "exec",
    "--json",
    "--sandbox", "workspace-write",
    "--cd", codexWorkDir,
    "--skip-git-repo-check",
    context,
  ];
  const child = spawn(codexBin, args, {
    cwd: codexWorkDir,
    env: { ...process.env, HOME: "/home/ubuntu" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const append = (current, chunk) => (current + chunk.toString("utf8")).slice(-maxTaskOutputBytes);
  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 20 * 60 * 1000);

  child.on("error", (error) => {
    clearTimeout(timeout);
    const latest = readTask(task.id) || task;
    latest.status = "failed";
    latest.completedAt = new Date().toISOString();
    latest.error = `无法启动 Codex：${error.message}`;
    writeTask(latest);
    activeTaskId = null;
    setImmediate(runNextTask);
  });
  child.on("close", (code, signal) => {
    clearTimeout(timeout);
    const latest = readTask(task.id) || task;
    const answer = extractCodexResult(stdout);
    latest.completedAt = new Date().toISOString();
    if (code === 0 && answer) {
      latest.status = "completed";
      latest.result = answer;
      latest.error = "";
    } else {
      latest.status = "failed";
      latest.error = signal
        ? "任务运行超时或被服务终止"
        : (stderr.trim().slice(-1200) || "Codex 未返回有效结果");
    }
    writeTask(latest);
    activeTaskId = null;
    setImmediate(runNextTask);
  });
}

function recoverTasks() {
  for (const task of readTasks()) {
    if (task.status !== "running") continue;
    task.status = "queued";
    task.startedAt = null;
    task.error = "服务重启后已自动重新排队";
    writeTask(task);
  }
  runNextTask();
}

function listFiles(res, url, directory = dataDir) {
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 100));
  const records = readRecords(directory);
  const totalBytes = records.reduce((sum, record) => sum + Number(record.size || 0), 0);
  sendJson(res, 200, {
    files: records.slice(0, limit),
    stats: { count: records.length, totalBytes },
  });
}

function upload(req, res, directory = dataDir) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const length = Number(req.headers["content-length"] || 0);
  if (length > maxBytes) {
    sendJson(res, 413, { error: "文件超过 500 MB 限制" });
    req.resume();
    return;
  }

  const originalName = parseName(req.headers["x-file-name"]);
  const mimeType = String(req.headers["x-file-type"] || "application/octet-stream").slice(0, 160);
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const extension = path.extname(originalName).slice(0, 18);
  const storedName = `${id}${extension}`;
  const destination = path.join(directory, storedName);
  const temporary = `${destination}.part`;
  const output = fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  const digest = crypto.createHash("sha256");
  let size = 0;
  let finished = false;

  const fail = (status, message) => {
    if (finished) return;
    finished = true;
    output.destroy();
    fs.rm(temporary, { force: true }, () => sendJson(res, status, { error: message }));
  };

  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > maxBytes) {
      fail(413, "文件超过 500 MB 限制");
      req.destroy();
      return;
    }
    digest.update(chunk);
  });
  req.on("aborted", () => fail(499, "上传已中断"));
  req.on("error", () => fail(400, "上传连接异常"));
  output.on("error", () => fail(500, "服务器无法保存文件"));

  output.on("finish", () => {
    if (finished) return;
    finished = true;
    try {
      fs.renameSync(temporary, destination);
      const record = {
        id,
        originalName,
        storedName,
        size,
        mimeType,
        sha256: digest.digest("hex"),
        uploadedAt: new Date().toISOString(),
      };
      fs.writeFileSync(metadataPath(id, directory), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
      sendJson(res, 201, { file: record });
    } catch {
      fs.rmSync(temporary, { force: true });
      fs.rmSync(destination, { force: true });
      sendJson(res, 500, { error: "服务器无法完成保存" });
    }
  });

  req.pipe(output);
}

function listTasks(res, url) {
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit")) || 20));
  sendJson(res, 200, {
    activeTaskId,
    tasks: readTasks().slice(0, limit).map(publicTask),
  });
}

function createTask(req, res) {
  readJsonBody(req, maxPromptBytes, (error, body) => {
    if (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    const prompt = String(body?.prompt || "").trim();
    if (!prompt) {
      sendJson(res, 400, { error: "请填写要交给 Chloe 的任务" });
      return;
    }
    if (Buffer.byteLength(prompt, "utf8") > maxPromptBytes) {
      sendJson(res, 413, { error: "任务内容过长" });
      return;
    }
    const now = new Date().toISOString();
    const task = {
      id: crypto.randomUUID(),
      prompt,
      status: "queued",
      createdAt: now,
      startedAt: null,
      completedAt: null,
      result: "",
      error: "",
    };
    writeTask(task);
    sendJson(res, 202, { task: publicTask(task) });
    setImmediate(runNextTask);
  });
}

function sendFile(res, file, contentType, downloadName = null, req = null) {
  fs.stat(file, (error, stats) => {
    if (error || !stats.isFile()) {
      sendJson(res, 404, { error: "文件不存在" });
      return;
    }
    const etag = `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
    const lastModified = stats.mtime.toUTCString();
    const headers = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Type": contentType,
      ETag: etag,
      "Last-Modified": lastModified,
      "X-Content-Type-Options": "nosniff",
    };
    if (downloadName) {
      headers["Content-Disposition"] = `attachment; filename="${downloadName}"`;
    }
    let start = 0;
    let end = stats.size - 1;
    let partial = false;
    const requestedRange = req?.headers?.range;
    const ifRange = req?.headers?.["if-range"];
    let rangeAllowed = Boolean(requestedRange);
    if (rangeAllowed && ifRange) {
      const ifRangeDate = Date.parse(ifRange);
      rangeAllowed = ifRange === etag ||
        (Number.isFinite(ifRangeDate) && stats.mtimeMs <= ifRangeDate + 999);
    }
    if (rangeAllowed) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(requestedRange);
      if (!match || (!match[1] && !match[2])) {
        res.writeHead(416, { ...headers, "Content-Range": `bytes */${stats.size}` });
        res.end();
        return;
      }
      if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
          res.writeHead(416, { ...headers, "Content-Range": `bytes */${stats.size}` });
          res.end();
          return;
        }
        start = Math.max(0, stats.size - suffixLength);
      } else {
        start = Number(match[1]);
        if (match[2]) end = Number(match[2]);
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
          start < 0 || start >= stats.size || end < start) {
        res.writeHead(416, { ...headers, "Content-Range": `bytes */${stats.size}` });
        res.end();
        return;
      }
      end = Math.min(end, stats.size - 1);
      partial = true;
      headers["Content-Range"] = `bytes ${start}-${end}/${stats.size}`;
    }
    headers["Content-Length"] = partial ? end - start + 1 : stats.size;
    res.writeHead(partial ? 206 : 200, headers);
    const input = fs.createReadStream(file, partial ? { start, end } : undefined);
    input.on("error", () => res.destroy());
    input.pipe(res);
  });
}

function previewContentType(file) {
  const types = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".webp": "image/webp",
  };
  return types[path.extname(file).toLowerCase()] || "application/octet-stream";
}

function sendXuanyuPreview(res, pathname) {
  let requested;
  try {
    requested = decodeURIComponent(pathname.slice("/xuanyu-preview".length));
  } catch {
    sendJson(res, 400, { error: "预览路径无效" });
    return;
  }
  const relative = requested.replace(/^\/+/, "") || "index.html";
  const file = path.resolve(xuanyuPreviewDir, relative);
  const root = `${xuanyuPreviewDir}${path.sep}`;
  if (!file.startsWith(root)) {
    sendJson(res, 404, { error: "预览资源不存在" });
    return;
  }
  fs.stat(file, (error, stats) => {
    if (!error && stats.isFile()) {
      sendFile(res, file, previewContentType(file));
      return;
    }
    if (!path.extname(relative)) {
      sendFile(res, path.join(xuanyuPreviewDir, "index.html"), "text/html; charset=utf-8");
      return;
    }
    sendJson(res, 404, { error: "预览资源不存在" });
  });
}

function proxyLicreApi(req, res, pathname, search) {
  const upstreamPath = pathname.slice("/licre".length) + search;
  const headers = {};
  for (const name of ["content-type", "content-length", "x-licre-admin"]) {
    if (req.headers[name] !== undefined) headers[name] = req.headers[name];
  }
  const upstream = http.request({
    host: "127.0.0.1",
    port: 3001,
    method: req.method,
    path: upstreamPath,
    headers,
  }, (upstreamResponse) => {
    res.writeHead(upstreamResponse.statusCode || 502, {
      "Cache-Control": "no-store",
      "Content-Type": upstreamResponse.headers["content-type"] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    upstreamResponse.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) sendJson(res, 502, { error: "LiCre 服务暂时不可用" });
    else res.destroy();
  });
  req.pipe(upstream);
}

function handleLicre(req, res, url) {
  if (!url.pathname.startsWith("/licre/")) return false;
  if (url.pathname.startsWith("/licre/api/") || url.pathname === "/licre/health") {
    proxyLicreApi(req, res, url.pathname, url.search);
    return true;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "不支持此请求方法" });
    return true;
  }
  if (url.pathname === "/licre/licre-update.json") {
    sendFile(res, path.join(licreConsoleDir, "licre-update.json"), "application/json; charset=utf-8", null, req);
    return true;
  }
  if (url.pathname === "/licre/LiCre.apk") {
    sendFile(res, path.join(licreBuildDir, "LiCre.apk"), "application/vnd.android.package-archive", "LiCre.apk", req);
    return true;
  }
  if (url.pathname === "/licre/Xuanyu-app-release.apk") {
    sendFile(res, path.join(licreBuildDir, "Xuanyu-app-release.apk"), "application/vnd.android.package-archive", "Xuanyu-app-release.apk", req);
    return true;
  }
  const release = url.pathname.match(/^\/licre\/releases\/([0-9a-f]{40})\/app-release\.apk$/);
  if (release) {
    sendFile(
      res,
      path.join(licreBuildDir, "releases", release[1], "app-release.apk"),
      "application/vnd.android.package-archive",
      "app-release.apk",
      req,
    );
    return true;
  }
  sendJson(res, 404, { error: "LiCre 资源不存在" });
  return true;
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);
  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/version") {
    sendJson(res, 200, { backendSha: process.env.WITT_DEPLOY_SHA || null });
    return;
  }
  if (url.pathname === "/xuanyu-preview") {
    res.writeHead(302, { Location: "/vault-api/xuanyu-preview/" });
    res.end();
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/xuanyu-preview/")) {
    sendXuanyuPreview(res, url.pathname);
    return;
  }
  if (handleLicre(req, res, url)) return;
  const publicPreviewMatch = url.pathname.match(/^\/chat\/artifact-previews\/([A-Za-z0-9_-]{32,128})$/);
  if (req.method === "GET" && publicPreviewMatch) {
    if (servePublicArtifactPreview(res, publicPreviewMatch[1])) return;
    sendJson(res, 404, { error: "交互预览已失效，请刷新对话后重试" });
    return;
  }
  const publicSourceMatch = url.pathname.match(/^\/chat\/artifact-sources\/([A-Za-z0-9_-]{32,128})$/);
  if (req.method === "GET" && publicSourceMatch) {
    if (servePublicArtifactSource(res, publicSourceMatch[1])) return;
    sendJson(res, 404, { error: "Artifact 源码已失效，请刷新对话后重试" });
    return;
  }
  const compatiblePreviewMatch = url.pathname.match(
    /^\/chat\/conversations\/([a-f0-9-]{36})\/messages\/([a-f0-9-]{36})\/artifacts\/([a-f0-9-]{36})\/preview$/);
  if (req.method === "GET" && compatiblePreviewMatch) {
    const services = [chatService, ...userChatServices.values()];
    if (services.some((service) => service.previewArtifactByIds(
      res, compatiblePreviewMatch[1], compatiblePreviewMatch[2], compatiblePreviewMatch[3]))) return;
    sendJson(res, 404, { error: "交互预览不存在或已失效" });
    return;
  }
  if (remoteWorkspaceRoutes.handleInternal(req, res, url)) return;
  if (deviceRoutes.handleInternal(req, res, url)) return;
  const legacyAuthorized = authorized(req);
  const imageRequest = /^\/chat-images\/[a-f0-9-]{36}$/.test(url.pathname);
  let principal = principalFor(req);
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      url.pathname !== "/auth/activate" && browserCookieRequest(req) &&
      !browserOriginAllowed(req)) {
    sendJson(res, 403, { error: "请求来源无效，请刷新页面后重试" });
    return;
  }
  if (authService.handle(req, res, url, principal, legacyAuthorized)) return;
  if (!principal) {
    sendJson(res, 401, { error: "未授权" });
    return;
  }
  if (cpaQuotaRoutes(req, res, url, principal)) return;
  if (remoteWorkspaceRoutes.handlePublic(req, res, url, principal)) return;
  if (deviceRoutes.handlePublic(req, res, url, principal)) return;
  if (url.pathname === "/failover/claim") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "请求方式不支持" });
      return;
    }
    claimStandby().then(({ status, body }) => sendJson(res, status, body));
    return;
  }
  if (url.pathname === "/runtime/profiles" && req.method === "GET") {
    sendJson(res, 200, { profiles: runtimeProfiles.list() });
    return;
  }
  if (url.pathname === "/providers" && req.method === "GET") {
    sendJson(res, 200, { providers: providerRegistry.list() });
    return;
  }
  if (url.pathname === "/providers" && req.method === "POST") {
    if (!principal.admin) {
      sendJson(res, 403, { error: "仅管理员可配置 Provider" });
      return;
    }
    readJsonBody(req, 16 * 1024, (error, body) => {
      if (error) { sendJson(res, 400, { error: error.message }); return; }
      try {
        sendJson(res, 201, { provider: providerRegistry.upsert(body || {}) });
      } catch (providerError) {
        sendJson(res, 400, { error: providerError.message });
      }
    });
    return;
  }
  const providerCheck = url.pathname.match(/^\/providers\/([a-z0-9-]+)\/check$/);
  if (providerCheck && req.method === "POST") {
    if (!principal.admin) {
      sendJson(res, 403, { error: "仅管理员可检查 Provider" });
      return;
    }
    providerRegistry.check(providerCheck[1])
      .then((provider) => sendJson(res, 200, { provider }))
      .catch((error) => sendJson(res, 404, { error: error.message }));
    return;
  }
  if (url.pathname === "/servers/overview" && req.method === "GET") {
    serverOverview({ env: process.env }).then((overview) => sendJson(res, 200, overview))
      .catch((error) => sendJson(res, 500, { error: error.message }));
    return;
  }
  if (url.pathname === "/runtime/harnesses" && req.method === "GET") {
    sendJson(res, 200, {
      harnesses: harnessInventory(),
      profiles: runtimeProfiles.list(),
      openWebuiConfigured: Boolean(process.env.OPEN_WEBUI_URL),
      browserMcpEnabled: process.env.WITT_BROWSER_MCP_ENABLED === "1",
      remoteDeviceMcpEnabled: process.env.WITT_REMOTE_DEVICE_MCP_ENABLED === "1",
    });
    return;
  }
  if (url.pathname === "/servers/open-webui" && req.method === "GET") {
    const openWebuiUrl = process.env.OPEN_WEBUI_URL || "";
    if (!openWebuiUrl) {
      sendJson(res, 404, { error: "OPEN_WEBUI_URL is not configured" });
      return;
    }
    sendJson(res, 200, { url: openWebuiUrl, tls: openWebuiUrl.startsWith("https://") });
    return;
  }
  if (url.pathname === "/codex/accounts") {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "请求方式不支持" });
      return;
    }
    codexAccountService.list(res, principal.admin ? null : (principal.codexProfiles || ["default"]));
    return;
  }
  const codexLoginMatch = url.pathname.match(
    /^\/codex\/accounts\/([a-z0-9-]+)\/login\/(start|status|cancel)$/);
  if (codexLoginMatch) {
    if (!principal.admin) {
      sendJson(res, 403, { error: "仅管理员可管理 Codex 账号" });
      return;
    }
    const [, profileId, action] = codexLoginMatch;
    if (action === "start" && req.method === "POST") {
      codexAccountService.startLogin(res, profileId);
      return;
    }
    if (action === "status" && req.method === "GET") {
      codexAccountService.loginStatus(res, profileId);
      return;
    }
    if (action === "cancel" && req.method === "POST") {
      codexAccountService.cancelLogin(res, profileId);
      return;
    }
    sendJson(res, 405, { error: "请求方式不支持" });
    return;
  }
  const userChat = chatFor(principal);
  if (req.method === "POST" && url.pathname === "/usage/reset") {
    url.pathname = "/chat/usage/reset";
  }
  if (handleDevelopmentWorkflowAction(req, res, url, principal)) return;
  if (handleDevelopmentWorkflow(req, res, url, principal, userChat)) return;
  if (imageRequest && userChat.handlePublicImage(req, res, url)) return;
  if (userChat.handle(req, res, url, principal)) return;
  if (req.method === "GET" && url.pathname === "/files") {
    listFiles(res, url, filesFor(principal));
    return;
  }
  if (req.method === "POST" && url.pathname === "/files") {
    upload(req, res, filesFor(principal));
    return;
  }
  if (!principal.legacy && url.pathname.startsWith("/tasks")) {
    sendJson(res, 404, { error: "接口不存在" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/tasks") {
    listTasks(res, url);
    return;
  }
  if (req.method === "POST" && url.pathname === "/tasks") {
    createTask(req, res);
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/tasks/")) {
    const task = readTask(url.pathname.slice("/tasks/".length));
    if (!task) {
      sendJson(res, 404, { error: "任务不存在" });
      return;
    }
    sendJson(res, 200, { task: publicTask(task) });
    return;
  }
  sendJson(res, 404, { error: "接口不存在" });
});
deviceGateway.attach(httpServer);
httpServer.listen(port, host, () => {
  console.log(`Witt API listening on http://${host}:${port}`);
  recoverTasks();
  if (port === 3003 && path.resolve(codexWorkDir) === "/opt/witt") {
    developmentWorkflow.recover().catch((error) =>
      console.error(`[development] recovery failed: ${String(error.message || error).slice(0, 160)}`));
  }
});
