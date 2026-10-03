# 朋友 Witt 全权限开发交接

状态：当前权威交接文档  
日期：2026-10-02  
产品分支：`platform/personal-ai-ops`  
起始基线：`f0fa739`
取代：[FRIEND-SERVER-HANDOFF.md](FRIEND-SERVER-HANDOFF.md)

## 1. 目标与授权

朋友已有一套稳定的 Witt 和充足模型额度。该 Witt 作为开发控制台，完整负责 Witt-Autumn 的后续开发：

```text
手机 -> 朋友的 Witt
          `-- 通过临时 root SSH 密钥连接我们的服务器
                |-- 在 /opt/witt 直接修改、测试、commit、push
                |-- 读取现有运行配置并安装/验证 Harness
                |-- 调用本机 CPA、Sub2API、Open WebUI
                `-- 部署、重启并验证域名和线上服务
```

服务器所有者已确认：本阶段优先保证开发不中断，朋友 Witt 可以获得以下临时全权限：

- GitHub 仓库 `Autumn8001/Witt` 的读写权限；
- 我们服务器的临时 root SSH 登录权限；
- 在我们服务器安装软件、Harness，修改服务配置和部署应用的权限；
- 使用服务器已有 CPA、Sub2API 等本地配置完成测试的权限。

授权不等于把秘密写进提示词。临时 SSH 私钥安装在朋友 Witt 实际运行的 Unix 用户环境中；GitHub 凭据安装在我们的生产服务器 root 环境中。两者都不能提交到仓库或回显到聊天。

## 2. 不变的项目边界

- 最终生产服务器、域名、HTTPS、CPA、Sub2API、Open WebUI 均保持在我们的服务器。
- 朋友的域名和朋友现有 Witt 不迁移、不改造；它只是开发入口。
- GitHub 的 `platform/personal-ai-ops` 是产品开发分支。
- `main` 保持上游基线，除非所有者以后明确要求，否则不修改、不合并、不强推。
- 正式部署目录是我们服务器的 `/opt/witt`。
- 正式服务是 `witt.service`，监听 `127.0.0.1:3003`。
- 正式入口是 `https://cpa.stellarbit.site/vault/`。
- 生产环境文件和数据继续留在我们的服务器，不需要复制到朋友服务器。

## 3. 已验证的生产状态

截至本文件日期：

| 项目 | 当前事实 |
| --- | --- |
| 产品分支 | `platform/personal-ai-ops` |
| 起始提交 | `f0fa739` |
| 服务器代码目录 | `/opt/witt` |
| 服务 | `witt.service`，active + enabled |
| 后端 | `127.0.0.1:3003`，`/health` 返回 200 |
| 公网 | `/vault/` 页面与 `/vault-api/health` 返回 200 |
| 当前可用 Harness | Grok Build，默认 `grok-4.7-high` |
| Codex | CLI 0.160.0 已安装；缺少本机认证，真实回合暂停 |
| Gemini/Antigravity | 适配代码存在，当前服务器 CPU 不兼容官方二进制 |
| CPA | 本机 `127.0.0.1:8317` |
| 环境文件 | `/root/.witt/app.env`、`/root/.witt/cpa.env`，权限 `0600` |
| GitHub 写入 | 仅绑定 `Autumn8001/Witt` 的可写 Deploy Key；个人 `gh` 未登录 |

代码和部署依据：

- `backend/runtime/`
- `backend/chat-service.js`
- `deploy/witt-personal-mvp.service`
- `deploy/witt-live-nginx-locations.conf`
- `docs/MILESTONE-1-INTEGRATION.md`
- `docs/KNOWN-ISSUES.md`

## 4. 一次性权限准备

### 4.1 确认朋友 Witt 的执行用户

所有凭据必须安装给真正执行 AI 命令的 Unix 用户。接管者先执行并记录：

```bash
id
pwd
systemctl show <朋友的Witt服务名> -p User -p Group -p WorkingDirectory
```

