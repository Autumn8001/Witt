# Frontend UI consistency pass — 2026-10-06

Scope: frontend presentation only, based on `7406ab1` on
`platform/personal-ai-ops`. No production deployment.

## Shared hierarchy

`web/ui-system.css` is loaded after the existing page and theme styles. It
reconciles the existing cascade without replacing the product layout:

- Page titles: 24px; section titles: 18px; card titles: 16px.
- Conversation prose: 15px; controls: 14px; explanations/code: 13px;
  secondary labels: 12px. Sizes use rem units.
- Quota figures retain 30px prominence; secondary numerical metrics use 24px.
- Sheet/form controls and Artifact tools have 44px minimum touch heights.
- Phone form inputs use 16px to avoid small-input browser zoom.
- Light/dark secondary text and Server Center metrics use their own surface
  palette. The existing dark runtime panel retains its separate palette.

## Page-by-page changes

| Surface | Change |
| --- | --- |
| Conversation | Consistent prose/heading scale; readable code, copy button and image metadata; remove conflicting code backgrounds and double borders |
| History drawer | Readable utility tiles, history labels, theme controls and footer; retain independent history scrolling; allow utility scrolling in short landscape views |
| My profile | Consistent section/card titles, extension descriptions and refresh controls; retain single-column phone CPA quotas; increase usage metadata and figures |
| Model/settings | Readable model descriptions, reasoning counts/stops, access explanations and Apply action; phone permissions use two columns |
| Server Center | Fix pale metrics on light sheets; readable metric labels; separate from the dark runtime card |
| Runtime card | Phone metrics use two columns; readable action captions and disabled states |
| Customer devices | Readable list/status/form hierarchy; long names wrap; use device ID and authorized project count when workspace options omit machine metadata, instead of claiming the Agent has not registered |
| Project picker | Consistent titles, descriptions, button spacing and tap height |
| Delivery files | Readable summary/help text and file titles |
| Execution details | Readable section labels and monospace output; preserve exit-code/failure information |
| Approvals | Readable field/choice/evidence text and touch targets; retain all approval behavior |
| Artifact workspace | Readable handoff, version and code text; larger tools; improve dark toolbar contrast; embedded preview content is untouched |
| Access-device/account sheets | Apply shared typography and button sizing; no authorization, invitation or account logic changes |
| Project/service overview | Consistent section hierarchy and readable descriptions/paths/statuses |
| Local server forms | Consistent labels/help/input sizes; terminal canvas metrics and SSH/SFTP logic are untouched |

## Validation

Run from `/opt/witt`:

```sh
node tests/ui-check.mjs
node --check web/profile-overview.js
node --check web/customer-devices.js
node --check tests/ui-check.mjs
git diff --check
```

The UI suite uses synthetic authentication, native bridges and API fixtures.
It now mocks the current remote-workspace options/creation contract and waits
for application readiness rather than relying on a fixed boot delay. It checks
ready/offline/incompatible devices and the submitted workspace binding.

Persisted workflow fixtures return the same saved conversation on every startup
request, preventing late fake refreshes from replacing the state under test.

Additional per-surface checks capture 390×844 and 1260×900 in light and dark
modes, assert horizontal containment, readable key labels and unclipped project/model descriptions, and generate
`tests/ui-system-<surface>-<mobile|desktop>-<light|dark>.png`. Covered surfaces:
Artifact, customer workspace, approval, execution, settings, delivery, projects,
accounts, access devices, and project/service overview. Existing profile,
conversation, drawer, landscape, local terminal/SFTP and interaction checks
remain in the suite. Existing CPA tests include 360/390/620/1024px and landscape,
text contrast, quota failures, long labels and button targets. Runtime contrast
assertions now select the actual runtime card rather than Server Center's first
metric.

Screenshots are ignored generated artifacts, not committed production assets.
Visual checks concern mocked browser rendering; they do not constitute a real
Windows transport, model call, real quota or production acceptance test.

## Remaining limits

- Physical phones, iOS Safari and the Android WebView were not exercised.
- The legacy stylesheet stack still exists; the final scoped stylesheet
  reconciles it. Removing old theme/layout files requires a separate migration.
- Embedded customer Artifact documents and native terminal output control their
  own typography.
- Production was not deployed or restarted.
