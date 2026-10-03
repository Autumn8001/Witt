# Witt 双服务器开发交接手册（已废弃）

> 本文基于“朋友服务器承载开发版 Witt”的错误前提，已被
> [FRIEND-WITT-FULL-ACCESS-HANDOFF.md](FRIEND-WITT-FULL-ACCESS-HANDOFF.md)
> 取代。朋友现有的稳定 Witt 才是开发控制台；Witt-Autumn 最终仍部署在我们的服务器。
> 不要再按本文执行端口转发或 Nginx 上游切换。

状态：可执行草案  
日期：2026-10-02  
代码基线：`platform/personal-ai-ops` / `1f923fd9a54ac4b500fc115b7a14c63b975f4c09`  
适用范围：朋友服务器承担开发；原服务器继续拥有域名、HTTPS、CPA、Open WebUI、Sub2API 和生产部署

## 1. 先选择接管模式

| 模式 | 手机原域名实际连接 | 适用情况 | 推荐顺序 |
| --- | --- | --- | --- |
| A：开发机 | 原服务器 Witt | 其他 AI 通过 SSH 登录朋友服务器开发；手机仍管理生产 | 先完成 |
| B：远程主机接管 | 朋友服务器 Witt | 手机打开原域名后，要让 Grok直接修改朋友服务器代码 | A 验收后再切换 |

> 默认先完成模式 A：“朋友服务器开发、GitHub 传递代码、原服务器生产部署”。如果目标是从手机里的 Witt 直接开发朋友服务器，则继续完成模式 B。域名、TLS 和 CPA 始终留在原服务器。

模式 A 能同时满足：

- 开发工作发生在朋友服务器；
- `https://cpa.stellarbit.site/vault/` 继续指向原服务器；
- CPA/xAI 的底层登录材料不离开原服务器；
- 朋友服务器仍可运行 Grok Build 和开发版 Witt；
- 开发结果通过 GitHub 的 `platform/personal-ai-ops` 分支交付，再由原服务器部署。

本手册不包含任何真实 API Key、GitHub Token、SSH 私钥、邀请码或恢复密码。秘密通过独立的加密通道交付，禁止写入 Git。

## 2. 两台服务器的职责

| 组件 | 原服务器（生产） | 朋友服务器（开发） |
| --- | --- | --- |
| 域名与 TLS | 权威入口，保持不变 | 不接管生产域名 |
| Nginx `/vault/`、`/vault-api/` | 继续提供生产页面和 API | 默认不对公网开放 |
| CPA 与 xAI 登录材料 | 保留，CPA 当前仅监听 `127.0.0.1:8317` | 通过 SSH 隧道访问，不复制 CPA 账户库 |
| Open WebUI、Sub2API | 保留 | 非开发必需，不复制 |
| 生产 Witt 与数据 | 保留 `/opt/witt`、`/root/witt-data` | 使用独立代码目录和独立测试数据 |
| Grok Build | 已安装、已验证 | 需要单独安装并配置 |
| GitHub | 生产服务器最终拉取/部署 | 日常修改、commit、push |
| 认证、聊天记录、邀请码 | 生产数据，只留原服务器 | 新建开发数据，不复制生产用户 |

推荐数据流：

```text
手机/正式用户
    -> cpa.stellarbit.site (原服务器 Nginx)
    -> 原服务器 Witt

朋友服务器上的 AI/Grok
    -> /opt/witt-dev 工作区
    -> GitHub platform/personal-ai-ops
    -> 原服务器拉取并部署

朋友服务器 Grok 的模型请求
    -> 朋友服务器 127.0.0.1:18317
    -> SSH 本地端口转发
    -> 原服务器 127.0.0.1:8317 (CPA)
    -> xAI
```

## 3. 已验证的当前事实

