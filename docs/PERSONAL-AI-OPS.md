# 手机开发闭环

适用范围：生产 `/opt/witt` 的 `platform/personal-ai-ops` 产品分支，管理员账户，已绑定的仓库 Deploy Key。此功能不是通用 CI/CD 平台。

## 使用

1. 在手机浏览器打开 Witt，选择 Grok，工作目录使用 `/opt/witt`，描述要修改的代码。
2. 查看 Grok 的命令、工具调用和答复，再展开本轮文件列表与 Diff。回合开始前已有的修改不会自动算作本轮文件。
3. 点“运行测试”。Witt 运行固定且可见的仓库测试并显示退出码和错误；这一步不提交、不推送、不部署。
4. 测试通过后重新查看 Diff，填写提交说明，点“确认提交并推送”。后端重验 Git HEAD、文件哈希、分支和提交范围，精确 `git add` 本轮文件，再提交并推送产品分支。
5. 如确需更新 Witt，点“准备部署”，再点“确认部署并重启”。跳过部署也是有效选择。部署在独立 systemd 单元中延迟执行，避免当前 HTTP 回复被重启中断。
6. 刷新或重新打开原对话，可继续查看交付状态、健康与版本结果，并继续同一 Grok Session。

若提交前文件又发生变化，必须重新运行测试。断线不会自动重放已经发出的命令；中断的 push 需要用户明确重试。交付任务记录在 `/opt/witt/.git/witt-development-jobs`，不进入 Git 提交。

## 范围与限制

生产自动交付只操作 `/opt/witt`、产品分支和仓库专用 origin。不执行强推、重置历史、清理未知修改或修改 main。首次代码测试在 `/opt/witt/.git` 内的隔离 Git 项目和本地 bare remote 完成；真实 Grok、浏览器、部署结果以最终验收记录为准。

Codex 保留原 Witt 路径，但当前服务器没有可用的 Codex 授权。Gemini/Antigravity 在此 CPU 上不可运行。Android 原生桥接改动需重新发布 Release App；移动浏览器可先使用 Web 流程。

架构见 [ARCHITECTURE.md](ARCHITECTURE.md)，发布方法见 [DEPLOYMENT.md](DEPLOYMENT.md)，当前阻塞见 [KNOWN-ISSUES.md](KNOWN-ISSUES.md)。
