# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Shaunzen (shaunzen.com, GitHub Pages) is a launcher: one `index.html` with Work / Life / Systems tiles linking to Shaun's services. No build system, no framework, no npm. The old standalone tools (trackers, notes, references, books) were removed in Nov 2026 — don't recreate them. `books.html` and `training.html` are the exceptions: read-only views of private data (book register, Garmin sync), not editing tools.

The repo is PUBLIC. Never commit personal data, tokens, or private notes. Services that need privacy live on their own subdomain behind Cloudflare Access (`home.`, `energy.`, `terminal.`).

## Development

Open files directly in a browser, or serve locally with:
```
python3 -m http.server 8080
```

There are no tests, no linting tools, no CI. Correctness is verified by opening the page in a browser.

## Adding a link

Copy a `tool-card` line in `index.html` into the right section (Work / Life / Systems). Add `<span class="lock">locked</span>` inside `.card-meta` if the target sits behind Cloudflare Access. New local pages also go in the `ASSETS` list in `sw.js` (bump `CACHE`).

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

## Subdomains

| Host | What | How |
|------|------|-----|
| `shaunzen.com` | This launcher | GitHub Pages, Cloudflare DNS |
| `home.shaunzen.com` | Home Assistant | Nabu Casa |
| `energy.shaunzen.com` | Energy dashboard | Cloudflare Access |
| `terminal.shaunzen.com` | Web terminal on EC2 `claude-code-server` (Sydney) | ttyd on 127.0.0.1:7681 → Cloudflare Tunnel → Cloudflare Access. ttyd rejects requests without `Cf-Access-Authenticated-User-Email` |
| `api.shaunzen.com` | Live data for the launcher | Worker `shaunzen-api` (`workers/api/worker.js`), KV `shaunzen-api-state`, behind Access (plus JWT check in the worker). `/agent/*` is an Access bypass authenticated by the `AGENT_SECRET` bearer |

## Live data (signed-in only)

The launcher is static and public. Everything live comes from `api.shaunzen.com` via `fetch(..., {credentials:'include'})`; signed-out visitors just see the sign-in link.

- `GET /summary` — status dots, tile details, mini HA dash, current book (from the book register; Hardcover only as a fallback), inbox count. Cached 60s in KV.
- `GET /books` — data for `books.html`: now reading (Kindle %), Claude's weekly picks, stats, recently finished, up next. Built from `books.json`, `reading-log.json` and `recommendations.md` in the private `sh4unn/book-register` repo (read with `GITHUB_TOKEN`), cached 5 min in KV. The register updates when Shaun plugs in the Kindle (weekly) and pushes to GitHub; the picks update every Monday.
- `GET /training` — data for `training.html`: `training.json` from the private `sh4unn/garmin-training` repo (var `TRAINING_REPO`), passed through as-is and cached 10 min in KV. A nightly GitHub Action there pulls Garmin Connect (activities, resting HR, HRV, sleep; no GPS). The page does all the analysis (gaps, missing session types, fitness/fatigue, build-back ramp). `training.html?demo` renders made-up data. `GITHUB_TOKEN` needs read-only Contents on that repo too.
- `/finance/*` — data for `finance.html` (Vanguard Super, Vanguard Personal Investor, Macquarie). `GET /finance/summary` returns monthly totals only (balances, contributions, growth inputs, spending by category, budgets, merchants to review, upload log); no transactions or account numbers ever reach the worker in plain text. `POST /finance/upload?type=…` takes an export the page has already encrypted in the browser with the server's RSA public key (`GET /finance/pubkey`; envelope `SZF1`, see the comment in `worker.js`), stored as `fin:up:<id>` for at most 14 days. `POST /finance/budgets` and `POST /finance/categories` queue the page's edits. `finance.html?demo` renders made-up numbers.
- `/agent/finance/*` — the EC2 server's side of the above, authenticated with its own `FINANCE_SECRET` bearer (not `AGENT_SECRET`): `GET inbox` (queued uploads, budgets, confirmed categories in one read), `GET upload/<id>`, `POST done`, `POST categories-ack`, `PUT summary`, `PUT pubkey`. The server decrypts, parses and keeps raw files and the database on its own disk; only the summary comes back.
- `POST /inbox` — capture box. Origin must be `https://shaunzen.com`. Body is plain text.
- `/agent/heartbeat`, `/agent/inbox`, `/agent/ack` — called every minute by `shaunzen-agent` on the EC2 server (`server/install-agent.sh`). It writes captured notes to `~ec2-user/inbox.md`.
- `/agent/shifts` — Teams Shifts as a subscribable calendar. A work Power Automate flow (hourly) POSTs the "List all shifts" output with `Authorization: Bearer <SHIFTS_PUSH_TOKEN>`; calendar apps subscribe to `/agent/shifts/<SHIFTS_FEED_TOKEN>.ics` (`.json` gives current/next shift for HA). One KV key `shifts`, written only on change. Secrets `SHIFTS_PUSH_TOKEN`, `SHIFTS_FEED_TOKEN`; vars `SHIFTS_USER_ID` (keeps just Shaun's shifts) and `SHIFTS_LOCATION` (address or "lat, long"), both dashboard only. Times are Brisbane local (AEST, no DST); unnamed shifts are titled "Work"; identical shifts (same start, end, name) show once.
- Mini HA dash entities live in the `DASH` array in `workers/api/worker.js`. Look up IDs in `~/GitHub/HomeAssistant/entities/register.md`.
- Optional worker secrets, set in the Cloudflare dashboard (never commit them): `HA_TOKEN` (HA long-lived token), `GITHUB_TOKEN` (fine-grained PAT, read-only Contents on `sh4unn/book-register`), `HARDCOVER_TOKEN` (legacy fallback). Optional var `BOOKS_REPO` overrides the repo.
- Deploying the worker: push to `main`. Cloudflare Workers Builds deploys `workers/api` with `npx wrangler deploy`, using `workers/api/wrangler.jsonc` (bindings STATE KV, AI, vars TEAM, AUD, HA_URL, SITE_ORIGIN). Secrets stay in the dashboard. Don't upload by hand: the next push would overwrite it. Change bindings or vars in `wrangler.jsonc`, not the dashboard.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Launcher — status strip, koan, Work/Life/Systems tiles, capture box, mini HA dash, ⌘K search |
| `training.html` | Training page — static shell; data from `api.shaunzen.com/training` after sign-in (no training data in this public repo) |
| `finance.html` | Finance page — static shell; data from `api.shaunzen.com/finance/summary` after sign-in; uploads encrypted in the browser (no financial data in this public repo) |
| `books.html` | Reading page — static shell; all data comes from `api.shaunzen.com/books` after sign-in (no reading data in this public repo) |
| `workers/api/worker.js` | Source of the `api.shaunzen.com` worker |
| `server/finance/` | finance-sync for `finance.html`: decrypts uploads, parses Macquarie/Vanguard exports, publishes monthly summaries (see its README). Code only; data lives on the server under `~ec2-user/finance` |
| `server/install-agent.sh` | Installs heartbeat/inbox agent + terminal home-screen tags on the EC2 server |
| `manifest.json` | PWA manifest |
| `sw.js` | Service worker — caches the launcher shell |
| `.well-known/appspecific/com.tesla.3p.public-key.pem` | Tesla Fleet API public key — must stay |
| `CNAME` | `shaunzen.com` |