后续用 `<agent-user>` 表示该用户。不要把凭据装到另一个用户的 HOME，避免出现“终端能用、Witt 不能用”。

### 4.2 在朋友服务器创建临时生产 root 密钥

由 `<agent-user>` 创建一把全新的密钥：

```bash
install -d -m 700 ~/.ssh
ssh-keygen -t ed25519 -f ~/.ssh/witt_autumn_temp_root -C "witt-autumn-temp-root-20261002"
chmod 600 ~/.ssh/witt_autumn_temp_root
cat ~/.ssh/witt_autumn_temp_root.pub
```

只把最后输出的公钥交给服务器所有者。私钥留在朋友服务器，绝不发送到聊天或 GitHub。

服务器所有者把该公钥作为单独一行加入我们服务器：

```text
/root/.ssh/authorized_keys
```

本阶段不设置命令白名单或 sudo 限制，该 key 可以完整登录 root。添加后，接管者配置 SSH 别名：

```sshconfig
Host witt-autumn-prod
    HostName <我们的服务器地址>
    Port <我们的SSH端口>
    User root
    IdentityFile ~/.ssh/witt_autumn_temp_root
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

首次保存主机指纹后验证：

```bash
ssh witt-autumn-prod 'id && hostname && test -d /opt/witt && echo READY'
```

期望看到 `uid=0(root)` 和 `READY`。

### 4.3 验证生产服务器 root 登录

公钥已经安装后，朋友 Witt 直接验证：

```bash
ssh witt-autumn-prod 'id && cd /opt/witt && git status --short --branch && git log -1 --oneline'
```

看到 `uid=0(root)`、产品分支和当前提交即表示接管成功。朋友服务器不克隆项目，也不安装 `gh` 或 Grok；它只保留开发控制台和临时 SSH 私钥。

### 4.4 配置生产服务器的单仓库 GitHub 权限

生产服务器只使用绑定 `Autumn8001/Witt` 的 Deploy Key：

```bash
ssh witt-autumn-prod 'cd /opt/witt && git remote -v && git fetch origin'
ssh witt-autumn-prod 'cd /opt/witt && git push --dry-run origin HEAD:refs/heads/platform/personal-ai-ops'
```

`origin` 必须使用 SSH 别名 `github-witt-autumn`，对应私钥 `/root/.ssh/witt_github_deploy_ed25519`。不得执行 `gh auth login`，不得把 `origin` 改回个人 HTTPS 凭据。该 Deploy Key 可以读写目标仓库，但 GitHub 会拒绝它写入其他仓库。

## 5. 密钥和服务配置规则

朋友 Witt 已获得 root，因此技术上可以读取生产密钥。执行时遵守以下规则即可，不增加权限障碍：

- 允许使用 `/root/.witt/app.env`、`/root/.witt/cpa.env` 启动和测试服务；
- 允许查看环境变量名、文件权限、值是否存在以及值长度；
- 不在聊天、commit、测试报告或命令输出中打印密钥值；
- 不把生产 `.env`、认证数据库、邀请码、恢复密码复制到朋友服务器；
- 不提交 `.env`、私钥、Token、cookie、会话数据库或服务备份；
- 如果工具意外打印秘密，立即停止传播，并报告需要轮换哪个凭据。

所有代码开发和真实 CPA/Sub2API/Harness 联调都通过 SSH 在我们的服务器执行，使用服务器现有代码和配置。

## 6. 日常开发流程

### 6.1 直接在我们的服务器开发

每个任务按以下顺序完成：

1. 通过 `ssh witt-autumn-prod` 登录并进入 `/opt/witt`；
2. `git fetch origin`，确认产品分支基线；
3. 直接在 `/opt/witt` 修改代码；
4. 运行与修改相关的测试、语法检查和 `git diff --check`；
5. 展示 `git status`、Diff 摘要和关键 Diff；
6. commit 到 `platform/personal-ai-ops` 或短期功能分支；
7. push GitHub并报告 commit SHA。

不得覆盖不属于本任务的既有修改。不得使用 `git reset --hard`、强制推送或改写产品分支历史。

### 6.2 做真实集成

代码和服务本来就在同一台生产服务器。需要 CPA、Sub2API、Nginx、systemd、真实 Harness 或线上数据时，直接在当前 SSH 会话执行：

```bash
cd /opt/witt
git status --short --branch
```

允许朋友 Witt：

- 安装或升级 Harness；
- 修改 `/root/.witt/app.env` 等运行配置；
- 修改 systemd 和 Nginx 配置；
- 重启服务和容器；
- 执行数据库/数据迁移；
- 运行真实端到端测试。

但每次变更前先记录当前状态和回退点，完成后报告实际变化。目标是可追踪，不是限制权限。

### 6.3 部署

标准部署必须满足：

1. 目标代码已经 commit 并 push；
2. GitHub 和生产服务器目标 SHA 一致；
3. 运行相关自动化测试；
4. 更新 `/opt/witt`；
5. 必要时执行 `systemctl daemon-reload`；
6. 重启 `witt.service`；
7. 检查本机 `/health`、公网 `/vault/` 和 `/vault-api/health`；
8. 检查 CPA、Sub2API、Open WebUI 未被意外破坏；
9. 汇报 SHA、测试、服务状态和未验证项。

如果正在通过 Witt-Autumn 自己执行部署，不要在回复保存前同步杀死承载当前对话的服务。使用延迟重启或独立 systemd 任务完成最后重启。

## 7. Harness 实施原则

当前优先完成用户可见的开发闭环，不重复为每个 Harness 实现公共能力。

Witt 公共层负责：

- 会话和任务持久化；
- 取消、超时和异常恢复；
- 工具、命令、计划和文件变更事件；
- Diff、日志和前端状态。

各 Harness Adapter 只负责：

- 启动和停止对应运行时；
- 创建、恢复和取消会话；
- 发送 Prompt；
- 将原始输出转为统一事件；
- 上报真实能力和错误。

Grok Build 已在生产服务器真实验证。Codex 或 Gemini 只有在对应二进制可运行后才标记可用；不得用假响应绕过运行时问题。

## 8. 第一阶段任务

接管后优先完成以下闭环，不再继续做无关的安全加固或大范围重构：

1. 验证朋友 Witt 能用临时密钥 root 登录我们的服务器；
2. 验证生产服务器的单仓库 Deploy Key；
3. 证明朋友 Witt 能在 `/opt/witt` 修改、commit、push；
4. 让 Grok修改代码后，手机端稳定显示本轮文件列表和 Diff；
5. 用户确认后 commit、push、部署；
6. 重启后原对话仍能继续；
7. 完成一次真实的小改动端到端验收。

## 9. 完成标准

以下全部通过才算交接完成：

- 朋友 Witt 可持续执行 shell、Git 和 SSH 命令；
- 生产服务器能向 `Autumn8001/Witt` push，并能 fetch/pull；
- 朋友 Witt 能以 root 登录生产服务器；
- 能安装 Harness、使用现有 CPA/Sub2API 配置并运行真实测试；
- 能从手机发任务并看到修改与 Diff；
- 用户确认后能自动 commit、push、部署、重启和验收；
- `main` 未变化，产品分支历史未被强推；
- 最终 GitHub 和生产服务器 SHA 一致。

## 10. 临时权限撤销

项目稳定后执行：

1. 从我们服务器 `/root/.ssh/authorized_keys` 删除注释为 `witt-autumn-temp-root-20261002` 的公钥行；
2. 在朋友服务器删除 `~/.ssh/witt_autumn_temp_root` 和 `.pub`；
3. 从 `Autumn8001/Witt` 的 Deploy keys 中删除 `Witt Autumn production only`；
4. 验证旧 SSH key 已无法登录、GitHub 凭据已失效；
5. 如果曾在聊天或日志中暴露任何密钥，轮换相应凭据。

撤销动作只针对本次临时权限，不影响生产服务自身读取 `/root/.witt` 的能力。

## 11. 可直接交给朋友 Witt 的提示词

```text
你现在接管 Witt-Autumn 的完整开发、测试和部署工作。

