"use strict";

const { DevelopmentWorkflow } = require("../development-workflow");

function createDevelopmentRoutes({ chatFor, sendJson, readJsonBody }) {
function workflowMessage(job) {
  if (job.status === "failed") return job.error || "交付失败";
  if (job.status === "cancelled") return "交付已取消，代码修改仍保留在工作区";
  if (job.status === "succeeded") return "部署已完成，服务健康检查通过";
  return ({ queued: "任务已排队", testing: "正在运行测试", staging: "正在检查提交范围",
    awaiting_commit_confirmation: "测试通过；请确认提交并推送",
    committing: "正在创建提交", pushing: "正在推送产品分支",
    awaiting_deploy_confirmation: "已推送；部署需另行确认",
    restart_queued: "已确认部署，等待延迟重启", restarting: "服务正在重启",
    health_check: "正在检查服务健康" })[job.stage] || "正在处理交付";
}

function recordDevelopmentWorkflow({ job }) {
  if (!job?.conversationId || !job?.messageId || !job?.userId) return;
  const principal = job.userId === "legacy"
    ? { legacy: true, userId: "legacy", admin: true }
    : { userId: job.userId, admin: true };
  const service = chatFor(principal);
  const conversation = service.readConversation(job.conversationId);
  const assistant = conversation?.messages?.find((message) =>
    message.id === job.messageId && message.role === "assistant");
  if (!assistant) return;
  service.upsertStream(assistant, `development-${job.id}`, {
    kind: "development_workflow", jobId: job.id, label: workflowMessage(job),
    status: job.status, stage: job.stage, message: workflowMessage(job),
    sha: job.sha || null, branch: job.branch,
    ...(job.error ? { error: job.error, failureReason: job.error } : {}),
  });
  const lastTest = job.testResults?.at(-1);
  const event = job.events?.at(-1);
  const command = event?.detail?.command;
  if (command) {
    const exitCode = event.detail.exitCode;
    const status = Number.isInteger(exitCode)
      ? (exitCode === 0 ? "completed" : "failed") : "running";
    service.upsertStream(assistant,
      `development-command-${job.id}-${job.stage}-${job.testResults?.length || 0}`, {
        kind: "command", label: command, status,
        ...(Number.isInteger(exitCode) ? { exitCode } : {}),
        ...(status === "failed" ? { failureReason: `退出码 ${exitCode}` } : {}),
        details: { ...event.detail, cwd: "/opt/witt" },
      });
  }
  if (job.stage === "testing" && Number.isInteger(event?.detail?.exitCode) && lastTest) {
    service.upsertStream(assistant, `development-test-${job.id}-${job.testResults.length}`, {
      kind: "command", label: `${lastTest.command} ${lastTest.args.join(" ")}`,
      status: lastTest.code === 0 ? "completed" : "failed",
      exitCode: lastTest.code,
      ...(lastTest.code !== 0 ? { failureReason: `测试退出码 ${lastTest.code}` } : {}),
      details: { command: `${lastTest.command} ${lastTest.args.join(" ")}`,
        cwd: "/opt/witt", exitCode: lastTest.code,
        output: [lastTest.stdout, lastTest.stderr].filter(Boolean).join("\n").slice(-8192),
        ...(lastTest.code !== 0 ? { error: `测试退出码 ${lastTest.code}` } : {}) },
    });
  }
  conversation.updatedAt = new Date().toISOString();
  service.writeConversation(conversation);
}

const developmentWorkflow = new DevelopmentWorkflow({
  repoDir: "/opt/witt", jobDir: "/opt/witt/.git/witt-development-jobs",
  onEvent: recordDevelopmentWorkflow,
});

function handleDevelopmentWorkflow(req, res, url, principal, service) {
  const match = url.pathname.match(
    /^\/chat\/conversations\/([a-f0-9-]{36})\/messages\/([a-f0-9-]{36})\/development$/);
  if (!match) return false;
  if (req.method !== "POST") { sendJson(res, 405, { error: "请求方式不支持" }); return true; }
  if (!principal.admin) { sendJson(res, 403, { error: "仅管理员可交付代码" }); return true; }
  const conversation = service.readConversation(match[1]);
  const assistant = conversation?.messages?.find((message) => message.id === match[2]);
  const latestAssistant = conversation?.messages?.filter((message) => message.role === "assistant").at(-1);
  const fileEntry = assistant?.stream?.find((entry) => entry.id === "turn-git-changes");
  const changes = fileEntry?.details?.changes;
  if (!conversation || conversation.archived || conversation.workDir !== "/opt/witt" ||
      !["grok-build", "codex"].includes(conversation.harnessId) ||
      conversation.busy || service.active?.conversationId === conversation.id ||
      assistant?.role !== "assistant" || assistant.status !== "completed" ||
      latestAssistant?.id !== assistant.id || fileEntry?.kind !== "file" ||
      fileEntry.status !== "completed" || fileEntry.branch !== "platform/personal-ai-ops" ||
      fileEntry.details?.omitted || fileEntry.details?.baselineDirty ||
      fileEntry.details?.baselineUnavailable || fileEntry.details?.branchChanged ||
      !Array.isArray(changes) || !changes.length) {
    sendJson(res, 409, { error: "本轮变更尚未完成核对，或不能从当前对话交付" });
    return true;
  }
  const existing = assistant.stream.findLast((entry) => entry.kind === "development_workflow");
  if (existing && !["failed", "cancelled"].includes(existing.status)) {
    sendJson(res, 409, { error: "本轮交付已开始或已完成" });
    return true;
  }
  readJsonBody(req, 8 * 1024, (error, body) => {
    if (error) { sendJson(res, 400, { error: error.message }); return; }
    developmentWorkflow.submit({
      userId: principal.legacy ? "legacy" : principal.userId,
      conversationId: conversation.id, messageId: assistant.id, changes,
    }).then((job) => sendJson(res, 202, { conversationId: conversation.id,
      messageId: assistant.id, jobId: job.id, status: job.status, stage: job.stage,
      message: workflowMessage(job), job: { id: job.id, status: job.status,
        stage: job.stage, message: workflowMessage(job) } }))
      .catch((submitError) => sendJson(res, 409, { error: submitError.message }));
  });
  return true;
}

function handleDevelopmentWorkflowAction(req, res, url, principal) {
  const match = url.pathname.match(
    /^\/chat\/development\/([a-f0-9-]{36})\/(cancel|resume-push|commit|deploy)$/);
  if (!match) return false;
  if (req.method !== "POST") { sendJson(res, 405, { error: "请求方式不支持" }); return true; }
  if (!principal.admin) { sendJson(res, 403, { error: "仅管理员可管理交付任务" }); return true; }
  const job = developmentWorkflow.query(match[1]);
  const userId = principal.legacy ? "legacy" : principal.userId;
  if (!job || job.userId !== userId) {
    sendJson(res, 404, { error: "交付任务不存在" });
    return true;
  }
  const respond = (action) => action.then((updated) => sendJson(res, 200, { job: {
    id: updated.id, conversationId: updated.conversationId, messageId: updated.messageId,
    status: updated.status, stage: updated.stage, sha: updated.sha,
    message: workflowMessage(updated),
  } })).catch((error) => sendJson(res, 409, { error: error.message }));
  if (match[2] === "commit") {
    readJsonBody(req, 8 * 1024, (error, body) => {
      if (error) { sendJson(res, 400, { error: error.message }); return; }
      const commitMessage = String(body?.commitMessage || "").trim();
      if (!commitMessage || commitMessage.length > 240) {
        sendJson(res, 400, { error: "请提供不超过 240 字的提交说明" });
        return;
      }
      respond(developmentWorkflow.confirmCommit(job.id, commitMessage));
    });
  } else {
    respond(match[2] === "cancel" ? developmentWorkflow.cancel(job.id)
      : match[2] === "deploy" ? developmentWorkflow.deploy(job.id)
        : developmentWorkflow.resumePush(job.id));
  }
  return true;
}

return { handleDevelopmentWorkflow, handleDevelopmentWorkflowAction, developmentWorkflow };
}

module.exports = { createDevelopmentRoutes };
