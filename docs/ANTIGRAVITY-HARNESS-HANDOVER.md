# Witt / Antigravity QEMU 接入交接

状态：2026-10-10 收尾；范围限于现有 VPS 的 Antigravity 接入，不迁移或修改 CPA、Sub2API、OpenWebUI。

## 当前状态与证据边界

Gemini 的前序记录报告了 Witt 单轮真实回复 `Witt Native Harness Verified` 和默认权限模式回复 `Safe Mode Harness Verified`。本次收尾直接检查了线上源码、运行服务、二进制哈希与配置语法；按用户要求，不重复外部模型请求、不执行真实编码任务。

- 运行时：官方 `agy 1.2.14` 经 `/usr/bin/qemu-x86_64 -cpu max` 启动。
- 原版 ELF：`/root/.local/bin/agy.orig-elf`，实测 SHA-256 为 `0d0d3eba22daf29504dd290151c7ed9a4d33b0c6aa0acfc5da27bc3b01d2f029`。
- 当前入口：`/root/.local/bin/agy`；版本化模板为 `scripts/agy-qemu-wrapper.sh`。
- Witt 主进程由 root 运行；入口使用 `setpriv` 降权至 `agytest`，使用 `/home/agytest/.gemini/` 中的人工 OAuth 登录状态。不读取或记录凭据明文。
- 接入代码：`backend/chat-service.js`，模型 `gemini-3.8-flash-high`；其他 Gemini 模型仍维持原有暂停策略，Grok 默认入口不变。
- `runtimeStatus.ready` 仅代表可执行文件存在，不保证授权有效或外部服务可用；实际启动仍执行 `--version` 检查。

## 权限与功能边界

`antigravityAdapter()` 只在会话 `accessMode === "danger-full-access"` 时设置 `skipPermissions`。全局 `harnessOptions.antigravity.skipPermissions` 不再覆盖普通会话。

`read-only` 和 `workspace-write` 不传 `--dangerously-skip-permissions`，但这不等于 Witt 已实现逐项工具审批、文件系统只读沙箱或工作区外访问隔离。实际工具策略由 CLI 决定，尚未实测。需要审批而非交互模式无法完成的操作可能失败；不得自动改为危险模式。

普通用户降权不是沙箱。`agytest` 能读写其系统权限允许的文件，包括自己的登录凭据。现有 UID 1000 与某些容器进程 UID 重合：禁止使用 `pkill -u agytest` 等宽泛清理，只处理已确认属于本次任务的进程。

工作项目应放在 `agytest` 可访问的专用目录；先检查所有权和已有协作需求，再授予最小必要权限。不得递归开放 `/root`，不得使用 `chmod 777`，不得盲目变更现有项目所有权。

复杂工具调用、跨轮与重启后会话恢复、浏览器/录屏子进程和远程工作区执行均未验证，不应作为已完成能力。QEMU 主进程模拟不保证其他原生子程序兼容。

## 生命周期与失败处理

`runAntigravityTurn()` 在结束前收集本地 Git 变更。超时、中断、非成功结果、错误事件与空输出各自失败或中断；已有部分文字不能把失败升级为成功。成功调用 `finishActive(true, text, "")`。

`daily-cloudcode-pa.googleapis.com EOF` 的根因仍未知。没有足够证据认定并发硬限制、Google 主动断流或具体网络节点问题。前序并发成功记录也不支持“并发必然失败”。如含工具操作的任务中途失败，先检查已执行的副作用再决定重试，不自动完整重放。

## 发布与维护

源码必须进入 Git 提交才能持久化：`scripts/deploy-commit.sh` 要求工作区干净，并通过 `git archive <sha>` 生成 release，还校验远端分支 SHA 与待部署提交一致。仅修改工作区或保留宿主 wrapper 不够。

本次仅创建本地/服务器提交，不推送远端。提交可用 `git log -1 --oneline` 查询，并有本地 Git bundle 离站副本。在获准推送、确认远端分支包含接入提交之前，不直接执行下一次 `deploy-commit.sh`。未来部署的提交必须包含本次接入或等效实现。

本次更新现有活动 release 的对应文件，未切换整个发布版本；因此 `/version` 仍可能显示基础发布 SHA，而不是本次补丁提交。以 systemd `ExecStart` 和该活动目录文件哈希确认运行文件。工作区和 release 的 `backend/chat-service.js` 应保持相同哈希。

宿主 wrapper 不属于 Git release 自动安装产物。恢复新服务器时需单独准备官方 QEMU、`agytest`、校验过的原版 ELF、登录状态及 wrapper。模板可用 `install -m 755 scripts/agy-qemu-wrapper.sh /root/.local/bin/agy` 安装，但必须先备份现有入口并确认原版 ELF 已存在。本次没有验证该凭据与运行资产已被现有灾备任务覆盖。

不要直接运行 `agy update` 或官方安装器覆盖 wrapper；升级先下载到独立目录、核对来源和兼容性，再备份并替换 `agy.orig-elf`。不得使用二进制补丁或不可信兼容包。

## 检查与回滚

离线检查（不调用模型、不读取凭据）：

```bash
node --check backend/chat-service.js
node --test backend/test-antigravity-integration.js backend/test-capabilities-harness.js backend/test-runtime-layer.js backend/test-runtime-parsers.js backend/test-chat-history-regressions.js backend/test-chat-isolation.js
bash -n scripts/agy-qemu-wrapper.sh
bash -n /home/agytest/.bashrc
bash -n /home/agytest/.profile
/root/.local/bin/agy --version
curl -fsS --max-time 8 http://127.0.0.1:3003/health
```

收尾前的源文件、活动 release、文档和 wrapper 在 `/var/backups/witt-antigravity-closeout-20261010/` 保留副本。原接入前的 `chat-service.js.bak-before-agy` 也移到该目录，不再留在源码工作区阻碍部署。

如需撤销本次收尾，先读取该目录 `STATE.txt` 确认原活动路径，备份当前状态，然后恢复对应文件并仅重启 `witt.service`。如果已切换新 release，不要套用旧目录命令。撤销 Git 历史使用针对本次提交的 `git revert`，不得 reset hard 或批量清理用户文件。

彻底禁用 Antigravity 时，优先恢复原接入前 ChatService，保留 QEMU wrapper 和原 ELF 作为按需恢复资产；恢复为原生 ELF 在当前 CPU 上会重新 SIGILL，不是可运行的兼容回滚方案。