先完整阅读仓库中的 docs/FRIEND-WITT-FULL-ACCESS-HANDOFF.md，并以它作为当前权威交接文件。旧的 docs/FRIEND-SERVER-HANDOFF.md 已废弃，不要执行其中的域名转发或双服务器 Witt 迁移方案。

授权范围：
- 你可以使用专用临时 SSH key，以 root 登录我们的生产服务器；
- 你可以直接在生产服务器 /opt/witt 修改代码、运行测试、commit、push；
- 你可以安装 Harness、读取并使用现有服务环境、修改配置、部署、重启和验收；
- 你可以使用已经绑定 `Autumn8001/Witt` 的 Deploy Key 执行 Git 操作；
- 权限不是阻碍，遇到缺少工具或配置时直接补齐。

第一步先确认你实际运行的 Unix 用户，然后检查：Git、Node、Grok、SSH、磁盘、项目目录和现有凭据状态。不要输出任何 Token、私钥、CPA key、cookie、邀请码或恢复密码。

如果还没有临时生产 SSH key：
1. 在你实际运行的用户下生成 ~/.ssh/witt_autumn_temp_root；
2. 只把 .pub 公钥输出给我；
3. 暂停等待我把公钥加入生产服务器 root 的 authorized_keys；
4. 不要输出或传输私钥。