- 生产 Witt 使用 systemd 单元 `witt.service`，工作目录为 `/opt/witt`。
- 生产后端监听 `127.0.0.1:3003`，Nginx 将 `/vault-api/` 代理到该端口。
- 公网页面由原服务器的 `/opt/witt/web/` 提供。
- CPA 监听 `127.0.0.1:8317`，没有直接暴露给朋友服务器。
- Grok 配置中的 provider 当前指向 `http://127.0.0.1:8317/v1`，协议为 `responses`。
- Witt 通过 `WITT_CPA_API_KEY` 获得 CPA 调用密钥，并把它以 Grok 配置声明的环境变量名注入 Grok 子进程。
- 生产环境文件是 `/root/.witt/app.env` 和 `/root/.witt/cpa.env`，权限均为 `0600`。
- 当前产品分支是 `platform/personal-ai-ops`；`main` 不是产品开发分支。

代码依据：

- `deploy/witt-personal-mvp.service`
- `deploy/witt-live-nginx-locations.conf`
- `backend/server.js`
- `backend/runtime/grok-build-adapter.js`
- `backend/runtime/provider-registry.js`

## 4. 密钥和配置迁移边界

### 4.1 朋友服务器需要的内容

| 内容 | 交付方式 | 说明 |
| --- | --- | --- |
| GitHub 仓库 | `git clone` | 检出 `platform/personal-ai-ops` |
| GitHub 权限 | 在朋友服务器执行 `gh auth login` | 不复制原服务器的 GitHub Token |
| Grok Build | 官方安装方式 | 安装后验证版本和最小模型请求 |
| CPA 调用密钥 | 独立加密传输，写入 root-only 环境文件 | 只交付调用 CPA 所需值，不复制 CPA/xAI 账户库 |
| 到原服务器的隧道私钥 | 新建的专用密钥 | 只允许连接 CPA 的转发端口，不使用个人日常 SSH 私钥 |
| Grok provider 配置 | 新建配置 | `base_url` 指向朋友服务器的隧道端口 `18317` |
| 开发版 Witt 数据目录 | 在朋友服务器新建 | 与生产认证、聊天和文件完全隔离 |

### 4.2 禁止复制到朋友服务器

- 原服务器 SSH 私钥和 SSH host key；
- `/root/witt-data` 生产数据；
- 生产邀请码、恢复密码和 API token 文件；
- CPA 的 xAI 登录数据库、刷新令牌和备份目录；
- TLS 私钥和证书；
- 原服务器完整的 `/root/.witt/` 目录；
- Grok 的历史 session 数据库；
- Docker 数据卷和数据库目录。

复制整个 `/root/.witt` 或 `/root/.grok` 看起来省事，但会把无关凭据、历史会话和主机专属路径一起带走。应在朋友服务器重新生成配置，只填明确需要的字段。

## 5. 推荐实施步骤：朋友服务器只做开发

以下命令中的 `<...>` 都是占位符，不能原样执行。

### 阶段 A：准备代码和工具

1. 安装 Git、Node.js、GitHub CLI 和 Grok Build。
2. 克隆并检出产品分支：

```bash
git clone https://github.com/Autumn8001/Witt.git /opt/witt-dev
cd /opt/witt-dev
git switch platform/personal-ai-ops
git status --short --branch
```

3. 在朋友服务器单独登录 GitHub：

```bash
gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git
gh auth status
gh repo view Autumn8001/Witt
```

设备授权出现后，由仓库所有者在自己的手机上确认。不要把 GitHub Token 粘贴进聊天记录。

完成条件：朋友服务器能 fetch 产品分支，并拥有向该分支或新功能分支 push 的权限。

### 阶段 B：建立 CPA 专用隧道

在朋友服务器生成一把只用于隧道的密钥：

```bash
ssh-keygen -t ed25519 -f /root/.ssh/witt_cpa_tunnel -C witt-cpa-tunnel
```

把公钥交给原服务器管理员。原服务器应为它配置独立受限账号或等价限制，只允许转发到 `127.0.0.1:8317`。OpenSSH 可在该账号的 `authorized_keys` 中用 `permitopen="127.0.0.1:8317"` 限制转发目标。不要把原服务器的管理员私钥复制到朋友服务器。

朋友服务器上的目标连接是：

```bash
ssh -NT \
  -L 127.0.0.1:18317:127.0.0.1:8317 \
  -i /root/.ssh/witt_cpa_tunnel \
  -p <原服务器SSH端口> \
  <隧道账号>@<原服务器地址>
```

