# Nothing Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `nothing` theme to the Team Memory dashboard, make it the default, and demote the four existing themes to a "Legacy" group inside the theme picker.

**Architecture:** Pure frontend cosmetic addition — no backend, no API, no schema changes. Theme registers through the existing `data-theme` attribute system (`themes.css` token block + structural overrides). Default-theme behavior moves into `theme-init.js`. Theme picker modal renders Legacy themes under a separator. Login page is refactored from inline-styles to consuming the same `themes.css` variable contract. Knowledge graph (`graph.js`) reads its colors from CSS variables instead of hardcoded hex.

**Tech Stack:** Plain HTML/CSS/JS (no framework), Google Fonts (Onest, JetBrains Mono, Pixelify Sans), `force-graph` (canvas, hardcoded colors today). Build = `tsc + cpy` static copy. Dev loop = `npm run dev:watch` keeps `dist/web/public/` in sync; running server on `http://localhost:3846/`.

**Spec:** [`docs/superpowers/specs/2026-04-16-nothing-theme-design.md`](../specs/2026-04-16-nothing-theme-design.md)

---

## Pre-flight

- [ ] **Step P.1: Confirm working directory and clean tree**

Run: `cd d:/MCP/team-memory-mcp && git status --short`
Expected: only `?? docs/` (the spec/plan we just wrote). No other modifications.

- [ ] **Step P.2: Create feature branch**

Run:
```bash
cd d:/MCP/team-memory-mcp
git checkout -b feat/nothing-theme
```
Expected: `Switched to a new branch 'feat/nothing-theme'`.

- [ ] **Step P.3: Start dev:watch in background** (so CSS edits flow into `dist/`)

Run (in a separate terminal or `run_in_background`):
```bash
cd d:/MCP/team-memory-mcp && npm run dev:watch
```
Leave running. Subsequent visual checks assume the server at `http://localhost:3846` is up. If the server is not running, start it: `node dist/index.js`.

---

## Task 1: Add Google Fonts import + Nothing token block to `themes.css`

**Files:**
- Modify: `src/web/public/themes.css` (top of file + new theme block before `STRUCTURAL OVERRIDES` section, around line 126)

- [ ] **Step 1.1: Add the new font @import at the top of `themes.css`**

Open `src/web/public/themes.css`. After the existing `@import` block (line 5) and before `/* === BRUTALIST THEME === */` (line 7), add a new `@import`:

```css
@import url('https://fonts.googleapis.com/css2?family=Onest:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@300;400;500;700&family=Pixelify+Sans:wght@400;500;600;700&display=swap');
```

- [ ] **Step 1.2: Insert the Nothing token block**

After the `[data-theme="dashboard"] { ... }` closing brace (line 125) and before the blank line preceding `/* STRUCTURAL OVERRIDES */`, add:

```css
/* ============================================
   NOTHING THEME
   ============================================ */
[data-theme="nothing"] {
  --bg-primary:        #000000;
  --bg-secondary:      #111111;
  --bg-tertiary:       #1A1A1A;
  --bg-hover:          #222222;
  --text-primary:      #E8E8E8;
  --text-secondary:    #999999;
  --text-muted:        #666666;
  --border-color:      #222222;
  --accent-primary:    #D71921;
  --accent-hover:      #B0141B;
  --success:           #4A9E5C;
  --warning:           #D4A843;
  --danger:            #D71921;
  --priority-low:      #666666;
  --priority-medium:   #5B9BF6;
  --priority-high:     #D4A843;
  --priority-critical: #D71921;
  --radius-sm: 0px;
  --radius-md: 0px;
  --radius-lg: 2px;
  --shadow:    none;
  --font-primary: 'Onest', system-ui, sans-serif;
  --font-heading: 'Onest', system-ui, sans-serif;
  --font-mono:    'JetBrains Mono', 'IBM Plex Mono', monospace;
  --font-display: 'Pixelify Sans', 'Onest', sans-serif;
}
```

- [ ] **Step 1.3: Verify dev:watch copied the file**

Run: `ls -la d:/MCP/team-memory-mcp/dist/web/public/themes.css`
Expected: file exists with recent mtime. If `dev:watch` is not running, run `npm run copy-static` once.

- [ ] **Step 1.4: Apply the theme manually in browser to confirm tokens load**

In browser DevTools console at `http://localhost:3846`:
```js
document.documentElement.dataset.theme = 'nothing';
```
Expected: page background turns OLED black `#000`, text becomes `#E8E8E8` light gray, all primary buttons / accents render in `#D71921` red. Cards still have rounded corners and shadows because structural overrides aren't in yet — that's the next task. No console errors. Cyrillic text should already render in Onest (no system-font fallback flash).

- [ ] **Step 1.5: Commit**

```bash
cd d:/MCP/team-memory-mcp
git add src/web/public/themes.css
git commit -m "feat(theme): add Nothing color tokens and font import"
```

