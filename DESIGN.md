# Chloe · Autumn workspace

The supplied Figma image fixes the visual direction. This is an operating interface: real controls and long-session readability take priority over decorative effects.

- Ivory and cream surfaces; dark olive primary actions; amber and russet SVG accents.
- Desktop sidebar: 370px at the reference viewport, 300px on narrower desktop screens. One shared width controls the drawer, canvas and landscape offset.
- Welcome: centered horizontally in the upper third, with a quiet capability label, strong greeting and restrained description. The lake occupies the space formerly filled by shortcut cards.
- Composer: a warm white floating surface, readable input above a left-aligned combined environment/model/reasoning selector, voice and send on the right. It retains the existing combined selector's semantics.
- Landscape: use the user's independent painting in `web/assets/chloe-autumn-landscape.webp`; preserve older paintings as alternatives. The main stage uses right-aligned desktop cropping and an 88% mobile crop to retain the sun, with a gradient fallback. Real chat reduces landscape opacity to 8% for readable Markdown, tools and code.
- Theme and semantic tokens live in `web/ui-system.css`; homepage composition lives in `web/chloe-autumn.css`. Legacy locked properties require a bounded compatibility layer; existing component rules consume shared tokens rather than a new override stylesheet.
- Working surfaces use warm opaque paper, olive actions and amber pending states. Success, warning and error remain separate semantic colors in both themes. Native terminals, math rendering and Artifact content retain their own rendering contracts.
- Browser shell rules are scoped to `.web-browser.chloe-autumn-workspace`; native platform detection remains runtime controlled.

Acceptance: real browser screenshots at 1672×941, 1440×900, 1920×1080, 1024×768 and 390×844, with desktop/mobile light/dark matrices for working surfaces. Run `node tests/capture-scenes.mjs --audit` for the filterable gallery and audit JSON, and `node tests/measure-layout.mjs` for geometry checks. A bounded visual inspection and correction pass accompanies mocked API interaction regression; live credentials, native device integration and production deployment are outside this round. See `docs/chloe-design-system.md` and `docs/ui-surface-inventory.md` for component conventions and coverage.
