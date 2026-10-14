# Chloe autumn implementation and acceptance

This round remains local on `codex/chloe-autumn-system`. No production deployment, merge, backend change, business JavaScript change, credential change or real account mutation was performed.

## Implementation

- Converted the user's independent 1672×941 landscape PNG into `web/assets/chloe-autumn-landscape.webp` (195,446 bytes). Older backgrounds remain available. No UI screenshot pixels or generated replacement imagery were used.
- Refined `web/chloe-autumn.css`: welcome title placement, desktop/mobile landscape crop, gradient fallback, 8% landscape opacity in actual chat, mobile touch targets and desktop Artifact layout. The three welcome cards remain absent.
- Centralized light/dark colors, typography, interaction and semantic states in `web/ui-system.css`. Updated `web/claude-app.css`, `web/witt-white.css` and `web/component-interactions.css` to consume the system.
- Migrated auth/device administration, accounts, approvals, model settings, remote devices, profile and Artifact chrome in their existing CSS files. Corrected leftover runtime palette rules in `web/witt-next.css` and approval label colors in `web/approval-dock.css`.
- Updated `web/index.html` stylesheet versions, workspace token aliases and semantic SVG entry icons. Preserved model/environment/reasoning selection as one real control.
- Corrected native composer geometry for the two toolbar groups already present in the HTML. Terminal output, math layout, iframe content, authentication, Harness and SSE logic remain unchanged.

## Verification

- `node tests/autumn-interaction-check.mjs`: passed after shared styles were stable. Checks sidebar collapse/restore, model/settings controls, multiline input, actual history search/filter/switching, new conversations, attachment preview and browser errors.
- `node tests/ui-check.mjs`: passed after final UI corrections. Exercises mocked native terminal/SFTP, remote workspace binding, Markdown/math/code, Artifact preview/source, approval decisions, reasoning/model/access changes, message sending, account flows, quota unknown/stale/error states, responsive sheets, focus/hover/disabled behavior and reduced motion.
- `node tests/measure-layout.mjs`: passed. Reference-size sidebar 370px and composer 944px; title begins near y=173. No shortcut-card container is present.
- CSS parsing and `git diff --check`: passed. Full browser capture results are in [ui-audit-report.md](ui-audit-report.md).
- Real screenshots reviewed together for desktop/mobile and light/dark: homepage, model/settings, usage, remote devices, accounts, device management, chat/code, approval and Artifact. The Artifact correction removes partial covered chat at narrower desktop widths; larger desktops can split the remaining main stage.

The older ui-check suite contained assertions for an obsolete font, three welcome cards, fixed model-rail height and exact gray/white palette values. These now check the actual greeting, absence of cards, usable model-card targets, shared font/color tokens and state feedback. Interaction and data assertions were retained. Static routes now load actual files instead of substituting empty content or the main app script for unknown assets.

Contrast sampling recognizes computed `color(srgb ...)` and omits text obscured by an overlay. The report is a bounded automatic sample, not full WCAG certification; it excludes tiny text, disabled content and image/gradient backgrounds.

## Evidence and repeatability

- [Surface inventory](ui-surface-inventory.md)
- [Design system](chloe-design-system.md)
- [Final screenshot gallery](../tests/artifacts/chloe-system/final-20261013/gallery.html)
- [Machine results](../tests/artifacts/chloe-system/final-20261013/audit.json)
- Desktop home: `tests/artifacts/chloe-system/final-20261013/screenshots/home-1672--1672x941--light--ready.png`
- Mobile home: `tests/artifacts/chloe-system/final-20261013/screenshots/home-390--390x844--light--ready.png`

Regenerate the gallery with `node tests/capture-scenes.mjs --audit final-20261013`. Generated screenshot/gallery/JSON artifacts are local outputs ignored by Git; scripts and documentation are committed. Homepage baseline images were captured before UI edits; some subsequent baseline component captures overlapped the migration and are not claimed as a complete pre-change snapshot.

## Remaining verification boundaries

All API records in automated tests are explicit synthetic fixtures. No real OAuth login, provider execution, production quotas, remote device connection, native secure credential storage or deployment was verified. Startup loading is inventoried but not captured as a stable visual scene. Artifact audit captures verify chrome; the separate ui-check verifies isolated preview content and source. Approval/archive/administration actions in the screenshot runner are opened without submitting; interaction tests submit only into their mocks.

The local frontend checks support review and merge. Deployment readiness still requires the project's normal environment checks and actual integration smoke tests; this round does not claim live-system certification.