正式运行时应将该命令放入朋友服务器自己的 systemd 单元，使用 `Restart=always` 和 SSH keepalive；不要依赖一个临时终端窗口。

验证隧道只检查状态，不输出密钥：

```bash
ss -ltn | grep '127.0.0.1:18317'
curl -fsS http://127.0.0.1:18317/healthz
```

完成条件：朋友服务器的 `127.0.0.1:18317` 可访问原服务器 CPA，而 CPA 的 `8317` 仍未向公网监听。

### 阶段 C：建立朋友服务器的最小环境文件

建议使用 `/root/.witt-dev/app.env`，权限 `0600`。示例：

```dotenv
# 示例，不含真实秘密
WITT_CPA_API_KEY=<通过独立安全通道提供>
WITT_CPA_URL=http://127.0.0.1:18317/v1
WITT_GROK_BIN=/root/.local/bin/grok
WITT_RUNTIME_LOG=1

DROP_VAULT_PORT=33003
DROP_VAULT_DATA_DIR=/var/lib/witt-dev/files
DROP_VAULT_TASK_DIR=/var/lib/witt-dev/tasks
DROP_VAULT_CHAT_DIR=/var/lib/witt-dev/chat
DROP_VAULT_IMAGE_DIR=/var/lib/witt-dev/chat-images
DROP_VAULT_USERS_DIR=/var/lib/witt-dev/users
DROP_VAULT_AUTH_DIR=/var/lib/witt-dev/auth
DROP_VAULT_TOKEN_FILE=/root/.witt-dev/api-token
DROP_VAULT_CODEX_WORKDIR=/opt/witt-dev
WITT_WORKDIR_ROOTS=/opt/witt-dev
```

创建文件后执行：

```bash
chmod 600 /root/.witt-dev/app.env
```

`WITT_SUB2API_URL` 和 `OPEN_WEBUI_URL` 不是朋友服务器上运行 Grok MVP 的必要条件。除非确实要联调，不要为了让 Server Center 全绿而复制更多凭据或开放更多端口。

### 阶段 D：配置朋友服务器的 Grok provider

朋友服务器的 Grok 配置应重新创建。关键部分为：

```toml
[model_providers.witt-cpa]
base_url = "http://127.0.0.1:18317/v1"
api_backend = "responses"

[model."grok-4.7-high"]
model = "grok-4.7-high"
model_provider = "witt-cpa"
name = "Grok 4.7 High"
env_key = "WITT_CPA_KEY"
context_window = 256000
```

Witt 的 `WITT_CPA_API_KEY` 是服务端持有的值；启动 Grok 子进程时，适配器会把该值注入 `WITT_CPA_KEY`。不要把密钥直接写进 `config.toml`。

### 阶段 E：创建独立的开发版 Witt 服务

朋友服务器的服务应满足：

- `WorkingDirectory=/opt/witt-dev`；
- `EnvironmentFile=/root/.witt-dev/app.env`；
- `ExecStart` 指向 `/opt/witt-dev/backend/server.js`；
- 仅监听回环地址；
- 使用 `witt-dev.service`，不得冒充生产的 `witt.service`；
- 不复制生产认证目录，使用新的开发邀请码。

启动后验证：

```bash
systemctl is-active witt-dev
curl -fsS http://127.0.0.1:33003/health
```

`/chat/capabilities` 需要激活后的设备身份，不能把匿名 `curl` 的 401 当成服务故障。随后使用一个全新的开发邀请码，从浏览器或带有效认证 Cookie 的客户端做真实 Grok 对话测试。测试必须证明返回模型是 `grok-4.7-high`，Harness 是 `grok-build`，Provider 是 `cpa`。

## 6. 日常开发和部署流程

朋友服务器：

```text
修改代码 -> 运行相关测试 -> 查看 git diff -> commit -> push
```

原服务器：

```text
确认目标 commit -> 拉取产品分支 -> 运行测试 -> 部署 -> 检查 /health 和公网入口
```

朋友服务器不能直接修改原服务器的生产目录。需要自动部署时，应另行建立只允许执行固定部署脚本的凭据，而不是给朋友服务器长期保存原服务器 root 私钥。