---

## Task 2: Add structural overrides for Nothing (cards, buttons, badges)

**Files:**
- Modify: `src/web/public/themes.css` — append a new section after the `[data-theme="dashboard"]` overrides (around line 399, after the `dashboard` `.sidebar` rule)

- [ ] **Step 2.1: Append Nothing structural overrides**

Add the following block in `themes.css`, immediately after the `dashboard` overrides section (between line 399 and line 401, before the `/* THEME MODAL & BUTTON STYLES */` comment around line 401):

```css
/* --- Nothing: structural overrides --- */
[data-theme="nothing"] body {
  background-color: #000000;
  background-image: radial-gradient(circle, #1A1A1A 1px, transparent 1px);
  background-size: 16px 16px;
  background-attachment: fixed;
}

[data-theme="nothing"] .entry-card {
  border: 1px solid var(--border-color);
  border-radius: 2px;
  background: var(--bg-secondary);
  box-shadow: none;
}

[data-theme="nothing"] .entry-card:hover {
  border-color: #444444;
  transform: none;
  box-shadow: none;
}

[data-theme="nothing"] .entry-badge {
  border-radius: 0;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-family: var(--font-mono);
  font-size: 11px;
  border: 1px solid currentColor;
  background: transparent;
}

[data-theme="nothing"] .entry-tag {
  border-radius: 0;
  font-family: var(--font-mono);
  text-transform: lowercase;
  letter-spacing: 0.04em;
}

[data-theme="nothing"] .filter-pill {
  border-radius: 0;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 11px;
}

[data-theme="nothing"] .filter-pill.active {
  background: var(--accent-primary);
  color: #000000;
  border-color: var(--accent-primary);
}

[data-theme="nothing"] .domain-pill,
[data-theme="nothing"] .domain-pill.active {
  border-radius: 0;
  font-family: var(--font-mono);
}

[data-theme="nothing"] .domain-pill.active {
  background: var(--accent-primary);
  color: #000000;
}

[data-theme="nothing"] .modal-content {
  border: 1px solid var(--border-color);
  border-radius: 0;
  box-shadow: none;
}

[data-theme="nothing"] .btn {
  border-radius: 0;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 12px;
}

[data-theme="nothing"] .btn-primary,
[data-theme="nothing"] .btn-add {
  background: transparent;
  border: 1px solid var(--accent-primary);
  color: var(--accent-primary);
}

[data-theme="nothing"] .btn-primary:hover,
[data-theme="nothing"] .btn-add:hover {
  background: var(--accent-primary);
  color: #000000;
}

[data-theme="nothing"] .btn-secondary {
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-primary);
}

[data-theme="nothing"] .btn-secondary:hover {
  border-color: var(--text-primary);
}

[data-theme="nothing"] input,
[data-theme="nothing"] textarea,
[data-theme="nothing"] select,
[data-theme="nothing"] .custom-select-trigger {
  border-radius: 0;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
}

[data-theme="nothing"] input:focus,
[data-theme="nothing"] textarea:focus,
[data-theme="nothing"] .custom-select-trigger:focus {
  border-color: var(--accent-primary);
  box-shadow: none;
  outline: none;
}

[data-theme="nothing"] .custom-select-options {
  border-radius: 0;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  box-shadow: none;
}

[data-theme="nothing"] .nav-item.active {
  background: transparent;
  border-left: 3px solid var(--accent-primary);
  color: var(--text-primary);
}

[data-theme="nothing"] .nav-item.active .nav-icon,
[data-theme="nothing"] .nav-item.active .nav-count {
  color: var(--text-primary);
}

[data-theme="nothing"] .header,
[data-theme="nothing"] .sidebar {
  border-color: var(--border-color);
  background: #000000;
}

[data-theme="nothing"] .toast {
  border-radius: 0;
  background: var(--bg-secondary);
  border-left: 3px solid var(--text-secondary);
}

[data-theme="nothing"] .toast.success { border-left-color: var(--success); }
[data-theme="nothing"] .toast.warning { border-left-color: var(--warning); }
[data-theme="nothing"] .toast.error   { border-left-color: var(--accent-primary); }

[data-theme="nothing"] .theme-row.active,
[data-theme="nothing"] .theme-row.selected {
  border-color: var(--accent-primary);
  background: rgba(215, 25, 33, 0.06);
}
```

- [ ] **Step 2.2: Browser check**

Reload `http://localhost:3846` in browser, then in DevTools console:
```js
document.documentElement.dataset.theme = 'nothing';
```
Expected:
- Body background = OLED black with subtle dot-matrix grid (16px spacing).
- Entry cards: square corners, thin gray border, no shadow.
- Sidebar nav active item: red left bar, transparent background.
- Primary "Add" button: red border, transparent fill, red text. Hover = red fill, black text.
- Filter pills, badges, btns are ALL CAPS in JetBrains Mono.
- Modal background fully opaque, square edges.