公钥安装完成后，不要在当前朋友服务器克隆项目，也不要在当前服务器安装 gh 或 grok。当前服务器只保留 Witt 控制台和临时 SSH 私钥。所有开发都通过 SSH 在生产服务器完成。

先配置 SSH 别名 witt-autumn-prod，然后验证能以 root 登录生产服务器并访问 /opt/witt。

生产服务器已经配置仓库专用 Deploy Key。不要执行 `gh auth login`，也不要请求个人 GitHub 设备授权。先执行 `git remote -v`，确认 `origin` 为 `git@github-witt-autumn:Autumn8001/Witt.git`，再执行 `git fetch origin` 和针对产品分支的 `git push --dry-run`。

生产服务器通过 SSH 别名 witt-autumn-prod 连接，代码目录为 /opt/witt，仓库为 Autumn8001/Witt，产品分支为 platform/personal-ai-ops，服务为 witt.service。不要修改或推送 main，不要强推或改写历史。CPA、Sub2API、Open WebUI、Nginx 和生产数据均保留在生产服务器。

接管完成后优先实现手机开发闭环：
手机下达任务 -> 修改代码 -> 展示本轮文件和 Diff -> 等用户确认 -> commit -> push -> 生产服务器拉取 -> 测试 -> 部署/延迟重启 -> 健康检查 -> 原对话继续。

每个任务结束必须报告：
- 修改文件；
- Diff 摘要；
- 测试命令和结果；
- commit SHA 和 push 状态；
- 是否部署；
- 生产服务和公网健康状态；
- 尚未验证的内容。

现在先验证 root SSH 登录。登录成功后检查生产服务器的 Git、Node、Grok、项目状态和服务状态，并验证单仓库 Deploy Key。不得再次发起 GitHub 设备授权，其他可在授权范围内完成的工作直接推进。
```


## 12. 后续开发实现

手机文件变更、交付状态机和恢复方法见 [PERSONAL-AI-OPS.md](PERSONAL-AI-OPS.md)。
生产连接以当前 SSH 配置的 `witt-autumn-prod` 为准，当前使用本地反向通道。
不得依据旧公网端口示例改变现有连接方式。