每次交付至少报告：

- 分支和 commit SHA；
- 修改文件清单；
- 测试命令与结果；
- 是否 push；
- 是否部署到生产；
- 生产健康检查结果。

## 7. 模式 B：手机原域名使用朋友服务器上的 Witt

模式 A 验收通过后才执行本节。其目标是：域名和 HTTPS 仍由原服务器处理，但 `/vault-api/` 的实际后端变为朋友服务器的 `witt-dev.service`。这样手机里的 Grok 才能直接读写朋友服务器的 `/opt/witt-dev`。

### 7.1 建立双向隧道

朋友服务器到原服务器的一条 SSH 连接可以同时承载两个方向：

```bash
ssh -NT \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L 127.0.0.1:18317:127.0.0.1:8317 \
  -R 127.0.0.1:33303:127.0.0.1:33003 \
  -i /root/.ssh/witt_cpa_tunnel \
  -p <原服务器SSH端口> \
  <隧道账号>@<原服务器地址>
```

- `18317`：朋友服务器访问原服务器 CPA；
- `33303`：原服务器访问朋友服务器 Witt；
- 两个监听端口都只能绑定 `127.0.0.1`；
- systemd 应设置自动重启和 `After=network-online.target`。

如果沿用第 5 节的受限隧道密钥，原服务器还必须允许该 key 监听 `127.0.0.1:33303`（OpenSSH 的 `permitlisten`），同时继续用 `permitopen` 限制它只能连接 CPA。若 SSH 服务端全局禁止 TCP forwarding，这两个方向都会失败；只需为专用隧道账号放行，不需要开放公网端口。反向端口仅绑定回环地址，因此不需要启用公网 `GatewayPorts`。

原服务器验证：

```bash
curl -fsS http://127.0.0.1:33303/health
```

### 7.2 决定认证和聊天数据归属

切换前必须二选一：

1. **推荐：朋友服务器新建生产数据。** 新建管理员邀请码，手机清除该站点旧登录状态后重新激活。旧聊天仍保留在原服务器，只是不在新后端显示。
2. **需要保留历史：停写后一次性迁移。** 暂停原服务器 Witt，在没有新写入的窗口内加密传输 `/root/witt-data`，核对所有者和权限，再启动朋友服务器。迁移后只允许朋友服务器写这套副本，禁止双写。

不得只复制 `auth` 而遗漏 `users`，也不得在两台服务器同时使用同一数据目录的可写副本。

### 7.3 同步静态前端

原服务器当前直接从 `/opt/witt/web/` 提供 `/vault/` 静态文件，而朋友服务器负责 API。因此原服务器的静态前端和朋友服务器后端必须来自同一个 commit。每次切换或部署先记录目标 SHA，并让两台服务器都快进到该 SHA。

### 7.4 切换 Nginx 上游

在原服务器中只把 `/vault-api/` 的上游从本机生产 Witt：

```nginx
proxy_pass http://127.0.0.1:3003/;
```

改为反向隧道：

```nginx
proxy_pass http://127.0.0.1:33303/;
```

必须先执行 `nginx -t`，成功后才 reload。不要修改域名、证书、CPA `/healthz` 或其他现有路由。

### 7.5 回退

发生隧道故障、朋友服务器故障或验收失败时，将 `/vault-api/` 上游改回 `127.0.0.1:3003`，执行 `nginx -t` 后 reload。原服务器的 `witt.service` 和原数据在确认迁移成功前都应保留，不能删除。

### 7.6 影响和限制

这个切换会改变生产请求实际落点：

- 认证、聊天记录和任务数据将以朋友服务器为准；
- 朋友服务器或隧道断开会导致正式网址不可用；
- 原服务器静态前端必须与朋友服务器后端保持同一 commit；
- 两台 Witt 不能同时写同一套数据；
- 切换前必须明确数据归属和回退方式。

在没有完成独立备份、健康检查和回退演练前，不执行这个切换。

## 8. 故障定位顺序

朋友服务器上的 Witt 无法连接 Grok 时，按以下顺序检查，不要先更换密钥：