- [ ] **Step 2.3: Commit**

```bash
cd d:/MCP/team-memory-mcp
git add src/web/public/themes.css
git commit -m "feat(theme): add Nothing structural overrides (cards, buttons, badges, nav)"
```

---

## Task 3: Add display typography for hero numbers and logo

**Files:**
- Modify: `src/web/public/themes.css` — append after Nothing structural overrides (within the same section)

- [ ] **Step 3.1: Append display-font rules**

Append to the end of the `[data-theme="nothing"]` overrides block in `themes.css`:

```css
[data-theme="nothing"] .stat-value,
[data-theme="nothing"] .page-title,
[data-theme="nothing"] .logo-text {
  font-family: var(--font-display);
  letter-spacing: -0.02em;
  font-weight: 600;
}

[data-theme="nothing"] .logo-text {
  -webkit-text-fill-color: var(--text-primary);
  background: none;
  background-clip: initial;
  -webkit-background-clip: initial;
}
```

(The `.logo-text` reset overrides any gradient text-fill from inherited base styles.)

- [ ] **Step 3.2: Browser check**

Reload, set `data-theme="nothing"`. Expected:
- Logo text "Team Memory" rendered in Pixelify Sans (visibly pixelated).
- Page title (e.g. "Все записи") rendered in Pixelify Sans.
- Stat values on dashboard (numeric counters) rendered in Pixelify Sans.
- All other text remains Onest.

- [ ] **Step 3.3: Commit**

```bash
cd d:/MCP/team-memory-mcp
git add src/web/public/themes.css
git commit -m "feat(theme): apply Pixelify Sans display font to logo, page title, and stats"
```

---

## Task 4: Update `theme-init.js` — whitelist Nothing and make it the default

**Files:**
- Modify: `src/web/public/theme-init.js` (entire file, 7 lines)

- [ ] **Step 4.1: Replace file contents**

Open `src/web/public/theme-init.js` and replace the entire content with:

```js
// Theme initialization — runs synchronously before CSS to prevent flash.
// Default theme: 'nothing'. Existing users keep their previously chosen theme.
(function() {
  var t = localStorage.getItem('tm-theme');
  var valid = ['nothing', 'brutalist', 'gazette', 'sport', 'dashboard'];
  document.documentElement.dataset.theme =
    (t && valid.indexOf(t) !== -1) ? t : 'nothing';
})();
```

- [ ] **Step 4.2: Browser check**

In DevTools console:
```js
localStorage.removeItem('tm-theme');
location.reload();
```
Expected: page loads in Nothing theme automatically (OLED black, dot-matrix grid). No console errors. `document.documentElement.dataset.theme === 'nothing'`.

- [ ] **Step 4.3: Backward-compat check**

```js
localStorage.setItem('tm-theme', 'sport');
location.reload();
```
Expected: page loads in Sport theme — existing users keep their selection.

- [ ] **Step 4.4: Commit**

```bash
cd d:/MCP/team-memory-mcp
git add src/web/public/theme-init.js
git commit -m "feat(theme): default to Nothing theme; keep legacy theme persistence"
```

---

## Task 5: Update THEMES array in `app.js` — add Nothing, mark legacy, drop `default`

**Files:**
- Modify: `src/web/public/app.js:67-98`

- [ ] **Step 5.1: Replace the THEMES array**

Open `src/web/public/app.js`. Locate the `THEMES` array (lines 66-98). Replace lines 66-98 with:

```js
// Theme configuration — Nothing is the canonical default. Others remain selectable but rendered under a "LEGACY" divider.
const THEMES = [
  {
    id: 'nothing',
    name: 'Nothing',
    desc: 'OLED-чёрная типографическая, сигнальный красный',
    colors: { bg: '#000000', sidebar: '#000000', sidebarBorder: '1px solid #222', accent: '#D71921', line1: '#222', line2: '#D71921', line3: '#1A1A1A', line4: '#1A1A1A' }
  },
  {
    id: 'brutalist',
    name: 'Brutalist',
    desc: 'Жёсткий геометричный стиль, толстые рамки',
    legacy: true,
    colors: { bg: '#F8F6F1', sidebar: '#fff', sidebarBorder: '3px solid #111', accent: '#D42B2B', line1: '#D8D4CC', line2: '#D42B2B', line3: '#EDEAE4', line4: '#EDEAE4' }
  },
  {
    id: 'gazette',
    name: 'Gazette',
    desc: 'Газетный editorial-стиль, тёплые тона',
    legacy: true,
    colors: { bg: '#F6F1E9', sidebar: '#FAF7F1', sidebarBorder: '2px solid #2A241C', accent: '#8B2020', line1: '#D4C9B8', line2: '#8B2020', line3: '#E2D9CA', line4: '#E2D9CA' }
  },
  {
    id: 'sport',
    name: 'Sport',
    desc: 'Тёмный спортивный с неоновым акцентом',
    legacy: true,
    colors: { bg: '#0A0A0A', sidebar: '#161616', sidebarBorder: '1px solid #3A3A3A', accent: '#CCFF00', line1: '#3A3A3A', line2: '#CCFF00', line3: '#1C1C1C', line4: '#1C1C1C' }
  },
  {
    id: 'dashboard',
    name: 'Dashboard',
    desc: 'Aurora-градиенты, тёплые и холодные тона',
    legacy: true,
    colors: { bg: '#07070B', sidebar: '#0D0D14', sidebarBorder: '1px solid rgba(255,255,255,0.05)', accent: '#FF8C42', line1: '#2A2A34', line2: 'linear-gradient(90deg, #FF8C42, #FF3B6C)', line3: '#15151E', line4: '#15151E' }
  }
];
```

