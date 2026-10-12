# Chloe · Autumn workspace

The supplied Figma image fixes the visual direction. This is an operating interface: real controls and long-session readability take priority over decorative effects.

- Ivory and cream surfaces; dark olive primary actions; amber and russet SVG accents.
- Desktop sidebar: 360px at the reference viewport, 300px on narrower desktop screens. One shared width controls the drawer, canvas and landscape offset.
- Welcome: centered horizontally in the upper third, with a quiet capability label, strong greeting and restrained description. The lake occupies the space formerly filled by shortcut cards.
- Composer: a warm white floating surface, readable input above a left-aligned combined environment/model/reasoning selector, voice and send on the right. It retains the existing combined selector's semantics.
- Landscape: reuse the independent, existing autumn painting; render it on the main stage with responsive cropping and a local sky gradient rather than a full opaque wash. This asset is not identical to the reference's more detailed painting.
- Theme tokens live in `web/chloe-autumn.css`. Legacy locked properties require a bounded compatibility layer; no new override stylesheet is appended.
- Browser shell rules are scoped to `.web-browser.chloe-autumn-workspace`; native platform detection remains runtime controlled.

Acceptance: real browser screenshots at 1672×941, 1440×900, 1024×768 and 390×844; two visual corrections after screenshot inspection; mocked API interaction regression distinguished from live backend verification.
