# Chloe Design System

## Ownership

- `web/ui-system.css` owns shared palette, type, spacing, radius, focus, disabled,
  elevation, font-family and status tokens. It also owns the shared visual finish
  for sheets, form controls, selection controls, tabs, menus and toasts.
- `web/component-interactions.css` owns focus feedback, hover and pressed feedback,
  motion reduction and coarse-pointer hit targets. It consumes the shared tokens.
- `web/chloe-autumn.css` owns the Chloe workspace composition, background, sidebar
  and composer geometry. Its `--chloe-sidebar-width` and `--chloe-composer-width`
  remain page-layout tokens.
- `web/claude-app.css` and `web/witt-white.css` retain legacy page layout and
  business-specific rules. Their component colors now resolve through shared
  semantic tokens instead of separate root palettes.

## Palette Tokens

The `--chloe-*` tokens describe brand surfaces and emphasis: `canvas`, `surface`,
`sidebar`, `elevated`, `ink`, `body`, `muted`, `olive`, `olive-hover`, `gold`,
`line`, `selection`, `soft` and `shadow`. The same names receive dedicated dark
values under `:root[data-theme="dark"]`.

`--ui-success`, `--ui-warning`, `--ui-error` and `--ui-info` carry distinct
meaning, each with a corresponding `-soft` surface token. Status colors remain
green, amber, red and teal respectively; brand gold is reserved for decoration
and warm emphasis. Use the semantic token that matches the state instead of
reusing the brand accent.

Legacy variables (`--bg`, `--surface`, `--surface-solid`, `--surface-raised`,
`--surface-soft`, `--ink`, `--ink-soft`, `--muted`, `--line`, `--line-strong`,
`--accent`, `--ui-focus`, and `--ws-*`) resolve from the same palette so older
components inherit it without needing page-specific color sets.

## Components and States

## Autumn Icon Set

The reusable SVG symbols live in `web/index.html` under the `autumn-icon-*`
IDs and are consumed with `<use>`. The current mapping is:

- Hero label: `leaf`
- Remote workspace: `monitor-leaf`
- Project and service connections: `branch`
- Model, Harness and server settings: `gear-leaf`
- My usage: `sprout`
- Device management: `monitor-leaf`
- Composer model control: `leaf`
- History rows: deterministic `leaf`, `acorn`, `sprout` or `document-leaf` based on the conversation ID; active and pinned states use the same family with olive or amber emphasis.

All symbols use a 24px viewBox, rounded line ends and the shared autumn tokens.
The mapping is deterministic and does not infer task type from conversation text.

Sheets and their headers use `--surface` and `--shadow-lg`; inputs and selects use
`--surface-solid`, `--line-strong` and the shared control radius. Selected options
use the selection surface and olive edge. Tabs use the soft surface with a raised
active item. Menus use the elevated surface and shared shadow. Primary commands
use olive, with a darker olive hover; destructive controls retain error semantics.

Focus-visible controls use a two-pixel olive ring with an offset. Disabled
controls keep their layout and remain visually identifiable through a subdued
surface, muted foreground and disabled cursor. Hidden states continue to honor
the native `[hidden]` attribute. Touch-oriented sheet controls and menu rows keep
44-pixel minimum targets.

Product copy and controls use `--ui-font-sans`; code uses `--ui-font-code`.
Terminal metrics, math rendering and embedded Artifact content remain outside
the global font rules.

Toast variants and status labels use success, warning or error tokens according
to their state. The neutral toast stays charcoal on ivory. Runtime terminal
surfaces and code content keep their own dark palette and font metrics; global
type rules do not style terminal output. The embedded Artifact canvas remains
white so external preview content is not recolored with the surrounding chrome.

## Exceptions

The shared tokens define visual meaning, while page CSS retains geometry and
specialized business presentation. Chloe's landscape layer and workspace layout
stay in `chloe-autumn.css`; they are not reproduced as a shared theme. Terminal
output and the Artifact canvas are intentional fixed-palette surfaces. Legacy
`!important` declarations are limited to existing high-priority boundaries where
older page rules otherwise prevent a shared semantic token from taking effect.