- [ ] **Step 5.2: Browser check**

Reload `http://localhost:3846`, click the theme button (top of header), open the modal. Expected: 5 theme rows visible. Nothing is first. Other 4 still display with their normal previews. No console errors. (No legacy divider yet — that comes in Task 6.)

- [ ] **Step 5.3: Commit**

```bash
cd d:/MCP/team-memory-mcp
git add src/web/public/app.js
git commit -m "feat(theme): register Nothing as primary theme; flag others as legacy"
```

---

## Task 6: Update `openThemeModal()` to render Legacy section divider

**Files:**
- Modify: `src/web/public/app.js:2224-2249` (the `openThemeModal()` function — render block)

- [ ] **Step 6.1: Replace the render logic**

In `src/web/public/app.js`, locate `function openThemeModal()` (around line 2224). Find the line:

```js
  list.innerHTML = THEMES.map(t => `
    <div class="theme-row ${t.id === current ? 'active' : ''}" data-theme-id="${t.id}">
      ${renderThemePreview(t.colors)}
      <div class="theme-info">
        <div class="theme-name">${t.name}</div>
        <div class="theme-desc">${t.desc}</div>
      </div>
      <div class="theme-check">\u2713</div>
    </div>
  `).join('');
```

Replace it with:

```js
  const renderRow = (t) => `
    <div class="theme-row ${t.id === current ? 'active' : ''} ${t.legacy ? 'legacy' : ''}" data-theme-id="${t.id}">
      ${renderThemePreview(t.colors)}
      <div class="theme-info">
        <div class="theme-name">
          ${t.name}
          ${t.legacy ? '<span class="theme-legacy-badge">LEGACY</span>' : ''}
        </div>
        <div class="theme-desc">${t.desc}</div>
      </div>
      <div class="theme-check">\u2713</div>
    </div>
  `;

  const primary = THEMES.filter(t => !t.legacy);
  const legacy = THEMES.filter(t => t.legacy);

  list.innerHTML = primary.map(renderRow).join('')
    + (legacy.length ? '<div class="theme-section-divider">LEGACY THEMES</div>' : '')
    + legacy.map(renderRow).join('');
```

- [ ] **Step 6.2: Browser check (no CSS yet)**

Reload, open theme modal. Expected: Nothing on top, then a plain text "LEGACY THEMES" divider, then the 4 legacy rows. The divider and `LEGACY` badge will be unstyled until Task 7. Functionally clicks still apply themes correctly.

- [ ] **Step 6.3: Commit**

```bash
cd d:/MCP/team-memory-mcp
git add src/web/public/app.js
git commit -m "feat(theme): render legacy themes under a section divider in the picker"
```

---

## Task 7: Add CSS for legacy divider and `LEGACY` badge

**Files:**
- Modify: `src/web/public/themes.css` — append to the `THEME MODAL & BUTTON STYLES` section (after line 537, end of file)

- [ ] **Step 7.1: Append divider and badge styles**

Append to the very end of `src/web/public/themes.css`:

```css
/* Legacy theme section divider (universal — applies to all themes) */
.theme-section-divider {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--text-muted);
  text-transform: uppercase;
  padding: 14px 12px 6px;
  margin-top: 8px;
  border-top: 1px solid var(--border-color);
}

.theme-legacy-badge {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 6px;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.1em;
  color: var(--text-muted);
  border: 1px solid var(--border-color);
  border-radius: 2px;
  vertical-align: middle;
  text-transform: uppercase;
}

.theme-row.legacy {
  opacity: 0.6;
  transition: opacity 0.15s;
}

.theme-row.legacy:hover,
.theme-row.legacy.active,
.theme-row.legacy.selected {
  opacity: 1;
}
```

- [ ] **Step 7.2: Browser check**

Reload, open theme modal. Expected:
- "LEGACY THEMES" divider rendered in mono caps, muted color, with a thin top border.
- Each legacy row has a `LEGACY` pill badge next to its name.
- Legacy rows appear at 60% opacity until hover or selection.
- Nothing row is full opacity, no badge.