1. `systemctl is-active`：开发版 Witt 和 CPA 隧道服务是否运行；
2. `ss -ltn`：`127.0.0.1:18317` 是否监听；
3. `curl http://127.0.0.1:18317/healthz`：隧道能否到达 CPA；
4. `WITT_CPA_URL`：是否为 `http://127.0.0.1:18317/v1`；
5. `WITT_CPA_API_KEY`：只检查是否设置和长度，不输出值；
6. Grok `config.toml`：provider URL 和 `env_key` 是否正确；
7. `grok --version` 和模型目录：二进制是否可执行；
8. `/chat/capabilities`：Witt 是否把 Grok 标为 available；
9. 最后才进行真实对话测试。

典型故障判断：

| 现象 | 最可能原因 |
| --- | --- |
| CPA health 连接被拒绝 | 隧道未运行或端口配置错误 |
| CPA health 正常、模型请求 401/403 | CPA 调用密钥缺失或不一致 |
| Witt 显示 Grok executable not found | `WITT_GROK_BIN` 路径错误 |
| Grok 启动但访问原服务器 `8317` 失败 | Grok provider 仍写着原服务器本地地址，没有改成 `18317` |
| 开发测试污染正式聊天记录 | 误用了生产数据目录 |
| 域名仍显示旧版本 | 只 push 了代码，尚未在原服务器部署；这是默认架构下的正常现象 |

## 9. 交接验收标准

全部满足后才算朋友服务器接管成功：

1. 朋友服务器检出正确产品分支，工作区干净；
2. `gh auth status` 成功，并能 push 测试分支或产品分支；
3. CPA 隧道由 systemd 常驻，重启后自动恢复；
4. 原服务器 CPA 仍只监听 `127.0.0.1:8317`；
5. 朋友服务器没有保存原服务器管理员私钥、CPA 账户库或 TLS 私钥；
6. 开发版 Witt 使用独立数据目录和邀请码；
7. 朋友服务器真实 Grok 对话成功；
8. 一次小改动能在朋友服务器完成测试、commit 和 push；
9. 原服务器能按指定 SHA 部署，并保持正式域名不变；
10. 生产 `/health` 和 `https://cpa.stellarbit.site/vault/` 均正常。

## 10. 仍需由服务器所有者提供的信息

以下信息不能写入仓库，应在实施时单独提供：

- 朋友服务器的系统版本、CPU 架构、登录账号和 SSH 地址；
- 原服务器给专用隧道账号使用的 SSH 地址和端口；
- 专用隧道公钥的安装确认；
- CPA 调用密钥的安全交付方式；
- GitHub 设备授权确认；
- 是否只采用默认开发模式，还是未来确实要把正式 `/vault-api/` 切到朋友服务器。

如果由其他 AI 接管，应先让它阅读本文件，再做只读环境检查；未经明确授权，不得切换 Nginx 上游、迁移生产数据或复制整套密钥目录。

## 11. 给接管 AI 的首条指令

可以把下面这段连同本文件一起交给接管者：

```text
先阅读 docs/FRIEND-SERVER-HANDOFF.md。当前先执行模式 A，不执行模式 B。

你的第一轮任务只做：
1. 只读盘点朋友服务器的系统、CPU、磁盘、端口、Node、Git、gh、Grok 和 SSH 状态；
2. 克隆或核对 /opt/witt-dev，检出 platform/personal-ai-ops；
3. 列出缺少的软件和需要服务器所有者提供的公钥/授权，不读取或打印任何现有秘密；
4. 给出即将执行的安装与配置命令；
5. 遇到 GitHub 设备授权、CPA 调用密钥或原服务器安装隧道公钥时暂停，等待所有者操作。

未经再次确认不得：
- 修改原服务器 Nginx；
- 切换 /vault-api/ 上游；
- 复制生产 /root/witt-data；
- 复制原服务器 root 私钥、TLS 私钥、CPA 账户库或整个 /root/.witt；
- 停止或替换原服务器 witt.service；
- 修改或推送 main 分支。

模式 A 验收完成后先汇报结果。只有服务器所有者明确要求“手机原域名切到朋友服务器”时，才按第 7 节执行模式 B，并在切换前验证回退路径。
```
