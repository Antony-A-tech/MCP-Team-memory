# Nothing Theme — Design Spec

**Date:** 2026-04-16
**Status:** Approved (pending implementation)
**Owner:** Antony Nozhenko

## 1. Goal

Add a fifth visual theme `nothing` to the Team Memory MCP web dashboard,
inspired by the Nothing brand design language
([dominikmartn/nothing-design-skill](https://github.com/dominikmartn/nothing-design-skill)).
Make it the default theme; demote the four existing themes (`brutalist`,
`gazette`, `sport`, `dashboard`) to a "Legacy" group inside the theme picker
modal — still selectable, but visually subordinate.

## 2. Non-goals

- No backend changes (no API, no DB, no config keys).
- No new dependencies beyond Google Fonts links.
- No removal of legacy themes from disk — only demotion in UI.
- No changes to MCP protocol behavior, auth, or tools.
- No theme switching at the per-user / per-agent level on the server side
  (theme remains a `localStorage` client-side concern, as today).

## 3. Design Language Summary

Adapted from Nothing's "instrument panel in a dark room" aesthetic:

- **Mood:** OLED black, monochrome, typographic, industrial.
- **Surfaces:** Pure black background (`#000`), elevated surfaces are barely
  lifted (`#111`, `#1A1A1A`).
- **Typography hierarchy:** display (pixelated) > heading (grotesk) > label
  (mono ALL CAPS) > body (grotesk).
- **Accent:** Single warm coral `#D77554` (originally `#D71921` red — swapped
  per user direction during implementation; commit `3c3040a`). Used for
  primary actions, destructive operations, critical priority badges, and
  "live" indicators. Used sparingly (canon: one per screen as a UI element).
- **Decoration:** Dot-matrix grid background as ambient texture; no shadows,
  no gradients, no rounded corners (radii = 0 or 2px max).
- **Motion:** Opacity transitions only (`cubic-bezier(0.25, 0.1, 0.25, 1)`,
  150–250ms). No springs, no scale, no slide.

## 4. Cyrillic-Compatible Font Substitutions

Original Nothing fonts lack Cyrillic. We replace each with the closest
Google-Fonts-hosted analog that supports Cyrillic Extended:

| Role | Original (Nothing) | Substitute (this spec) | Rationale |
|---|---|---|---|
| Display | `Doto` | **Pixelify Sans** | Pixel/dot-matrix aesthetic, full Cyrillic support |
| Body / UI | `Space Grotesk` | **Onest** | Geometric grotesk explicitly designed as an open Cyrillic-first alternative |
| Data / Labels | `Space Mono` | **JetBrains Mono** | Monospaced, mature Cyrillic glyphs |

All three are loaded via a single `@import` from Google Fonts at the top of
`themes.css`.

## 5. Color Tokens

Mapped onto the existing CSS-variable contract used by all other themes
(`--bg-primary`, `--text-primary`, `--accent-primary`, etc.):

```css
[data-theme="nothing"] {
  /* Surfaces */
  --bg-primary:        #000000;            /* OLED black */
  --bg-secondary:      #111111;            /* Cards, modals */
  --bg-tertiary:       #1A1A1A;            /* Inputs, secondary surfaces */
  --bg-hover:          #222222;            /* Hover states */

  /* Text */
  --text-primary:      #E8E8E8;            /* Body text */
  --text-secondary:    #999999;            /* Labels, captions */
  --text-muted:        #666666;            /* Disabled, decoration */

  /* Borders */
  --border-color:      #222222;            /* Subtle dividers */

  /* Warm coral — single accent (was signal red #D71921, swapped per user) */
  --accent-primary:    #D77554;
  --accent-hover:      #B85F40;

  /* Status — calibrated to Nothing palette */
  --success:           #4A9E5C;
  --warning:           #D4A843;
  --danger:            #D77554;            /* Same as accent — errors ARE the accent */

  /* Priority — same palette */
  --priority-low:      #666666;
  --priority-medium:   #5B9BF6;
  --priority-high:     #D4A843;
  --priority-critical: #D71921;

  /* Geometry */
  --radius-sm: 0px;
  --radius-md: 0px;
  --radius-lg: 2px;                         /* 2px max, intentionally mechanical */
  --shadow:     none;                       /* No shadows in Nothing */

  /* Typography stack */
  --font-primary: 'Onest', system-ui, sans-serif;
  --font-heading: 'Onest', system-ui, sans-serif;
  --font-mono:    'JetBrains Mono', 'IBM Plex Mono', monospace;
  --font-display: 'Pixelify Sans', 'Onest', sans-serif;  /* New variable */
}
```

The `--font-display` variable is new (not present in other themes). Other
themes will simply inherit the cascade and continue using their `--font-heading`.

## 6. Structural Overrides

These go in the same `themes.css` after the token block. Mirrors how
`sport` / `dashboard` already extend their themes.

### 6.1. Dot-matrix ambient background

```css
[data-theme="nothing"] body {
  background-color: #000000;
  background-image: radial-gradient(circle, #1A1A1A 1px, transparent 1px);
  background-size: 16px 16px;
  background-attachment: fixed;
}
```

Subtle (1px dots on 16px grid, low contrast) so it never competes with content.

### 6.2. Cards, badges, pills

- All `.entry-card`, `.modal-content`, `.btn`, `.filter-pill`, `.entry-tag`,
  `.entry-badge` — `border-radius: 0` (or `2px` for `.entry-card`).
- Entry cards: `border: 1px solid var(--border-color)`, no shadow, hover =
  border brightens to `#444`, no transform.
- Badges: ALL CAPS, `font-family: var(--font-mono)`, `letter-spacing: 0.08em`,
  `font-size: 11px`.

### 6.3. Display typography for hero numbers

Apply Pixelify Sans only to large display elements (≥36px), per Nothing canon:

```css
[data-theme="nothing"] .stat-value,
[data-theme="nothing"] .page-title,
[data-theme="nothing"] .logo-text {
  font-family: var(--font-display);
  letter-spacing: -0.02em;
}
```

`.logo-text` ("Team Memory") becomes pixelated — strongly evokes the brand.

### 6.4. Sidebar nav items

- Active item: left-border `3px solid var(--accent-primary)` instead of
  background fill. Background stays `transparent`. Icon and text inherit
  primary text color (no red text — only the bar is red).

### 6.5. Buttons

- `.btn-primary` / `.btn-add`: `background: transparent`,
  `border: 1px solid var(--accent-primary)`, `color: var(--accent-primary)`.
  Hover: filled `--accent-primary` background, black text.
- `.btn-secondary`: transparent, `border: 1px solid var(--border-color)`,
  text `--text-primary`.

### 6.6. Inputs & selects

- `background: var(--bg-tertiary)`, `border: 1px solid var(--border-color)`,
  `border-radius: 0`. Focus = `border-color: var(--accent-primary)`, no glow.
- Custom-select dropdown styled the same way.

### 6.7. Modals

- `border: 1px solid var(--border-color)`, `border-radius: 0`, no shadow,
  no backdrop blur. Backdrop = `rgba(0,0,0,0.85)`.

### 6.8. Toasts

- Square corners, `background: var(--bg-secondary)`, left-border 3px in the
  status color (success/warning/error).

## 7. Coverage — All Pages

### 7.1. `index.html` (main dashboard)
- Add `data-theme="nothing"` to `<html>` as fallback for FOUC-free first paint.
- All other CSS already cascades through theme variables — no markup changes.

### 7.2. `login.html`
- Currently uses inline `<style>` with hardcoded colors. Refactor to:
  - Pull in `theme-init.js` and `themes.css?v=2`.
  - Replace hardcoded colors with the same `var(--bg-primary)` etc. tokens.
  - Login page becomes themed automatically; under `nothing` it shows
    OLED-black background with dot-matrix grid, pixel-font logo, signal-red
    "Войти" button.

### 7.3. `chat.js` UI
- Audit the chat-bubble DOM nodes generated by `chat.js`. Confirm they consume
  `var(--bg-secondary)`, `var(--text-primary)`, etc. If any color is hardcoded
  in JS-generated styles, replace with CSS classes that reference theme
  variables.
- Add Nothing-specific overrides if any chat element needs square-cornering
  or label-style timestamps.

### 7.4. `graph.js` (knowledge graph)
- Cytoscape (or whichever graph lib) is configured in JS. We add theme-aware
  configuration: nodes use `var(--bg-tertiary)` fill,
  `var(--border-color)` stroke, edges `var(--text-muted)`, selected nodes get
  `var(--accent-primary)` stroke. Read these via `getComputedStyle` at init
  and on theme-change event.
- Graph background: pick up dot-matrix grid via canvas-level setting if the
  lib supports it; otherwise leave to body background showing through.

## 8. Theme Picker Modal — Legacy Demotion

### 8.1. Data model change in `app.js:67-98`

```js
const THEMES = [
  { id: 'nothing',   name: 'Nothing',   desc: 'Тёмная типографическая, OLED + сигнальный красный',
    colors: { bg: '#000000', sidebar: '#000000', sidebarBorder: '1px solid #222', accent: '#D71921',
              line1: '#222', line2: '#D71921', line3: '#1A1A1A', line4: '#1A1A1A' } },
  // legacy: true marks themes shown under separator
  { id: 'brutalist', name: 'Brutalist', desc: '...', legacy: true, colors: {...} },
  { id: 'gazette',   name: 'Gazette',   desc: '...', legacy: true, colors: {...} },
  { id: 'sport',     name: 'Sport',     desc: '...', legacy: true, colors: {...} },
  { id: 'dashboard', name: 'Dashboard', desc: '...', legacy: true, colors: {...} },
];
```

The `default` entry is removed (Nothing replaces it as the canonical default).

### 8.2. Render logic

`renderThemeList()` renders Nothing first, then a section divider
`<div class="theme-section-divider">LEGACY THEMES</div>` (small ALL CAPS label
in `--text-muted`), then the four legacy themes. Each legacy `.theme-row` gets
a `LEGACY` badge in mono font next to its name and reduced opacity until hover.

### 8.3. Default-theme behavior

`theme-init.js`:
```js
(function() {
  var t = localStorage.getItem('tm-theme');
  var valid = ['nothing','brutalist','gazette','sport','dashboard'];
  document.documentElement.dataset.theme =
    (t && valid.indexOf(t) !== -1) ? t : 'nothing';
})();
```

So a fresh user gets `nothing`. Existing users with a legacy theme in
`localStorage` keep what they had — no surprise migration.

## 9. File Inventory

| File | Action |
|---|---|
| `src/web/public/themes.css` | Add `@import` for new fonts; add `[data-theme="nothing"]` token block + structural overrides |
| `src/web/public/theme-init.js` | Add `nothing` to whitelist; default to `nothing` when localStorage empty |
| `src/web/public/app.js` | Replace `default` THEMES entry with `nothing`; add `legacy: true` to other 4; update `renderThemeList()` to render with section divider + LEGACY badges; add CSS for divider/badge to `themes.css` |
| `src/web/public/index.html` | Add `data-theme="nothing"` to `<html>`; bump CSS cache-buster `themes.css?v=2` |
| `src/web/public/login.html` | Add `<script src="theme-init.js">`, `<link rel="stylesheet" href="themes.css">`, refactor inline `<style>` to use theme variables |
| `src/web/public/chat.js` | Audit hardcoded colors; replace with class-based styling consuming theme vars |
| `src/web/public/graph.js` | Audit graph styling config; read theme variables via `getComputedStyle`; subscribe to theme-change |
| `src/web/public/styles.css` | Possibly add the new `--font-display` to `:root` defaults so it doesn't error in non-Nothing themes |

## 10. Validation Plan

After implementation, manually verify in browser:

1. Fresh visit (clear `localStorage`) → loads with Nothing theme automatically.
2. Open theme modal → Nothing on top, "LEGACY" divider, 4 legacy themes below
   with `LEGACY` badges and reduced opacity.
3. Switch to `brutalist` → existing theme still works exactly as before
   (no regressions).
4. Switch back to `nothing` → cards have square corners, dot-matrix background
   visible, primary buttons are red-bordered transparent, logo-text rendered
   in Pixelify Sans, all Cyrillic text renders in Onest (no system-font
   fallback flash).
5. Login page → same OLED-black aesthetic, signal-red login button, pixel-font
   logo.
6. Chat panel → square bubbles, mono timestamps, theme colors throughout.
7. Knowledge graph → theme colors applied to nodes/edges; switching theme
   re-paints graph without reload (or on next interaction, if no live event
   wiring is feasible).
8. No console errors. No layout shifts on theme switch.

## 11. Open Risks / Notes

- **Cyrillic in Pixelify Sans:** confirmed available as of Google Fonts'
  2023 update. Verify on first load that Cyrillic glyphs render and don't
  fall back. If they do — swap `--font-display` to `Onest 800` as a safe
  alternative (still bold/large, just not pixel).
- **Dot-matrix grid + scrolling:** `background-attachment: fixed` works well
  on desktop but can be janky on mobile. Acceptable — dashboard is desktop-first.
- **Graph theming:** cytoscape configurations may not pick up CSS variable
  changes on theme switch without manual re-style. Live theme-change in graph
  may require an explicit `graph.applyTheme()` callback bound to the modal's
  apply-button.
- **Legacy themes will not be deleted in this iteration.** A follow-up can
  remove them entirely once user confirms Nothing covers all needs.