- [ ] **Step 7.3: Commit**

```bash
cd d:/MCP/team-memory-mcp
git add src/web/public/themes.css
git commit -m "feat(theme): style legacy section divider and LEGACY badges in picker"
```

---

## Task 8: Add `data-theme="nothing"` fallback to `index.html` and bump cache buster

**Files:**
- Modify: `src/web/public/index.html` (the opening `<html>` tag, plus the `themes.css` link)

- [ ] **Step 8.1: Locate and modify `<html>` and stylesheet link**

Open `src/web/public/index.html`. Find line 1-2 (the `<html>` opening tag) and line 10 (the `themes.css` link).

Change `<html lang="ru">` to:
```html
<html lang="ru" data-theme="nothing">
```

Change line 10 from:
```html
  <link rel="stylesheet" href="themes.css?v=1">
```
To:
```html
  <link rel="stylesheet" href="themes.css?v=2">
```

(`theme-init.js` will overwrite `data-theme` from `localStorage` synchronously — so existing users still see their saved theme. The fallback only matters when JS fails or for the brief pre-JS paint frame.)

- [ ] **Step 8.2: Browser check**

In DevTools: `localStorage.removeItem('tm-theme'); location.reload();`. Expected: zero flash of unstyled content — page paints directly to OLED black with no white flash.

- [ ] **Step 8.3: Commit**

```bash
cd d:/MCP/team-memory-mcp
git add src/web/public/index.html
git commit -m "feat(theme): set Nothing as html fallback theme; bump themes.css cache buster"
```

---

## Task 9: Refactor `login.html` to consume themes.css

**Files:**
- Modify: `src/web/public/login.html` (entire `<head>` section — replace inline `<style>`)

- [ ] **Step 9.1: Replace inline `<style>` with `themes.css` + page-specific rules**

Open `src/web/public/login.html`. Replace lines 1-194 (`<!DOCTYPE html>` through the closing `</style>` tag) with:

```html
<!DOCTYPE html>
<html lang="ru" data-theme="nothing">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Team Memory - Login</title>
  <link rel="icon" type="image/svg+xml" href="favicon.svg">
  <script src="theme-init.js"></script>
  <link rel="stylesheet" href="themes.css?v=2">
  <style>
    /* Login page — base layout. Colors / fonts come from themes.css via CSS variables. */
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--font-primary, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      background: var(--bg-primary, #0f0f0f);
      color: var(--text-primary, #f5f5f5);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .login-container { width: 100%; max-width: 400px; padding: 24px; }

    .login-card {
      background: var(--bg-secondary, #1a1a1a);
      border: 1px solid var(--border-color, #333);
      border-radius: var(--radius-lg, 16px);
      padding: 40px 32px;
      box-shadow: var(--shadow, 0 4px 20px rgba(0, 0, 0, 0.3));
    }

    .login-logo { text-align: center; margin-bottom: 32px; }
    .login-logo img { width: 64px; height: 64px; margin-bottom: 12px; }
    .login-logo h1 {
      font-family: var(--font-display, var(--font-heading, inherit));
      font-size: 22px;
      font-weight: 600;
      color: var(--text-primary, #f5f5f5);
      letter-spacing: -0.02em;
    }
    .login-logo p {
      font-size: 13px;
      color: var(--text-secondary, #a0a0a0);
      margin-top: 4px;
    }

    .form-group { margin-bottom: 20px; }
    .form-group label {
      display: block;
      font-size: 11px;
      font-family: var(--font-mono, monospace);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-secondary, #a0a0a0);
      margin-bottom: 6px;
    }
    .form-group input {
      width: 100%;
      padding: 10px 14px;
      background: var(--bg-tertiary, #252525);
      border: 1px solid var(--border-color, #333);
      border-radius: var(--radius-md, 0);
      color: var(--text-primary, #f5f5f5);
      font-size: 14px;
      font-family: var(--font-mono, 'SF Mono', monospace);
      transition: border-color 0.2s;
    }
    .form-group input:focus { outline: none; border-color: var(--accent-primary, #6366f1); }
    .form-group input::placeholder { color: var(--text-muted, #666); }

    .login-btn {
      width: 100%;
      padding: 12px;
      background: transparent;
      border: 1px solid var(--accent-primary, #6366f1);
      border-radius: var(--radius-md, 0);
      color: var(--accent-primary, #6366f1);
      font-size: 12px;
      font-family: var(--font-mono, sans-serif);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .login-btn:hover {
      background: var(--accent-primary, #6366f1);
      color: var(--bg-primary, #000);
    }
    .login-btn:disabled { opacity: 0.6; cursor: not-allowed; }

    .login-error {
      margin-top: 12px;
      padding: 10px 14px;
      background: rgba(215, 25, 33, 0.08);
      border: 1px solid var(--accent-primary, #ef4444);
      border-left: 3px solid var(--accent-primary, #ef4444);
      border-radius: var(--radius-md, 0);
      color: var(--accent-primary, #ef4444);
      font-size: 13px;
      display: none;
    }

    .login-agent-name {
      margin-top: 12px;
      padding: 10px 14px;
      background: rgba(74, 158, 92, 0.08);
      border: 1px solid var(--success, #4A9E5C);
      border-left: 3px solid var(--success, #4A9E5C);
      border-radius: var(--radius-md, 0);
      color: var(--success, #4A9E5C);
      font-size: 13px;
      display: none;
      text-align: center;
    }

    .login-hint {
      margin-top: 20px;
      font-size: 11px;
      font-family: var(--font-mono, monospace);
      color: var(--text-muted, #666);
      text-align: center;
      line-height: 1.6;
    }

    .login-divider {
      display: flex;
      align-items: center;
      margin: 20px 0;
      gap: 12px;
      color: var(--text-muted, #666);
      font-size: 11px;
      font-family: var(--font-mono, monospace);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .login-divider::before,
    .login-divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--border-color, #333);
    }

    .login-viewer-btn {
      width: 100%;
      padding: 10px;
      background: transparent;
      border: 1px solid var(--border-color, #333);
      border-radius: var(--radius-md, 0);
      color: var(--text-secondary, #a0a0a0);
      font-size: 12px;
      font-family: var(--font-mono, sans-serif);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      cursor: pointer;
      transition: border-color 0.2s, color 0.2s;
    }
    .login-viewer-btn:hover {
      border-color: var(--text-primary, #fff);
      color: var(--text-primary, #fff);
    }

    /* Nothing-specific: dot-matrix on login background too */
    [data-theme="nothing"] body {
      background-color: #000000;
      background-image: radial-gradient(circle, #1A1A1A 1px, transparent 1px);
      background-size: 16px 16px;
    }
  </style>
</head>
```

