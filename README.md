# Witt

> 把 Codex 安全地带到自己的服务器和 Android 手机上。

[![License: MIT](https://img.shields.io/badge/License-MIT-0f766e.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-3c873a.svg)](https://nodejs.org/)
[![Android 8+](https://img.shields.io/badge/Android-8%2B-3ddc84.svg)](android/)

Witt 是一个自托管的 Codex 客户端，由轻量 Node.js 后端、可直接登录的响应式 Web 界面和 Android WebView 外壳组成。它把 Codex App Server 的连续会话、执行进度、审批、附件、图片、交付文件和多账号能力整合到浏览器与手机端，同时让代码、会话和文件继续留在自己的服务器上。

Witt is a self-hosted mobile client for Codex. It combines a dependency-light Node.js service, a responsive web UI, and an Android shell while keeping conversations and project data on infrastructure you control.

> [!IMPORTANT]
> Witt 是社区项目，不是 OpenAI 官方产品。使用前需要自行安装并登录 Codex CLI，并遵守相关服务条款。Witt 可以执行命令和修改文件，请只部署在你信任并正确隔离的服务器上。

## Witt-Autumn 产品分支

`platform/personal-ai-ops` 在原 Witt 上增加 Grok Build 工作区、只读服务器概览和 Open WebUI 外部入口。Codex 保留原有 App Server 路径；Gemini 在当前服务器不可运行。开发交付按“查看本轮 Diff → 运行测试 → 确认提交/推送 → 可选确认部署”进行，部署使用同一 Git 提交的前后端快照。实际状态与限制见 [架构](docs/ARCHITECTURE.md)、[Harness](docs/HARNESS.md)、[部署](docs/DEPLOYMENT.md)和[已知问题](docs/KNOWN-ISSUES.md)。

## 主要能力

- 连续 Codex 会话、历史记录和本地缓存
- App Server 动态模型目录及 Low 到 Ultra 推理强度
- 实时展示计划、命令、文件修改、MCP、审批和最终答复
- Claude 风格 Artifact 工作区，支持完整 HTML 快照的增量预览、版本切换和源码查看
- 对话分支、上下文压缩和代码审查
- 图片、文档及大文件附件上传，生成图片、交付文件下载和隔离式交互预览
- 邀请码激活、独立设备凭据、设备停用和管理员能力
- ChatGPT 风格桌面网页版，使用 HttpOnly 安全会话 Cookie
- 默认账号与子账号隔离，会话、项目和额度互不混用
- SQLite 持久化、WAL、定时备份及 JSON 旧数据迁移
- 浅色、深色和动态主题，兼容横屏与移动端安全区
- Android Keystore 凭据保存、原生下载和应用内更新
- Android 本地 SSH 终端，支持 Keystore 加密的多服务器配置和点击直连

## 架构

```text
Android App / Mobile Browser
          │ HTTPS
          ▼
  Nginx reverse proxy
     ├── /vault/      静态 Web UI
     └── /vault-api/  Witt API
                         │
                         ▼
                 Node.js service
                  ├── Auth / SQLite
                  ├── files & images
                  └── Codex App Server
                              │
                              ▼
                        local projects

Android App ── SSH ──► 用户指定的服务器
```

| 目录 | 用途 |
| --- | --- |
| `backend/` | HTTP API、认证、会话、App Server 客户端与备份 |
| `web/` | 无构建步骤的 HTML、CSS、JavaScript 客户端 |
| `android/` | Android WebView 外壳、Keystore、下载与更新 |
| `deploy/` | systemd、Nginx 和备份定时器示例 |
| `tests/` | Node.js 服务测试和 Playwright UI 回归测试 |

更详细的数据流和安全边界见 [架构文档](docs/ARCHITECTURE.md)。

## 环境要求

- Linux 服务器，建议 Ubuntu 24.04 或同等版本
- Node.js 22.5 或更高版本（项目使用内置 `node:sqlite`）
- 已安装并完成登录的 Codex CLI
- Nginx 及有效 HTTPS 证书
- Android 构建可选：JDK 17、Android SDK 35、Gradle 8.x
- UI 测试可选：Playwright 与 Chromium

后端没有第三方 npm 运行时依赖，`backend/package.json` 仅声明 CommonJS 模式。

## 快速开始

### 1. 克隆并准备目录

```bash
git clone https://github.com/LeoWilson-Ben/witt.git
cd witt
mkdir -p runtime/{files,tasks,chat,chat-images,users,auth}
```

### 2. 创建兼容令牌文件

兼容令牌只用于受信任的服务端或旧客户端接入。不要提交到 Git，也不要写入 APK。

```bash
install -d -m 700 runtime/secrets
openssl rand -hex 32 > runtime/secrets/api-token
chmod 600 runtime/secrets/api-token
```

### 3. 配置并启动后端

```bash
export DROP_VAULT_PORT=3003
export DROP_VAULT_DATA_DIR="$PWD/runtime/files"
export DROP_VAULT_TASK_DIR="$PWD/runtime/tasks"
export DROP_VAULT_CHAT_DIR="$PWD/runtime/chat"
export DROP_VAULT_IMAGE_DIR="$PWD/runtime/chat-images"
export DROP_VAULT_USERS_DIR="$PWD/runtime/users"
export DROP_VAULT_AUTH_DIR="$PWD/runtime/auth"
export DROP_VAULT_TOKEN_FILE="$PWD/runtime/secrets/api-token"
export DROP_VAULT_CODEX_BIN="$(command -v codex)"
export DROP_VAULT_CODEX_WORKDIR="$PWD"
node backend/server.js
```

验证服务：

```bash
curl http://127.0.0.1:3003/health
```

预期返回 `{"ok":true}`。

### 4. 发布 Web UI

将 `web/` 复制到 Web 根目录，并参考 [Nginx 示例](deploy/upload-entry-https.conf) 把 `/vault-api/` 代理到 `127.0.0.1:3003`。生产环境必须使用 HTTPS，否则 Android 凭据桥接、下载和浏览器安全能力可能受限。

### 5. 激活设备

首次启动后，通过管理员界面创建一次性邀请码，在新设备上输入即可激活。设备获得独立凭据；管理员可以随时停止单台设备，而不影响其他设备。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DROP_VAULT_PORT` | `3003` | 仅监听本机的 API 端口 |
| `DROP_VAULT_DATA_DIR` | `/data/drop-vault/files` | 上传文件目录 |
| `DROP_VAULT_TASK_DIR` | `/data/drop-vault/tasks` | 任务状态目录 |
| `DROP_VAULT_CHAT_DIR` | `/data/drop-vault/chat` | 会话数据库目录 |
| `DROP_VAULT_IMAGE_DIR` | `/data/drop-vault/chat-images` | 会话图片目录 |
| `DROP_VAULT_USERS_DIR` | `/data/drop-vault/users` | 用户隔离目录 |
| `DROP_VAULT_AUTH_DIR` | `/data/drop-vault/auth` | 认证数据库目录 |
| `DROP_VAULT_TOKEN_FILE` | 本机配置目录 | 兼容令牌文件路径 |
| `DROP_VAULT_CODEX_BIN` | 用户安装的 `codex` | Codex CLI 路径 |
| `DROP_VAULT_CODEX_WORKDIR` | 部署者项目目录 | 默认工作目录 |

`deploy/` 中的文件是示例，不应原样用于公网环境。请替换域名、用户、路径和证书位置，并把敏感值放进权限为 `600` 的 `EnvironmentFile` 或系统密钥管理工具。

## Android 客户端

Android 外壳要求 Android 8.0（API 26）以上。构建前通过 `~/.gradle/gradle.properties`、命令行 `-P` 参数或对应环境变量配置：

- `wittWebUrl` / `WITT_WEB_URL`
- `wittApiUrl` / `WITT_API_URL`
- `wittUpdateUrl` / `WITT_UPDATE_URL`
- `wittSigningProperties` / `WITT_SIGNING_PROPERTIES`
- `applicationId`（如果需要独立安装）

发布签名请放在未跟踪的 `signing.properties` 中，不要把 keystore、密码、令牌或签名 APK 提交到仓库。复制 `web/update.example.json` 为部署目录中的 `update.json`，并填写 Release APK 的版本、URL、大小和 SHA-256。

```bash
cd android
gradle :app:assembleRelease
```

项目不提供官方通用 APK。Release APK 应由部署者使用自己的域名、签名和更新清单构建。

## 测试

```bash
node --check backend/server.js
node --check backend/chat-service.js
node tests/auth-service-check.cjs
node tests/chat-images-check.cjs
node tests/chat-approval-check.cjs
node tests/app-server-capabilities-check.cjs
node tests/ui-check.mjs
```

UI 测试会在 `tests/` 生成本地截图，这些截图默认不进入版本控制。

## 安全模型

- API 只监听 `127.0.0.1`，公网入口交给 HTTPS 反向代理。
- 邀请码只能使用一次，设备凭据相互隔离并可单独停用。
- Android 端使用 Keystore 保护设备凭据和已保存的 SSH 密码，不将凭据持久化到网页存储。
- 会话和认证数据使用 SQLite；敏感目录应限制为服务用户可读。
- 删除数据、发送外部消息和高权限命令仍需要应用层审批策略。
- 完全访问模式允许 Codex 操作服务器，请使用专用用户、最小 sudo 规则、备份和网络隔离。

公开报告漏洞前请先阅读 [SECURITY.md](SECURITY.md)。

## 备份与恢复

`backend/backup.js` 使用 SQLite 在线备份 API，避免直接复制 WAL 数据库造成不一致。`deploy/witt-backup.service` 和 `deploy/witt-backup.timer` 提供 systemd 定时任务示例。建议把备份保存在不同磁盘，并定期演练恢复。

## 路线图

- 提供可复用的环境配置生成器
- 为多用户部署增加更细粒度的项目策略
- 提供容器化部署与健康监控示例
- 增加端到端安全测试和无障碍检查
- 把特定项目集成拆分成可选适配器

## 参与贡献

欢迎 Issue 和 Pull Request。开始前请阅读 [贡献指南](CONTRIBUTING.md) 与 [行为准则](CODE_OF_CONDUCT.md)。较大的功能建议先提交 Issue，说明使用场景、安全边界和兼容性影响。

## 许可

Witt 源代码采用 [MIT License](LICENSE)。仓库中包含的第三方组件仍遵循各自许可证，详情见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。名称、第三方服务、账号、生成内容、部署数据和部署者自行提供的视觉媒体不因本许可证自动获得授权。

## 致谢

- [OpenAI Codex](https://developers.openai.com/codex/) 提供代理能力
- [KaTeX](https://katex.org/) 提供公式渲染
- 所有测试、反馈和贡献 Witt 的用户与开发者
