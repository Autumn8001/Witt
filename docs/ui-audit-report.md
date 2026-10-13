# Chloe UI audit report

- Run: `final-20261013` (audit), 2026-10-13T05:57:35.640Z.
- Evidence: [gallery](../tests/artifacts/chloe-system/final-20261013/gallery.html), [machine JSON](../tests/artifacts/chloe-system/final-20261013/audit.json). All API/UI records are local mock fixtures; no production endpoint, credential, deletion, push, or deployment was exercised.
- Captures: 65; blocked scenes: 0; page errors: 0; static asset failures: 0; sampled low-contrast text findings: 0.
- Required background: `/vault/assets/chloe-autumn-landscape.webp` exists on disk.
- Home viewports: 1672×941, 1440×900, 1920×1080, 1024×768, 390×844; theme matrix: desktop/mobile × light/dark.
- Known access gaps: local SSH/terminal depends on native device integration and is not invoked; provider OAuth/login is not completed; archive confirmation is opened but not submitted; approval decisions and remote workspace creation are not submitted; credentials and destructive actions remain untested.
- Contrast samples skip text under 12px, disabled/transparent/icon content, and surfaces with image/gradient backgrounds; remaining findings are review signals, not an automatic WCAG verdict.

## Scene results

| Scene | Category | View | Theme | Status | Errors / findings |
|---|---|---:|---|---|---|
| home-1672 | home | 1672×941 | light | ready | overflow 1672/1672; clipped 0; occluded 0; contrast 0 |
| home-1440 | home | 1440×900 | light | ready | overflow 1440/1440; clipped 0; occluded 0; contrast 0 |
| home-1920 | home | 1920×1080 | light | ready | overflow 1920/1920; clipped 0; occluded 0; contrast 0 |
| home-1024 | home | 1024×768 | light | ready | overflow 1024/1024; clipped 0; occluded 0; contrast 0 |
| home-390 | home | 390×844 | light | ready | overflow 390/390; clipped 0; occluded 0; contrast 0 |
| conversation-empty | conversation | 1440×900 | light | no conversations fixture | overflow 1440/1440; clipped 0; occluded 0; contrast 0 |
| conversation-empty | conversation | 390×844 | light | no conversations fixture | overflow 390/390; clipped 0; occluded 0; contrast 0 |
| boot-loading | loading | 1440×900 | light | conversation-list API held for 8s by fixture | overflow 1440/1440; clipped 0; occluded 8; contrast 0 |
| boot-loading | loading | 390×844 | light | conversation-list API held for 8s by fixture | overflow 390/390; clipped 0; occluded 8; contrast 0 |
| home-theme-matrix | home | 1440×900 | light | ready | overflow 1440/1440; clipped 0; occluded 0; contrast 0 |
| home-theme-matrix | home | 1440×900 | dark | ready | overflow 1440/1440; clipped 0; occluded 0; contrast 0 |
| home-theme-matrix | home | 390×844 | light | ready | overflow 390/390; clipped 0; occluded 0; contrast 0 |
| home-theme-matrix | home | 390×844 | dark | ready | overflow 390/390; clipped 0; occluded 0; contrast 0 |
| settings-runtime-harness-provider | model-runtime | 1440×900 | light | ready | overflow 1440/1440; clipped 8; occluded 23; contrast 0 |
| settings-runtime-harness-provider | model-runtime | 1440×900 | dark | ready | overflow 1440/1440; clipped 7; occluded 22; contrast 0 |
| settings-runtime-harness-provider | model-runtime | 390×844 | light | ready | overflow 390/390; clipped 5; occluded 9; contrast 0 |
| settings-runtime-harness-provider | model-runtime | 390×844 | dark | ready | overflow 390/390; clipped 5; occluded 10; contrast 0 |
| profile-quota | usage | 1440×900 | light | ready | overflow 1440/1440; clipped 0; occluded 22; contrast 0 |
| profile-quota | usage | 1440×900 | dark | ready | overflow 1440/1440; clipped 0; occluded 22; contrast 0 |
| profile-quota | usage | 390×844 | light | ready | overflow 390/390; clipped 0; occluded 8; contrast 0 |
| profile-quota | usage | 390×844 | dark | ready | overflow 390/390; clipped 0; occluded 9; contrast 0 |
| workspace-projects-servers | workspace | 1440×900 | light | ready | overflow 1440/1440; clipped 0; occluded 22; contrast 0 |
| workspace-projects-servers | workspace | 1440×900 | dark | ready | overflow 1440/1440; clipped 0; occluded 22; contrast 0 |
| workspace-projects-servers | workspace | 390×844 | light | ready | overflow 390/390; clipped 0; occluded 9; contrast 0 |
| workspace-projects-servers | workspace | 390×844 | dark | ready | overflow 390/390; clipped 0; occluded 10; contrast 0 |
| remote-devices | remote | 1440×900 | light | ready | overflow 1440/1440; clipped 0; occluded 8; contrast 0 |
| remote-devices | remote | 1440×900 | dark | ready | overflow 1440/1440; clipped 0; occluded 8; contrast 0 |
| remote-devices | remote | 390×844 | light | ready | overflow 390/390; clipped 0; occluded 8; contrast 0 |
| remote-devices | remote | 390×844 | dark | ready | overflow 390/390; clipped 0; occluded 9; contrast 0 |
| device-management | admin | 1440×900 | light | ready | overflow 1440/1440; clipped 0; occluded 22; contrast 0 |
| device-management | admin | 390×844 | dark | ready | overflow 390/390; clipped 0; occluded 9; contrast 0 |
| codex-accounts | accounts | 1440×900 | light | ready | overflow 1440/1440; clipped 0; occluded 22; contrast 0 |
| codex-accounts | accounts | 390×844 | light | ready | overflow 390/390; clipped 0; occluded 8; contrast 0 |
| login-activation | auth | 1440×900 | light | signed-out fixture | overflow 1440/1440; clipped 0; occluded 8; contrast 0 |
| login-activation | auth | 390×844 | light | signed-out fixture | overflow 390/390; clipped 0; occluded 8; contrast 0 |
| attachment-menu | composer | 1440×900 | light | ready | overflow 1440/1440; clipped 0; occluded 0; contrast 0 |
| attachment-menu | composer | 1440×900 | dark | ready | overflow 1440/1440; clipped 0; occluded 0; contrast 0 |
| attachment-menu | composer | 390×844 | light | ready | overflow 390/390; clipped 0; occluded 0; contrast 0 |
| attachment-menu | composer | 390×844 | dark | ready | overflow 390/390; clipped 0; occluded 0; contrast 0 |
| project-picker | workspace | 1440×900 | light | ready | overflow 1440/1440; clipped 0; occluded 0; contrast 0 |
| project-picker | workspace | 390×844 | dark | ready | overflow 390/390; clipped 0; occluded 0; contrast 0 |
| model-runtime-picker | model-runtime | 1440×900 | light | ready | overflow 1440/1440; clipped 0; occluded 0; contrast 0 |
| model-runtime-picker | model-runtime | 1440×900 | dark | ready | overflow 1440/1440; clipped 0; occluded 0; contrast 0 |
| model-runtime-picker | model-runtime | 390×844 | light | ready | overflow 390/390; clipped 0; occluded 0; contrast 0 |
| model-runtime-picker | model-runtime | 390×844 | dark | ready | overflow 390/390; clipped 0; occluded 0; contrast 0 |
| conversation-menu | conversation | 1440×900 | light | ready | overflow 1440/1440; clipped 5; occluded 0; contrast 0 |
| conversation-menu | conversation | 1440×900 | dark | ready | overflow 1440/1440; clipped 5; occluded 0; contrast 0 |
| conversation-menu | conversation | 390×844 | light | ready | overflow 390/390; clipped 0; occluded 0; contrast 0 |
| conversation-menu | conversation | 390×844 | dark | ready | overflow 390/390; clipped 0; occluded 0; contrast 0 |
| archive-confirmation | conversation | 1440×900 | light | confirmation only; not submitted | overflow 1440/1440; clipped 5; occluded 32; contrast 0 |
| archive-confirmation | conversation | 390×844 | light | confirmation only; not submitted | overflow 390/390; clipped 0; occluded 8; contrast 0 |
| chat-markdown-code-long | chat | 1440×900 | light | ready | overflow 1440/1440; clipped 0; occluded 0; contrast 0 |
| chat-markdown-code-long | chat | 1440×900 | dark | ready | overflow 1440/1440; clipped 0; occluded 0; contrast 0 |
| chat-markdown-code-long | chat | 390×844 | light | ready | overflow 390/390; clipped 0; occluded 0; contrast 0 |
| chat-markdown-code-long | chat | 390×844 | dark | ready | overflow 390/390; clipped 0; occluded 0; contrast 0 |
| task-pending-approval | task-status | 1440×900 | light | pending; decision not submitted | overflow 1440/1440; clipped 0; occluded 5; contrast 0 |
| task-pending-approval | task-status | 1440×900 | dark | pending; decision not submitted | overflow 1440/1440; clipped 0; occluded 5; contrast 0 |
| task-pending-approval | task-status | 390×844 | light | pending; decision not submitted | overflow 390/390; clipped 0; occluded 5; contrast 0 |
| task-pending-approval | task-status | 390×844 | dark | pending; decision not submitted | overflow 390/390; clipped 0; occluded 5; contrast 0 |
| task-error-toast | task-status | 1440×900 | light | error callback fixture | overflow 1440/1440; clipped 0; occluded 0; contrast 0 |
| task-error-toast | task-status | 390×844 | light | error callback fixture | overflow 390/390; clipped 0; occluded 0; contrast 0 |
| attachment-preview | attachments | 1440×900 | light | fixture image; preview only | overflow 1440/1440; clipped 0; occluded 26; contrast 0 |
| attachment-preview | attachments | 390×844 | light | fixture image; preview only | overflow 390/390; clipped 0; occluded 10; contrast 0 |
| artifact-workspace | artifact | 1440×900 | light | fixture artifact; no external source | overflow 1440/1440; clipped 0; occluded 9; contrast 0 |
| artifact-workspace | artifact | 390×844 | light | fixture artifact; no external source | overflow 390/390; clipped 0; occluded 9; contrast 0 |