(The `<body>` content from line 195 onwards stays intact — only the `<head>` block changes.)

- [ ] **Step 9.2: Browser check on login page**

Visit `http://localhost:3846/login` (or `/login.html`). Expected:
- OLED black background with dot-matrix grid.
- "Team Memory" title in Pixelify Sans (visibly pixelated).
- Form label "API TOKEN" in mono caps.
- Input has square corners.
- "ВОЙТИ" button: red border, transparent fill, mono caps. Hover = red fill, black text.
- No console errors.

Then test in DevTools: `localStorage.setItem('tm-theme','sport'); location.reload();`. Expected: login flips to Sport theme (volt-yellow accent). Confirms the theme system works on login too.

Reset for next steps: `localStorage.removeItem('tm-theme'); location.reload();`.

- [ ] **Step 9.3: Commit**

```bash
cd d:/MCP/team-memory-mcp
git add src/web/public/login.html
git commit -m "feat(theme): refactor login.html to consume themes.css variables"
```

---

## Task 10: Verify `chat.js` requires no changes

**Files:**
- Inspect: `src/web/public/chat.js` (179 lines, no hardcoded colors found in audit)

- [ ] **Step 10.1: Confirm `chat.js` has no hardcoded colors or inline styles**

Run via Grep tool with pattern `style=|cssText|background:|color:|#[0-9A-Fa-f]{3,}` against `src/web/public/chat.js`. Expected: zero matches. (We already audited this in the design phase.)

- [ ] **Step 10.2: Visual smoke test**

Open the chat panel (whatever UI element triggers it on the dashboard) under Nothing theme. Expected: chat bubbles automatically use `--bg-secondary`, `--text-primary`, etc. — they look square, OLED-black, no shadows.

If chat reveals hardcoded styles unexpectedly, file a small note for a follow-up task — do NOT add them in this iteration unless they're visually broken.

- [ ] **Step 10.3: No commit needed (no code changes)**

---

## Task 11: Make `graph.js` theme-aware — read colors from CSS variables

**Files:**
- Modify: `src/web/public/graph.js:168` (the `.backgroundColor()` call) and surrounding canvas-style hardcoded values
- Modify: `src/web/public/graph.js:172-180` (the tooltip HTML that uses inline styles)
- Modify: `src/web/public/graph.js:195-280` (canvas rendering hardcoded colors)

- [ ] **Step 11.1: Add a `getThemeColors()` helper at the top of `graph.js`**

Open `src/web/public/graph.js`. After the existing `EDGE_COLORS` constant (around line 22), add:

```js
// Read theme-driven colors from the document's computed style.
// Called at graph init and on theme changes.
function getThemeColors() {
  const style = getComputedStyle(document.documentElement);
  const read = (name, fallback) => (style.getPropertyValue(name).trim() || fallback);
  return {
    bg:           read('--bg-primary',   '#0f0f0f'),
    surface:      read('--bg-secondary', '#1a1a1a'),
    border:       read('--border-color', '#333333'),
    textPrimary:  read('--text-primary', '#e5e5e5'),
    textMuted:    read('--text-muted',   '#666666'),
    accent:       read('--accent-primary', '#6366f1'),
  };
}
```

