# Known issues

This file lists current limitations. A unit test or an adapter file does not count as live availability.

1. **Codex on this production server:** CLI is installed, and Witt retains the original App Server path, but no usable local Codex authentication is configured. A real current-version Codex turn has not been verified.
2. **Gemini / Antigravity:** the published binary requires `pclmulqdq`, which this QEMU CPU does not expose. The option is unavailable here. No workaround is planned in this phase.
3. **Android release:** the modified native bridge is source-only until a signed Release APK is built and installed. The production server does not have signing material. The mobile HTTPS browser is the supported current route.
4. **Physical phone:** automated mobile viewport checks exist; a person has not yet completed the full workflow on a physical handset.
5. **Sub2API provider discovery:** the service is healthy, but this Witt environment has no Sub2API API credential. Its models cannot be treated as available.
6. **CPA client-version override:** CPA still needs the operator metadata workaround recorded in the archived integration log. A fresh upstream login may remove it.
7. **Open WebUI:** the existing external service has no dedicated HTTPS hostname. Witt only links to it and does not proxy it.
8. **Live development delivery:** isolated Git tests cover Diff, tests, confirmation, commit and push. A real Grok code-edit turn through the newly deployed UI and the production deploy/restart path still require final acceptance.

For the active architecture and release method, see [ARCHITECTURE.md](ARCHITECTURE.md) and [DEPLOYMENT.md](DEPLOYMENT.md).