## CSS load order

1. loaded locally: `styles.css`
2. loaded locally: `quota.css`
3. loaded locally: `quota-fix.css`
4. loaded locally: `reset-glow.css`
5. loaded locally: `composer-aura.css`
6. loaded locally: `composer-refine.css`
7. loaded locally: `composer-transparency.css`
8. loaded locally: `composer-overlay.css`
9. loaded locally: `composer-spectra.css`
10. loaded locally: `quota-layout.css`
11. loaded locally: `quota-header-restore.css`
12. loaded locally: `quota-confirm.css`
13. loaded locally: `quota-compact.css`
14. loaded locally: `drawer-motion.css`
15. loaded locally: `quota-profile-motion.css`
16. loaded locally: `usage-insight.css`
17. loaded locally: `quota-spacing.css`
18. loaded locally: `usage-ring-fit.css`
19. loaded locally: `auth-gate.css`
20. loaded locally: `approval-card.css`
21. loaded locally: `conversation-type.css`
22. loaded locally: `night-theme.css`
23. loaded locally: `message-collapse.css`
24. loaded locally: `chat-overflow-fix.css`
25. loaded locally: `vendor/katex/katex.min.css`
26. loaded locally: `formula-code.css`
27. loaded locally: `codex-accounts.css`
28. loaded locally: `performance.css`
29. loaded locally: `landscape.css`
30. loaded locally: `lumora-global.css`
31. loaded locally: `codex-model-picker.css`
32. loaded locally: `chat-links.css`
33. loaded locally: `completed-turn.css`
34. loaded locally: `drawer-layout.css`
35. loaded locally: `witt-next.css`
36. loaded locally: `artifact-preview.css`
37. loaded locally: `claude-app.css`
38. loaded locally: `vendor/xterm/xterm.css`
39. loaded locally: `local-terminal.css`
40. loaded locally: `customer-devices.css`
41. loaded locally: `night-contrast.css`
42. loaded locally: `approval-dock.css`
43. loaded locally: `witt-white.css`
44. loaded locally: `browser-chatgpt.css`
45. loaded locally: `component-interactions.css`
46. loaded locally: `profile-overview.css`
47. loaded locally: `ui-system.css`
48. loaded locally: `chloe-autumn.css`
