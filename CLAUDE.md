# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Shaunzen (sh4unn.github.io/shaunzen) is a collection of standalone HTML tools — no build system, no framework, no npm. Each file is self-contained: CSS in `<style>`, JS in `<script>`, deployed directly to GitHub Pages.

## Development

Open files directly in a browser, or serve locally with:
```
python3 -m http.server 8080
```

There are no tests, no linting tools, no CI. Correctness is verified by opening the page in a browser.

## Adding a new tool

1. Create a new `.html` file following the page template below.
2. Add a card to `index.html` above the `<!-- ADD NEW CARDS ABOVE THIS LINE -->` comment — use the "Add a Tool" generator on the page itself to produce the snippet.
3. Add to the service worker cache list in `sw.js` (once created).

## Theme & design system

Every page uses the same CSS variables and fonts. Do not deviate.

**Fonts (Google Fonts):**
- `'New Rocker', cursive` — headings (`h1`) only
- `'Spectral', serif` — body text
- `'IBM Plex Mono', monospace` — labels, data, monospace UI

**Font link (copy exactly):**
```html
<link href="https://fonts.googleapis.com/css2?family=New+Rocker&family=Spectral:ital,wght@0,300;0,400;1,300;1,400&family=IBM+Plex+Mono:wght@300;400&display=swap" rel="stylesheet">
```

**CSS variables (canonical set — copy into every `:root`):**
```css
:root {
  --bg:#f0f4f5; --surface:#e4ecee; --surface2:#dde7ea;
  --border:#c0ced2; --slate:#bfcbce;
  --ink:#1a2628; --muted:#4a6068; --faint:#8fa0a5;
  --accent:#2a5a6a; --accent-light:#3a7a8c; --accent-faint:#e0ecf0;
  --warm:#c45e2a; --gold:#8a6a20; --green:#3a6a2a; --red:#7a2020; --purple:#5a3a7a;
  --cream:#f0f4f5; --parchment:#e4ecee; --teal:#2a5a6a; --teal-light:#3a7a8c; --teal-faint:#e0ecf0;
  --burnt:#c45e2a; --burnt-faint:#f5ede8;
}
```

`--cream`, `--parchment`, `--teal`, `--burnt` are legacy aliases for old pages — keep them so existing CSS doesn't break.

**Accent colours per tool** (for headers/highlights, deviate from `--accent` when the tool has its own identity):
- Cardiac Surgery: `--warm` (`#c45e2a`, orange)
- Drug Reference: `--rust` (`#7a3a1a`)
- Shaun's Ledger: `--purple` (`#5a3a7a`)
- Shaun's Commonplace: `--gold` (`#8a6a20`)
- RS3 Hiscores: `--gold`

## Page template

Every sub-page must include these three structural elements:

```html
<!-- 1. Fixed home button (top-left, always visible) -->
<a class="home-btn" href="index.html">← Home</a>

<!-- 2. Header -->
<div class="header">
  <div class="header-label">Category label</div>
  <h1>Tool Name</h1>  <!-- New Rocker font -->
  <div class="header-sub">Short description</div>
</div>

<!-- 3. Breadcrumb footer (inside </body>, after </main>) -->
<div style="background:var(--surface);border-top:1px solid var(--border);padding:0.75rem 1.5rem;font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:0.08em;color:var(--faint);text-align:center;">
  <a href="index.html" style="color:var(--accent);text-decoration:none;">Home</a> &rsaquo; Tool Name
</div>
```

Standard home-btn CSS:
```css
.home-btn { position:fixed; top:1rem; left:1rem; z-index:100; background:var(--accent); color:white; text-decoration:none; font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:0.15em; text-transform:uppercase; padding:0.5rem 0.9rem; border-radius:2px; transition:background 0.2s; }
.home-btn:hover { background:var(--accent-light); }
```

## GitHub save pattern

Tools that persist data to the repo use this pattern (see `shaunswatch.html` as the reference implementation):

- **Token/repo keys** are namespaced per tool (e.g. `scrolls_token`/`scrolls_repo`, `fc_token`/`fc_repo`) — a GitHub PAT with `contents: write`
- **Save flow:** GET the file SHA first (if it exists), then PUT with `{message, content: btoa(JSON), sha}` to `https://api.github.com/repos/{repo}/contents/{path}`
- **Data files** live in named subfolders: `watch/`, `ledger/`, `scrolls/` etc.
- Settings panels always explain to the user where the token comes from and that it's stored locally only.

## Public APIs used

| Tool | API | Notes |
|------|-----|-------|
| Drug Reference | OpenFDA `https://api.fda.gov/drug/label.json` | No key. AU names differ — map noradrenaline→norepinephrine, paracetamol→acetaminophen, etc. |
| Book Recommender | OpenLibrary `https://openlibrary.org/search.json` | No key. Covers: `https://covers.openlibrary.org/b/id/{cover_i}-M.jpg` |
| Shaun's Ledger | OpenLibrary (same) | Live search with debounce |
| RS3 Hiscores | Jagex hiscores API via CORS proxy | Proxy needed — see `rs3-hiscores.html` |

## Files

| File | Purpose |
|------|---------|
| `index.html` | Home page — tool grid, koan display, card generator |
| `shaunswatch.html` | Watch journal — tabs (Write/Entries/Settings), GitHub save |
| `shauns-commonplace.html` | Commonplace book — quotes, tags, GitHub save |
| `shauns-ledger.html` | Book tracker — OpenLibrary search, star rating, GitHub save |
| `drug-reference.html` | Drug lookup — OpenFDA, rust/navy theme, no API key |
| `book-recommender.html` | Book recommendations — OpenLibrary search, Goodreads CSV upload |
| `rs3-hiscores.html` | RuneScape 3 hiscore lookup |
| `cardiac-surgery-reference.html` | Clinical reference — offline-friendly |
| `sql-dojo.html` | SQL practice — in-browser SQLite via sql.js |
| `daily-tracker.html` | Habit/daily tracking |
| `lean-season.html` | Calorie/nutrition tracking |
| `qigong.html` | Qigong practice guide |
| `shauns-scrolls.html` | Quick notes — Write/Scrolls/Settings tabs, GitHub save to `scrolls/{id}.json` |
| `study-flashcards.html` | Flashcards — Study/Decks/Create/Settings tabs, flip animation, GitHub save to `flashcards/{slug}.json` |
| `manifest.json` | PWA manifest — theme colour, icons, standalone display |
| `sw.js` | Service worker — cache-first for all HTML, updates in background |
| `ledger/books.json` | Persisted book data |
| `watch/` | Persisted watch entries |
| `scrolls/` | Persisted scroll entries (one JSON per scroll) |
| `flashcards/` | Persisted flashcard decks (one JSON per deck, slugified name) |
