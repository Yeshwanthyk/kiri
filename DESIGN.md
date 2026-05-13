# Design

## Visual Theme

Editor-palette neutrality with one accent. kiri mirrors the aesthetic of code
editors and tiling compositors: muted neutrals tinted toward a hue, a single
saturated accent for state, generous radii (10–20px), soft theme-tinted
shadows. Seven named themes ship; users pick one and kiri obeys it across
the entire surface.

The reference points are Zed, Helix, Raycast, and niri. The non-references are
SaaS dashboards, AI-product gradients, and document surfaces.

## Color Strategy

**Restrained** in every theme. Tinted neutrals carry 90%+ of the surface. The
accent appears on focus rings, kickers, selection, and the context meter.
`--accent-2` is reserved for the context fill gradient and incidental
contrast. No theme uses a second accent for primary buttons or links.

All colors expressed in OKLCH (or hex equivalents for ported palettes).
`color-mix(in oklab, …)` generates soft / muted / translucent variants at
runtime, so derived tokens stay consistent across themes.

Absolute bans: no `#000`, no `#fff`, no gradient text, no glassmorphism, no
side-stripe borders.

### Semantic tokens (per theme, light + dark)

Surface
- `--paper` — page background
- `--panel` — primary surface (cards, panels)
- `--panel-2` — nested surface, code blocks
- `--panel-translucent` — overlay surface with backdrop

Text
- `--ink` — primary text
- `--muted` — secondary text

Lines
- `--line` — primary border
- `--line-subtle` — divider, inset border

Accent
- `--accent` — primary state color (theme-defined hue)
- `--accent-2` — secondary accent for context meter, gradient endpoints
- `--accent-soft` — accent mixed into panel
- `--accent-muted` — accent mixed into muted text

State
- `--warn`, `--warn-soft`
- `--danger`, `--danger-soft`
- `--success`

Derived
- `--selection`, `--selection-ink`
- `--overlay`, `--shadow`
- `--code-bg`
- `--context-fill`, `--context-track`, `--context-core`, `--context-ink`

### Themes

`kiri` (default), `vesper`, `github`, `tokyonight`, `catppuccin`, `gruvbox`,
`rosepine`. Each ships light and dark. Theme selection lives in workspace
settings and is applied as CSS custom properties on a root element via
`applyKiriTheme()` in `src/theme/kiri-themes.ts`.

## Typography

Pair a sans for UI with a mono for technical detail.

- **UI sans**: Geist (or Inter as fallback). Used for headings, body, labels,
  buttons.
- **Mono**: JetBrains Mono. Used for runtime names, model IDs, project IDs,
  file paths, key bindings, session timestamps, anywhere the value is a
  literal token the user might copy or compare.

### Scale

- 28px / 1.0 / weight 800 — settings hero h2, page-level titles
- 16px / 1.25 / weight 700 — section titles inside panels
- 14px / 1.4 / weight 700 — panel strong labels, button text
- 13px / 1.45 / weight 400–500 — body, control labels, secondary copy
- 11px / 1.0 / weight 800 / `letter-spacing: 0.04em` / uppercase — kickers

Hierarchy comes from scale and weight contrast (≥1.25 ratio between steps).
Kickers are `--accent`; section titles are `--ink`; body and labels are
`--ink` or `--muted` by role.

Body line length capped at 65–75ch.

## Layout

- **Board**: horizontal-scrolling project rows. Each row contains session
  cards. Following the niri philosophy, the row scrolls rather than wraps.
- **Settings**: currently a 2-column grid stacking keymap, theme, chat
  typography. This is the surface being revamped. Target shape: a single
  scannable column or a sidebar-plus-detail layout that respects the
  scroll-don't-stack principle.
- **Radius scale**: 10px on interactive controls (buttons, selects, inputs),
  20px on container panels. No square corners, no pill radii on rectangles.
- **Elevation**: one step. `box-shadow: inset 0 0 0 1px var(--line), 0 10px
  30px color-mix(in oklab, var(--ink) 10%, transparent)` for panels. Heavier
  shadow for floating dialogs only.

Spacing is varied for rhythm. Same padding everywhere reads as monotony; the
settings page currently suffers from this.

## Components

- **Panel**: rounded surface with inset hairline + soft shadow. Default
  padding 14px, 20px radius.
- **Kicker + title**: uppercase accent-colored kicker over an ink title.
  The primary section-opener pattern across the app.
- **KeySelect**: label + native `<select>`, used for keymap and theme
  controls. Native select is intentional — it keeps the keyboard model
  obvious and avoids reimplementing a focus trap.
- **Session dialog**: scrim + centered form, runtime/model/thinking-level
  selects in a 3-column grid, escape to dismiss.
- **Command palette**: ⌘K / Ctrl+K, fuzzy filter over registered actions,
  keyboard navigation only.

## Motion

- Transitions on `transform`, `border-color`, `background-color`, and `color`
  only. Never animate CSS layout properties (`width`, `height`, `padding`,
  `top`/`left`).
- Duration 160ms.
- Easing `cubic-bezier(0.2, 0, 0, 1)` (ease-out-quart). No bounce, no
  elastic, no overshoot.
- Pressed states scale to 0.96 on `:active`.
- Honor `prefers-reduced-motion: reduce` by collapsing duration to 0ms and
  removing transforms.

## Anti-patterns flagged in the current codebase

These are the things the settings revamp should fix:

1. **2-column grid with 3 panels** — one panel hangs awkwardly on the second
   row. Layout asymmetry without intent.
2. **Identical radius and shadow on intro and panels** — no hierarchy
   between page-opener and content sections; everything floats at the same
   altitude.
3. **Keymap as a wall of 8 selects** — no grouping (board nav vs. session
   actions vs. focus), no preview of what the shortcut actually does.
4. **Theme panel is two dropdowns** — no swatch row, no preview, no way to
   try a theme before committing.
5. **Chat typography panel** has one control, padded to occupy a full
   section. The information density is wrong.
6. **Settings hero** repeats the KIRI wordmark for a settings page; the
   "Back to board" button is the actual primary affordance and isn't styled
   to read as one.