- [ ] **Step 11.2: Replace the hardcoded `.backgroundColor('#0f0f0f')` call**

Locate line 168 (or thereabouts) where the graph is initialized:
```js
.backgroundColor('#0f0f0f')
```
Replace with:
```js
.backgroundColor(getThemeColors().bg)
```

- [ ] **Step 11.3: Replace the hardcoded tooltip styles**

Locate lines 173-178 (tooltip HTML template) — currently:
```js
return `<div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:8px 12px;max-width:300px;font-family:sans-serif">
  <div style="font-weight:600;font-size:13px;color:#f5f5f5;margin-bottom:4px">${escapeHtml(entry.title)}</div>
  <div style="font-size:11px;color:#999">
    <span style="color:${CATEGORY_COLORS[entry.category] || '#999'};font-weight:500">${categoryLabel(entry.category)}</span>
    ${entry.domain ? `<span style="color:#666;margin-left:8px">${escapeHtml(entry.domain)}</span>` : ''}
  </div>`;
```
Replace with:
```js
const themeColors = getThemeColors();
return `<div style="background:${themeColors.surface};border:1px solid ${themeColors.border};border-radius:2px;padding:8px 12px;max-width:300px;font-family:var(--font-primary, sans-serif)">
  <div style="font-weight:600;font-size:13px;color:${themeColors.textPrimary};margin-bottom:4px">${escapeHtml(entry.title)}</div>
  <div style="font-size:11px;color:${themeColors.textMuted}">
    <span style="color:${CATEGORY_COLORS[entry.category] || themeColors.textMuted};font-weight:500">${categoryLabel(entry.category)}</span>
    ${entry.domain ? `<span style="color:${themeColors.textMuted};margin-left:8px">${escapeHtml(entry.domain)}</span>` : ''}
  </div>`;
```

- [ ] **Step 11.4: Replace canvas-render hardcoded text/highlight colors**

Locate the canvas-rendering callbacks (around lines 195-280). Replace specific hardcoded values:

| Line(s) (approx) | Old | New |
|---|---|---|
| ~200 | `ctx.strokeStyle = '#06b6d4'` | `ctx.strokeStyle = getThemeColors().accent` |
| ~206 | `ctx.strokeStyle = '#06b6d4'` | `ctx.strokeStyle = getThemeColors().accent` |
| ~218 | `ctx.fillStyle = dimmed ? '#33333320' : '#e5e5e5'` | `const tc = getThemeColors(); ctx.fillStyle = dimmed ? tc.border + '20' : tc.textPrimary` |
| ~228 | `return '#ffffff08'` | `return getThemeColors().border + '40'` (dimmed link color from theme border) |
| ~246 | `.linkDirectionalParticleColor(() => '#6366f1')` | `.linkDirectionalParticleColor(() => getThemeColors().accent)` |
| ~280 | `ctx.fillStyle = '#ffffff18'` | `ctx.fillStyle = getThemeColors().textMuted + '30'` |

Apply each replacement in turn (use Read to confirm exact line numbers before editing). The pattern is: cache `const tc = getThemeColors();` once at the top of any callback that uses 2+ colors, then reference `tc.<name>`.

- [ ] **Step 11.5: Browser check on graph page**

Open the knowledge graph view in the dashboard. Expected:
- Graph canvas background = OLED black.
- Tooltip uses `--bg-secondary` (`#111`) with thin border, square corners.
- Selected node highlight is signal-red (`#D71921`) instead of cyan.
- Link particles are red.
- CATEGORY_COLORS (purple/blue/green/red/orange) preserved — these are semantic, not theme-driven.

- [ ] **Step 11.6: Commit**

```bash
cd d:/MCP/team-memory-mcp
git add src/web/public/graph.js
git commit -m "feat(theme): make graph.js read colors from CSS variables"
```

---

## Task 12: Wire graph re-paint on theme change

**Files:**
- Modify: `src/web/public/graph.js` — expose a `applyGraphTheme()` callback
- Modify: `src/web/public/app.js` — invoke graph theme refresh inside `applyTheme()` (find existing function near `THEMES` array)

- [ ] **Step 12.1: Inspect existing `applyTheme()` in app.js**

Run Grep on `src/web/public/app.js` for `function applyTheme` to locate the function. Read its body — it likely sets `data-theme` and writes to `localStorage`.

- [ ] **Step 12.2: Add a public theme-refresh method to graph.js**

In `src/web/public/graph.js`, find where the graph instance is stored (likely a top-level `let graph` or similar variable assigned from `ForceGraph()(container)`). At the end of the file (or near the graph init), add:

```js
// Public hook: re-apply theme colors to the live graph instance.
// Called from app.js when the user picks a new theme.
window.refreshGraphTheme = function() {
  if (typeof graph === 'undefined' || !graph) return;
  const tc = getThemeColors();
  graph.backgroundColor(tc.bg);
  // Force a repaint so node/link callbacks re-read theme colors:
  if (typeof graph.refresh === 'function') graph.refresh();
  else if (typeof graph._destructor !== 'undefined') {
    // ForceGraph re-paints automatically on next tick — nudge it.
    graph.nodeColor(graph.nodeColor());
  }
};
```

(If graph instance is named differently — `g`, `forceGraph`, `gInstance` — adapt the variable name. Use Grep to find `ForceGraph(` or `.nodeColor(` in `graph.js` to confirm.)

- [ ] **Step 12.3: Call the hook from `applyTheme()` in app.js**

In `src/web/public/app.js`, locate the `applyTheme()` function. After it sets `data-theme` and persists to `localStorage`, append:

```js
  // Notify graph (if loaded) to re-read theme colors
  if (typeof window.refreshGraphTheme === 'function') {
    window.refreshGraphTheme();
  }
```

- [ ] **Step 12.4: Browser check**

With graph view open, switch theme via the modal from Nothing → Sport → Nothing. Expected: graph background and node highlight colors update without page reload. No console errors. (If the canvas doesn't re-paint live, accept it — tooltips and next interactions will pick up new colors anyway. Note this in the validation report.)

- [ ] **Step 12.5: Commit**

```bash
cd d:/MCP/team-memory-mcp
git add src/web/public/graph.js src/web/public/app.js
git commit -m "feat(theme): re-paint knowledge graph on theme change"
```

---

## Task 13: Final validation pass

- [ ] **Step 13.1: Clear localStorage, hard reload**

In DevTools at `http://localhost:3846`:
```js
localStorage.removeItem('tm-theme');
location.reload(true);
```
Expected: page renders in Nothing theme from first paint. No white flash. No console errors.

- [ ] **Step 13.2: Walk through every page**

For each of these pages, verify Nothing styling is consistent (square corners, dot-matrix bg, mono caps labels, red signal accent):
1. `/` — main dashboard (entries grid)
2. `/login` — login page
3. Open theme picker modal — verify Nothing on top, "LEGACY THEMES" divider, 4 muted legacy rows with `LEGACY` badges
4. Open chat panel (if accessible)
5. Open knowledge graph view
6. Open the entry-edit modal (click any card)
7. Open the projects modal (sidebar → projects)

- [ ] **Step 13.3: Switch themes round-trip**

In modal, switch to each theme: Brutalist → Gazette → Sport → Dashboard → Nothing. Each should apply cleanly with no console errors. Verify Nothing → Sport → Nothing leaves no visual residue (e.g., stale Pixelify font on logo when switching back to Sport).

- [ ] **Step 13.4: Final commit if any tweaks made**

If any small fixes were applied during validation:
```bash
cd d:/MCP/team-memory-mcp
git add -A
git commit -m "fix(theme): post-validation tweaks for Nothing"
```

- [ ] **Step 13.5: Push branch**

(Skip if user wants to review locally first — confirm with user before pushing.)

```bash
cd d:/MCP/team-memory-mcp
git push -u origin feat/nothing-theme
```

---

## Summary of File Changes

| File | Change |
|---|---|
| `src/web/public/themes.css` | + Google Fonts import; + Nothing token block + structural overrides + display typography; + legacy divider/badge CSS |
| `src/web/public/theme-init.js` | Whitelist Nothing; default to Nothing |
| `src/web/public/app.js` | THEMES array (Nothing first, legacy flag on others); openThemeModal renders divider + LEGACY badges; applyTheme calls graph refresh hook |
| `src/web/public/index.html` | `<html data-theme="nothing">`; `themes.css?v=2` |
| `src/web/public/login.html` | Refactored from inline styles to themes.css consumption |
| `src/web/public/chat.js` | No changes (verified clean) |
| `src/web/public/graph.js` | `getThemeColors()` helper; replaced hardcoded canvas / tooltip colors; `window.refreshGraphTheme` hook |

## Self-Review Notes

- **Spec coverage:** every section of the spec is mapped to at least one task (§3 design language → tasks 1-3; §4 fonts → task 1; §5 tokens → task 1; §6 structural → tasks 2-3; §7.1 dashboard → task 8; §7.2 login → task 9; §7.3 chat → task 10; §7.4 graph → tasks 11-12; §8 legacy → tasks 5-7; §10 validation → task 13).
- **No placeholders:** every step has either exact code or an exact command + expected outcome.
- **Type consistency:** function names match across tasks (`getThemeColors`, `window.refreshGraphTheme`). The `legacy: true` flag introduced in Task 5 is consumed in Task 6 (filter) and Task 7 (CSS class).
- **Risk acknowledged:** Task 11.4 line-number table is approximate — engineer must Read graph.js to confirm before editing. This is called out explicitly.
