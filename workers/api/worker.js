// api.shaunzen.com — live data for the shaunzen.com launcher.
//
// Every route except /agent/* sits behind Cloudflare Access (your email only);
// the worker also verifies the Access JWT itself. /agent/* is an Access bypass
// used by the EC2 server, authenticated with the AGENT_SECRET bearer token.
//
// Bindings: STATE (KV). Vars: TEAM, AUD, HA_URL, SITE_ORIGIN.
// Secrets: AGENT_SECRET (set at deploy), HA_TOKEN, GITHUB_TOKEN, HARDCOVER_TOKEN, READ_LATER_TOKEN
// and KINDLE_UPLOAD_TOKEN
// (optional, add them in the Cloudflare dashboard; tiles show "connect" hints until then).
// GITHUB_TOKEN: fine-grained, read-only Contents on the private book-register repo
// (var BOOKS_REPO, default sh4unn/book-register). It feeds /books and the Reading tile.
// With Contents: Read and write it also lets the Reading page add books (POST /books/add).
// AI binding (Workers AI) turns a loose description into a book for /books/resolve.

// Mini HA dash: read-only. Each item: [label, entity_id, kind]. kind picks the formatter
// on the site (power, pct, temp, lock, onoff, problem, mbps, ms, presence, text).
// Find entity IDs in ~/GitHub/HomeAssistant/entities/register.md.
const DASH = [
  { group: 'Home', items: [
    ['Shaun', 'person.shaun_cheeseman', 'presence'],
    ['Front door', 'lock.front_door_lock', 'lock'],
    ['Back door', 'lock.back_door_lock', 'lock'],
    ['Aircon', 'climate.lounge_room_aircon', 'climate'],
    ['Bathroom', 'sensor.temp_sensor_bathroom_temperature', 'temp'],
  ]},
  { group: 'Energy', items: [
    ['Solar', 'sensor.sig_solar_power', 'power'],
    ['Home load', 'sensor.sig_home_power', 'power'],
    ['Battery', 'sensor.sig_battery_soc', 'pct'],
    ['Battery flow', 'sensor.sig_battery_power', 'power'],
    ['Grid', 'sensor.sig_grid_power', 'power'],
  ]},
  { group: 'Starlink', items: [
    ['Online', 'binary_sensor.starlink_connectivity', 'onoff'],
    ['Ping', 'sensor.starlink_ping', 'ms'],
    ['Drop rate', 'sensor.starlink_ping_drop_rate', 'pct'],
    ['Down', 'sensor.starlink_downlink_throughput', 'mbps'],
    ['Up', 'sensor.starlink_uplink_throughput', 'mbps'],
    ['Obstructed', 'binary_sensor.starlink_obstructed', 'problem'],
    ['Power', 'sensor.starlink_power', 'power'],
  ]},
  { group: 'Rome', items: [
    ['Battery', 'sensor.garage_rome_battery_level', 'pct'],
    ['Charging', 'sensor.garage_rome_charging', 'text'],
    ['Locked', 'lock.garage_rome_lock', 'lock'],
    ['Cabin', 'sensor.garage_rome_inside_temperature', 'temp'],
    ['Outside', 'sensor.garage_rome_outside_temperature', 'temp'],
  ]},
];
// The server posts a heartbeat every minute, but KV's free tier allows only 1,000 writes a day, so a heartbeat
// is stored only when something changed or the stored one is HEARTBEAT_WRITE_S old (≤ ~150 writes a day).
const HEARTBEAT_WRITE_S = 600;
const HEARTBEAT_STALE_S = 900;
const CACHE_S = 60;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/agent/read-later') return await readLater(req, env);
      if (url.pathname === '/agent/add-book') return await addBookLine(req, env);
      if (url.pathname === '/agent/kindle-upload') return await kindleUpload(req, env);
      if (url.pathname.startsWith('/agent/')) return await agent(req, env, url);

      const who = await verifyAccess(req, env);
      if (!who) return new Response('Unauthorized', { status: 401 });

      if (url.pathname === '/login') {
        const next = url.searchParams.get('next') || env.SITE_ORIGIN + '/';
        return Response.redirect(next.startsWith(env.SITE_ORIGIN + '/') ? next : env.SITE_ORIGIN + '/', 302);
      }
      if (req.method === 'GET' && url.pathname === '/summary') return cors(env, json(await summary(env)));
      if (req.method === 'GET' && url.pathname === '/books') return cors(env, json(await books(env)));
      if (req.method === 'POST' && (url.pathname === '/books/resolve' || url.pathname === '/books/add')) {
        if (req.headers.get('Origin') !== env.SITE_ORIGIN) return new Response('Bad origin', { status: 403 });
        let body;
        try { body = JSON.parse(await req.text()); } catch { return cors(env, json({ error: 'bad json' }, 400)); }
        const out = url.pathname === '/books/resolve' ? await resolveBook(env, body) : await addBook(env, body, who);
        return cors(env, json(out, out.error ? 400 : 200));
      }
      if (url.pathname === '/feeds') {
        if (req.method === 'GET') return cors(env, json(await listFeeds(env)));
        if (req.method === 'POST') {
          if (req.headers.get('Origin') !== env.SITE_ORIGIN) return new Response('Bad origin', { status: 403 });
          let body;
          try { body = JSON.parse(await req.text()); } catch { return cors(env, json({ error: 'bad json' }, 400)); }
          const out = await followFeed(env, body);
          return cors(env, json(out, out.error ? 400 : 200));
        }
      }
      if (url.pathname === '/inbox') {
        if (req.method === 'GET') return cors(env, json(await listInbox(env)));
        if (req.method === 'POST') {
          if (req.headers.get('Origin') !== env.SITE_ORIGIN) return new Response('Bad origin', { status: 403 });
          const text = (await req.text()).trim().slice(0, 4000);
          if (!text) return cors(env, json({ error: 'empty' }, 400));
          const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
          await env.STATE.put(`inbox:${id}`, JSON.stringify({ id, text, at: new Date().toISOString(), by: who }));
          return cors(env, json({ ok: true, id }));
        }
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return cors(env, json({ error: String(e && e.message || e) }, 500));
    }
  },
};

// ---------- Access JWT ----------
let certCache = { at: 0, keys: null };
async function verifyAccess(req, env) {
  const token = req.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const header = JSON.parse(b64urlText(h));
  const payload = JSON.parse(b64urlText(p));
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(env.AUD)) return null;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  if (payload.iss !== `https://${env.TEAM}.cloudflareaccess.com`) return null;
  if (!certCache.keys || Date.now() - certCache.at > 3600e3) {
    const r = await fetch(`https://${env.TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`);
    certCache = { at: Date.now(), keys: (await r.json()).keys };
  }
  const jwk = certCache.keys.find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
  return ok ? (payload.email || 'unknown') : null;
}
function b64urlBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}
function b64urlText(s) { return new TextDecoder().decode(b64urlBytes(s)); }

// ---------- Agent (EC2 server) ----------
async function agent(req, env, url) {
  const auth = req.headers.get('Authorization') || '';
  if (!env.AGENT_SECRET || !timingSafeEqual(auth, `Bearer ${env.AGENT_SECRET}`)) return new Response('Unauthorized', { status: 401 });
  if (req.method === 'POST' && url.pathname === '/agent/heartbeat') {
    const body = await req.json();
    const hb = {
      at: new Date().toISOString(),
      uptime_s: Number(body.uptime_s) || null,
      load: String(body.load || '').slice(0, 40),
      ttyd: !!body.ttyd,
      tunnel: !!body.tunnel,
      tmux: !!body.tmux,
      claude: !!body.claude,
    };
    const prev = await env.STATE.get('heartbeat', 'json');
    const same = prev && ['ttyd', 'tunnel', 'tmux', 'claude'].every(k => prev[k] === hb[k]);
    if (same && (Date.now() - Date.parse(prev.at)) / 1000 < HEARTBEAT_WRITE_S) return json({ ok: true, stored: false });
    await cachePut(env, 'heartbeat', hb);
    return json({ ok: true, stored: true });
  }
  if (req.method === 'GET' && url.pathname === '/agent/inbox') return json(await listInbox(env));
  if (req.method === 'POST' && url.pathname === '/agent/ack') {
    const { ids } = await req.json();
    await Promise.all((ids || []).slice(0, 100).map(id => env.STATE.delete(`inbox:${id}`)));
    return json({ ok: true });
  }
  return new Response('Not found', { status: 404 });
}
// ---------- Read later (iPhone share sheet → Kindle) ----------
// POST /agent/read-later with "Authorization: Bearer <READ_LATER_TOKEN>" and a body containing a link
// (plain text, or JSON {"url": ...}). Appends it to articles/read-later.txt in the book-register repo;
// that commit triggers the repo's "Articles to Kindle" GitHub Action, which emails it to the Kindle.
// Lives under /agent/ for the existing Cloudflare Access bypass, with its own token (not AGENT_SECRET)
// so the phone never holds the server's secret. Needs GITHUB_TOKEN with Contents: Read and write.
async function readLater(req, env) {
  const auth = req.headers.get('Authorization') || '';
  if (!env.READ_LATER_TOKEN || !timingSafeEqual(auth, `Bearer ${env.READ_LATER_TOKEN}`)) return new Response('Unauthorized', { status: 401 });
  if (req.method !== 'POST') return new Response('POST a link', { status: 405 });
  const body = (await req.text()).slice(0, 4000);
  let link = (body.match(/https?:\/\/[^\s"'<>]+/) || [])[0];
  if (!link) return json({ error: 'no link in the request' }, 400);
  link = link.replace(/[.,)\]]+$/, '');
  const repo = env.BOOKS_REPO || 'sh4unn/book-register';
  const api = `https://api.github.com/repos/${repo}/contents/articles/read-later.txt`;
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'shaunzen-api' };
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(api, { headers });
    if (!r.ok) return json({ error: `GitHub ${r.status} reading read-later.txt` }, 502);
    const file = await r.json();
    const text = new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\n/g, '')), c => c.charCodeAt(0)));
    if (text.split('\n').some(l => l.trim() === link)) return json({ ok: true, already: true });
    const at = text.indexOf('\n# Sent');
    const next = at < 0 ? text.replace(/\n*$/, '\n') + link + '\n' : text.slice(0, at).replace(/\n*$/, '\n') + link + '\n' + text.slice(at);
    const bytes = new TextEncoder().encode(next);
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const put = await fetch(api, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Read later: ${new URL(link).hostname}`, content: btoa(bin), sha: file.sha }),
    });
    if (put.status === 409 || put.status === 422) continue;  // changed underneath us: re-read and retry
    if (!put.ok) return json({ error: `GitHub ${put.status} writing read-later.txt` }, 502);
    return json({ ok: true, queued: link });
  }
  return json({ error: 'read-later.txt kept changing, try again' }, 409);
}

// ---------- Add a book (iPhone Shortcut → register) ----------
// POST /agent/add-book with the same READ_LATER_TOKEN and a body of one line in the "Add books.txt"
// format, e.g. "Dark Matter - Blake Crouch | read 5" (plain text, or JSON {"line": ...}).
// Appends it to inbox.txt in the book-register repo; that commit triggers the repo's "Book inbox"
// GitHub Action, which runs register.py inbox on the EC2 runner and commits books.json.
async function addBookLine(req, env) {
  const auth = req.headers.get('Authorization') || '';
  if (!env.READ_LATER_TOKEN || !timingSafeEqual(auth, `Bearer ${env.READ_LATER_TOKEN}`)) return new Response('Unauthorized', { status: 401 });
  if (req.method !== 'POST') return new Response('POST a line like "Title - Author | read 4"', { status: 405 });
  let raw = (await req.text()).slice(0, 2000);
  try { const j = JSON.parse(raw); if (j && typeof j.line === 'string') raw = j.line; } catch { /* plain text */ }
  const line = raw.split('\n').map(s => s.trim()).find(Boolean)?.replace(/^#+\s*/, '').slice(0, 300);
  if (!line) return json({ error: 'send one line, e.g. "Dark Matter - Blake Crouch | read 5"' }, 400);
  const repo = env.BOOKS_REPO || 'sh4unn/book-register';
  const api = `https://api.github.com/repos/${repo}/contents/inbox.txt`;
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'shaunzen-api' };
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(api, { headers });
    if (!r.ok && r.status !== 404) return json({ error: `GitHub ${r.status} reading inbox.txt` }, 502);
    const file = r.ok ? await r.json() : null;
    const text = file ? new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\n/g, '')), c => c.charCodeAt(0))) : '';
    const at = text.indexOf('\n# Added');
    const next = at < 0 ? text.replace(/\n*$/, text ? '\n' : '') + line + '\n' : text.slice(0, at).replace(/\n*$/, '\n') + line + '\n' + text.slice(at);
    const bytes = new TextEncoder().encode(next);
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const put = await fetch(api, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Book inbox: add a line', content: btoa(bin), ...(file ? { sha: file.sha } : {}) }),
    });
    if (put.status === 409 || put.status === 422) continue;
    if (!put.ok) return json({ error: `GitHub ${put.status} writing inbox.txt` }, 502);
    return json({ ok: true, queued: line });
  }
  return json({ error: 'inbox.txt kept changing, try again' }, 409);
}

// ---------- Kindle reading data over Wi-Fi ----------
// POST /agent/kindle-upload with "Authorization: Bearer <KINDLE_UPLOAD_TOKEN>", sent by the Kindle's
// "Export Reading Data" scriptlet (book-register repo, kindle/). The token lives only on the Kindle.
// Body: JSON {"exported", "rows": [...]} (the cc.db rows register.py reads), or, when the Kindle's sqlite3
// can't make JSON, the whole cc.db (Content-Type application/vnd.sqlite3, stamp in X-Export-Stamp).
// Commits kindle/exports/latest.json (for a db: cc.db first, then a latest.json pointing at it) to the
// book-register repo; that commit triggers its "Kindle sync" GitHub Action, which runs register.py kindle.
// Needs GITHUB_TOKEN with Contents: Read and write.
async function kindleUpload(req, env) {
  const auth = req.headers.get('Authorization') || '';
  if (!env.KINDLE_UPLOAD_TOKEN || !timingSafeEqual(auth, `Bearer ${env.KINDLE_UPLOAD_TOKEN}`)) return new Response('Unauthorized', { status: 401 });
  if (req.method !== 'POST') return new Response('POST the Kindle export', { status: 405 });
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length > 25e6) return json({ error: 'export too large' }, 413);
  let stamp = req.headers.get('X-Export-Stamp') || '';
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(stamp)) stamp = new Date().toISOString().slice(0, 19);
  const sqlite = new TextDecoder().decode(body.subarray(0, 15)) === 'SQLite format 3' && body[15] === 0;
  let pointer;
  if (sqlite) {
    const r = await putRepoFile(env, 'kindle/exports/cc.db', body, `Kindle export ${stamp} (cc.db)`);
    if (r) return r;
    pointer = { exported: stamp, db: 'cc.db' };
  } else {
    try { pointer = JSON.parse(new TextDecoder().decode(body)); } catch { return json({ error: 'body is neither JSON nor a SQLite database' }, 400); }
    if (!pointer || !Array.isArray(pointer.rows)) return json({ error: 'JSON needs a "rows" array' }, 400);
    pointer.exported ||= stamp;
  }
  const text = JSON.stringify(pointer, null, 1) + '\n';
  const r = await putRepoFile(env, 'kindle/exports/latest.json', new TextEncoder().encode(text), `Kindle export ${pointer.exported}`);
  if (r) return r;
  return json({ ok: true, exported: pointer.exported, rows: pointer.rows ? pointer.rows.length : undefined, db: sqlite || undefined });
}

// Create or replace one file in the book-register repo. Returns an error Response, or null when written.
async function putRepoFile(env, path, bytes, message) {
  const repo = env.BOOKS_REPO || 'sh4unn/book-register';
  const api = `https://api.github.com/repos/${repo}/contents/${path}`;
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'shaunzen-api' };
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const content = btoa(bin);
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`${api}?ref=main`, { headers });
    if (!r.ok && r.status !== 404) return json({ error: `GitHub ${r.status} reading ${path}` }, 502);
    const sha = r.ok ? (await r.json()).sha : undefined;
    const put = await fetch(api, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content, branch: 'main', ...(sha ? { sha } : {}) }),
    });
    if (put.status === 409 || put.status === 422) continue;  // changed underneath us: re-read and retry
    if (!put.ok) return json({ error: `GitHub ${put.status} writing ${path}` }, 502);
    return null;
  }
  return json({ error: `${path} kept changing, try again` }, 409);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function listInbox(env) {
  const { keys } = await env.STATE.list({ prefix: 'inbox:' });
  const items = await Promise.all(keys.map(k => env.STATE.get(k.name, 'json')));
  return items.filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
}

// ---------- Summary ----------
async function summary(env) {
  const cached = await env.STATE.get('summary', 'json');
  const hb = await env.STATE.get('heartbeat', 'json');
  let base = cached && Date.now() - cached.t < CACHE_S * 1000 ? cached.v : null;
  if (!base) {
    const [homeUp, energyUp, ha, reading] = await Promise.all([
      probe('https://home.shaunzen.com/manifest.json'),
      probe('https://energy.shaunzen.com/'),
      haStates(env).catch(e => ({ error: String(e.message || e) })),
      currentlyReading(env),
    ]);
    base = { homeUp, energyUp, ha, reading };
    await cachePut(env, 'summary', { t: Date.now(), v: base });
  }
  const fresh = hb && (Date.now() - Date.parse(hb.at)) / 1000 < HEARTBEAT_STALE_S;
  const inbox = (await env.STATE.list({ prefix: 'inbox:' })).keys.length;
  return {
    at: new Date().toISOString(),
    status: {
      server: fresh ? 'up' : hb ? 'down' : 'unknown',
      terminal: fresh ? (hb.ttyd && hb.tunnel ? 'up' : 'down') : hb ? 'down' : 'unknown',
      home: base.homeUp ? 'up' : 'down',
      energy: base.energyUp ? 'up' : 'down',
    },
    terminal: hb ? { claude: !!hb.claude, tmux: !!hb.tmux, last_seen: hb.at, uptime_s: hb.uptime_s, load: hb.load } : null,
    ha: base.ha,
    reading: base.reading,
    inbox_pending: inbox,
  };
}

async function probe(u) {
  try {
    const r = await fetch(u, { redirect: 'manual', cf: { cacheTtl: 0 } });
    return r.status < 500;
  } catch { return false; }
}

async function haStates(env) {
  if (!env.HA_TOKEN) return { needs: 'HA_TOKEN' };
  const r = await fetch(`${env.HA_URL}/api/states`, { headers: { Authorization: `Bearer ${env.HA_TOKEN}` } });
  if (!r.ok) return { error: `HA ${r.status}` };
  const all = new Map((await r.json()).map(s => [s.entity_id, s]));
  return {
    groups: DASH.map(g => ({
      group: g.group,
      items: g.items.map(([label, id, kind]) => {
        const s = all.get(id);
        const bad = !s || ['unavailable', 'unknown'].includes(s.state);
        const v = { label, kind, state: bad ? null : s.state, unit: s?.attributes?.unit_of_measurement || null };
        if (kind === 'climate' && s) v.current = s.attributes?.current_temperature ?? null;
        return v;
      }),
    })),
  };
}

async function currentlyReading(env) {
  if (env.GITHUB_TOKEN) {
    const b = await books(env).catch(() => null);
    if (b && b.reading) {
      return { books: b.reading.map(r => ({ title: r.title, author: r.author, percent: r.percent, url: `${env.SITE_ORIGIN}/books.html` })) };
    }
  }
  if (!env.HARDCOVER_TOKEN) return { needs: 'GITHUB_TOKEN' };
  try {
    const query = `{ me { user_books(where: {status_id: {_eq: 2}}, limit: 3, order_by: {updated_at: desc}) { book { title slug contributions(limit: 1) { author { name } } } } } }`;
    const r = await fetch('https://api.hardcover.app/v1/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: env.HARDCOVER_TOKEN.startsWith('Bearer ') ? env.HARDCOVER_TOKEN : `Bearer ${env.HARDCOVER_TOKEN}` },
      body: JSON.stringify({ query }),
    });
    const d = await r.json();
    const me = Array.isArray(d?.data?.me) ? d.data.me[0] : d?.data?.me;
    return {
      books: (me?.user_books || []).map(ub => ({
        title: ub.book?.title,
        author: ub.book?.contributions?.[0]?.author?.name || null,
        url: ub.book?.slug ? `https://hardcover.app/books/${ub.book.slug}` : null,
      })),
    };
  } catch { return { books: [] }; }
}

// ---------- Books (from the private book-register repo) ----------
const BOOKS_CACHE_S = 300;

async function repoFile(env, path) {
  const repo = env.BOOKS_REPO || 'sh4unn/book-register';
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github.raw+json', 'User-Agent': 'shaunzen-api' },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status} for ${path}`);
  return r.text();
}

async function books(env) {
  if (!env.GITHUB_TOKEN) return { needs: 'GITHUB_TOKEN' };
  const cached = await env.STATE.get('books', 'json');
  if (cached && Date.now() - cached.t < BOOKS_CACHE_S * 1000) return cached.v;
  const [reg, log, recs] = await Promise.all([
    repoFile(env, 'books.json'), repoFile(env, 'reading-log.json'), repoFile(env, 'recommendations.md'),
  ]);
  if (reg === null) {
    // A private repo the token can't see also answers 404, so say so instead of showing an empty library.
    return { error: `GitHub can't see books.json in ${env.BOOKS_REPO || 'sh4unn/book-register'}. Give the GITHUB_TOKEN access to that repo (Contents: Read-only).` };
  }
  const v = summariseBooks(JSON.parse(reg).books, JSON.parse(log || '{}'), recs);
  await cachePut(env, 'books', { t: Date.now(), v });
  return v;
}

function summariseBooks(all, log, recs) {
  const now = new Date();
  const year = String(now.getFullYear());
  const read = all.filter(b => b.status === 'read');
  const dated = read.filter(b => b.date_finished).sort((a, b) => b.date_finished.localeCompare(a.date_finished));
  const thisYear = dated.filter(b => b.date_finished.startsWith(year));
  const rated = thisYear.filter(b => b.rating);
  const slim = b => ({ title: b.title, author: b.author || '', rating: b.rating || null, finished: b.date_finished || null,
                       tags: b.tags || [], pages: b.pages || null });

  const byMonth = Array.from({ length: 12 }, (_, i) => ({ m: i, n: 0, titles: [] }));
  for (const b of thisYear) { const m = +b.date_finished.slice(5, 7) - 1; byMonth[m].n++; byMonth[m].titles.push(b.title); }
  const years = {};
  for (const b of dated) { const y = b.date_finished.slice(0, 4); years[y] = (years[y] || 0) + 1; }
  const y0 = now.getFullYear() - 5;
  const byYear = Array.from({ length: 6 }, (_, i) => ({ y: String(y0 + i), n: years[String(y0 + i)] || 0 }));

  // pace: pages a week across Kindle exports from the last 28 days
  const ex = (log.exports || []).filter(e => Object.keys(e.percent || {}).length);
  let pace = null;
  if (ex.length >= 2) {
    const since = Date.now() - 28 * 864e5;
    const recent = ex.filter(e => Date.parse(e.at) >= since);
    const win = recent.length >= 2 ? recent : ex.slice(-2);
    const first = win[0], last = win[win.length - 1];
    const days = Math.max((Date.parse(last.at) - Date.parse(first.at)) / 864e5, 1);
    const byId = Object.fromEntries(all.map(b => [b.id, b]));
    let pages = 0;
    for (const [id, pct] of Object.entries(last.percent)) {
      pages += Math.max(pct - (first.percent[id] || 0), 0) / 100 * ((byId[id] && byId[id].pages) || 300);
    }
    pace = Math.round(pages / days * 7);
  }

  const ko = log.koreader_daily || [];
  const koMinutes = ko.reduce((s, d) => s + d.minutes, 0);

  const prio = b => (b.priority || '9')[0];
  const queue = all.filter(b => b.status === 'want')
    .sort((a, b) => prio(a).localeCompare(prio(b)) || (b.kindle?.on_device ? 1 : 0) - (a.kindle?.on_device ? 1 : 0))
    .slice(0, 12)
    .map(b => ({ title: b.title, author: b.author || '', priority: b.priority || null, why: b.why || null,
                 tags: b.tags || [], onKindle: !!b.kindle?.on_device }));

  return {
    reading: all.filter(b => b.status === 'reading').map(b => ({
      title: b.title, author: b.author || '', percent: b.kindle?.percent ?? b.koreader?.percent ?? null,
      lastOpened: b.kindle?.last_opened || null, started: b.date_started || null, pages: b.pages || null,
    })),
    stats: {
      year, finished: thisYear.length, lastYear: years[String(now.getFullYear() - 1)] || 0,
      pages: thisYear.reduce((s, b) => s + (b.pages || 0), 0),
      avgRating: rated.length ? Math.round(rated.reduce((s, b) => s + b.rating, 0) / rated.length * 10) / 10 : null,
      pace, byMonth, byYear,
      counts: { read: read.length, want: all.filter(b => b.status === 'want').length, owned: all.filter(b => b.owned).length },
      koreader: ko.length ? { hours: Math.round(koMinutes / 6) / 10, days: new Set(ko.map(d => d.date)).size,
                             from: ko[0].date, to: ko[ko.length - 1].date } : null,
      lastExport: log.last_export || null,
    },
    recent: dated.slice(0, 10).map(slim),
    queue,
    picks: parsePicks(recs),
  };
}

// ---------- Add a book from the Reading page ----------
const norm = s => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/_ /g, ': ').replace(/^(.*?), (the|a|an)\b/, '$2 $1').replace(/\(.*?\)|\[.*?\]/g, ' ')
  .split(':')[0].trim().replace(/^(the|a|an) /, '').replace(/[^a-z0-9]+/g, ' ').trim();
const surname = a => { const p = norm(String(a || '').split(',')[0]).split(' '); return p[p.length - 1] || ''; };

async function registerBooks(env) {
  const raw = await repoFile(env, 'books.json');
  return raw ? JSON.parse(raw).books : [];
}

async function openLibrary(params) {
  const u = new URL('https://openlibrary.org/search.json');
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  u.searchParams.set('limit', '5');
  u.searchParams.set('fields', 'title,author_name,first_publish_year,isbn,number_of_pages_median,cover_i,key');
  const r = await fetch(u, { headers: { 'User-Agent': 'shaunzen-api (personal reading page)' } });
  if (!r.ok) return [];
  return ((await r.json()).docs || []).map(d => ({
    title: d.title, author: (d.author_name || []).slice(0, 2).join(', '), year: d.first_publish_year || null,
    isbn13: (d.isbn || []).find(i => i.length === 13 && i.startsWith('97')) || null,
    pages: d.number_of_pages_median || null,
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
    olKey: d.key || null,
  }));
}

async function aiGuesses(env, q) {
  if (!env.AI) return [];
  try {
    const r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: 'You identify books from short, possibly vague descriptions. Reply with ONLY a JSON array of up to 3 objects {"title": string, "author": string}, most likely first. Use the real published title and author. No commentary.' },
        { role: 'user', content: q },
      ],
      max_tokens: 200,
    });
    const text = typeof r.response === 'string' ? r.response : JSON.stringify(r.response || '');
    const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    return arr.filter(x => x && x.title).slice(0, 3);
  } catch { return []; }
}

async function resolveBook(env, { q }) {
  q = String(q || '').trim().slice(0, 200);
  if (!q) return { error: 'empty' };
  const guesses = await aiGuesses(env, q);
  const lists = await Promise.all([
    ...guesses.map(g => openLibrary({ title: g.title, author: g.author })),
    openLibrary({ q }),
  ]);
  const seen = new Set(), out = [];
  for (const list of lists) for (const c of list.slice(0, 2)) {
    const k = norm(c.title) + '|' + surname(c.author);
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  }
  // fall back to the AI's own guess if Open Library had nothing
  if (!out.length) for (const g of guesses) out.push({ title: g.title, author: g.author, year: null, isbn13: null, pages: null, cover: null });
  const reg = await registerBooks(env);
  for (const c of out.slice(0, 5)) {
    const hit = reg.find(b => norm(b.title) === norm(c.title) && surname(b.author) === surname(c.author));
    if (hit) c.inRegister = hit.status;
  }
  return { query: q, understood: guesses[0] || null, candidates: out.slice(0, 5) };
}

async function addBook(env, b, who) {
  const status = ['shelf', 'want', 'reading', 'read'].includes(b.status) ? b.status : 'want';
  const title = String(b.title || '').trim().slice(0, 200), author = String(b.author || '').trim().slice(0, 200);
  if (!title) return { error: 'no title' };
  const repo = env.BOOKS_REPO || 'sh4unn/book-register';
  const api = `https://api.github.com/repos/${repo}/contents/books.json`;
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'shaunzen-api' };
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(api, { headers });
    if (!r.ok) return { error: `GitHub ${r.status} reading books.json` };
    const file = await r.json();
    const text = new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\n/g, '')), c => c.charCodeAt(0)));
    const books = JSON.parse(text).books;
    const hit = books.find(x => norm(x.title) === norm(title) && surname(x.author) === surname(author));
    if (hit) return { ok: true, existing: true, title: hit.title, status: hit.status };
    const ids = new Set(books.map(x => x.id));
    const base = (`${norm(title)} ${surname(author)}`.trim().replace(/ /g, '-').slice(0, 60)) || 'book';
    let id = base; for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    const today = new Date().toISOString().slice(0, 10);
    const book = { id, title, author };
    if (b.isbn13) book.isbn13 = String(b.isbn13);
    book.status = status;
    book.date_added = today;
    if (status === 'reading') book.date_started = today;
    if (status === 'read') book.date_finished = today;
    if (b.pages) book.pages = Number(b.pages);
    if (b.year) book.year = String(b.year);
    book.source = 'web';
    // Append as text so the rest of the file stays byte-for-byte the same (the Mac re-sorts it on its next sync).
    const at = text.lastIndexOf('\n  ]');
    if (at < 0) return { error: 'unexpected books.json layout' };
    const entry = JSON.stringify(book, null, 2).split('\n').map(l => '    ' + l).join('\n');
    const next = text.slice(0, at) + ',\n' + entry + text.slice(at);
    const bytes = new TextEncoder().encode(next);
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const put = await fetch(api, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Add ${title}${author ? ' by ' + author : ''} (${status}) from shaunzen.com`, content: btoa(bin), sha: file.sha }),
    });
    if (put.status === 409 || put.status === 422) continue;  // file changed underneath us: re-read and retry
    if (!put.ok) return { error: `GitHub ${put.status} writing books.json${put.status === 403 ? ': the token needs Contents: Read and write' : ''}` };
    await Promise.all([env.STATE.delete('books'), env.STATE.delete('summary')]);
    return { ok: true, added: true, title, status };
  }
  return { error: 'books.json kept changing, try again' };
}

// ---------- Follow a writer (Reading page → articles/feeds.txt) ----------
// GET /feeds lists who is followed; POST /feeds {url} adds a Substack, Medium writer or any RSS/blog.
// New posts then arrive in the Sunday "Weekly Reading" issue (book-register's articles.py reads feeds.txt).
const FEEDS_PATH = 'articles/feeds.txt';

function feedSite(raw) {
  let u = String(raw || '').trim().split(/\s+/)[0];
  if (!u) return null;
  if (u.startsWith('@')) u = 'https://medium.com/' + u;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  let p;
  try { p = new URL(u); } catch { return null; }
  if (!p.hostname.includes('.')) return null;
  const host = p.hostname.toLowerCase().replace(/^www\./, '');
  const path = p.pathname.replace(/\/+$/, '');
  if (host === 'medium.com') {
    const at = path.split('/').find(s => s.startsWith('@'));
    return at ? { site: `https://medium.com/${at}`, feed: `https://medium.com/feed/${at}` } : null;
  }
  if (host.endsWith('.medium.com')) {  // name.medium.com is the same writer as medium.com/@name
    return { site: `https://${host}`, feed: `https://medium.com/feed/@${host.split('.')[0]}` };
  }
  if (host.endsWith('.substack.com')) {
    return { site: `https://${host}`, feed: `https://${host}/feed` };  // a post link → the whole publication
  }
  if (/(\/feed|\/rss|\.xml|\.rss|\.atom|\/atom)$/i.test(path)) return { site: `https://${host}${path}`, feed: `https://${host}${path}` };
  if (/^\/p\//.test(path)) return { site: `https://${host}`, feed: `https://${host}/feed` };  // Substack custom domain post
  return { site: `https://${host}${path}`, feed: `https://${host}${path}/feed` };
}

async function feedTitle(feedUrl) {
  try {
    const r = await fetch(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (shaunzen reading list)' }, cf: { cacheTtl: 0 } });
    if (!r.ok) return { ok: false, status: r.status };
    const xml = (await r.text()).slice(0, 20000);
    if (!/<(rss|feed)[\s>]/i.test(xml)) return { ok: false, status: 'not a feed' };
    const m = xml.match(/<title>(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?<\/title>/i);
    const title = m ? m[1].replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/[|\n]/g, ' ')
      .replace(/^Stories by (.+) on Medium$/i, '$1').trim().slice(0, 80) : '';
    return { ok: true, title };
  } catch {
    return { ok: false, status: 'unreachable' };
  }
}

async function feedsFile(env) {
  const repo = env.BOOKS_REPO || 'sh4unn/book-register';
  const api = `https://api.github.com/repos/${repo}/contents/${FEEDS_PATH}`;
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'shaunzen-api' };
  const r = await fetch(api, { headers });
  if (!r.ok) return { error: `GitHub ${r.status} reading feeds.txt`, api, headers };
  const file = await r.json();
  const text = new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\n/g, '')), c => c.charCodeAt(0)));
  return { api, headers, file, text };
}

function parseFeeds(text) {
  return text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => {
    const [u, name] = l.split(' | ');
    const s = feedSite(u);
    return { url: u.trim(), name: (name || '').trim() || (s ? new URL(s.site).hostname : u), key: s ? s.feed : u };
  });
}

async function listFeeds(env) {
  const f = await feedsFile(env);
  if (f.error) return { error: f.error };
  return { feeds: parseFeeds(f.text).map(({ url, name }) => ({ url, name })) };
}

async function followFeed(env, body) {
  const s = feedSite(body && body.url);
  if (!s) return { error: 'that doesn’t look like a web address' };
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = await feedsFile(env);
    if (f.error) return { error: f.error };
    const feeds = parseFeeds(f.text);
    const have = feeds.find(x => x.key === s.feed);
    if (have) return { ok: true, existing: true, name: have.name, feeds: feeds.map(({ url, name }) => ({ url, name })) };
    const t = await feedTitle(s.feed);
    // Substack sometimes refuses cloud servers; the Sunday job runs from the EC2 server, so add it anyway.
    if (!t.ok && !/substack\.com$/.test(new URL(s.site).hostname) && t.status !== 403) {
      return { error: `couldn’t find a feed at ${s.feed} (${t.status}). Try the writer’s home page or their /feed address.` };
    }
    const name = t.title || new URL(s.site).hostname;
    const line = `${s.site} | ${name}`;
    const next = f.text.replace(/\n*$/, '\n') + line + '\n';
    const bytes = new TextEncoder().encode(next);
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const put = await fetch(f.api, {
      method: 'PUT', headers: { ...f.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Feeds: follow ${name} (from shaunzen.com)`, content: btoa(bin), sha: f.file.sha }),
    });
    if (put.status === 409 || put.status === 422) continue;
    if (!put.ok) return { error: `GitHub ${put.status} writing feeds.txt` };
    return { ok: true, added: true, name, checked: t.ok, feeds: [...feeds, { url: s.site, name }].map(({ url, name }) => ({ url, name })) };
  }
  return { error: 'feeds.txt kept changing, try again' };
}

// recommendations.md: "## Week of YYYY-MM-DD" then "1. **Title** by Author — reason"
function parsePicks(md) {
  if (!md) return null;
  const m = md.match(/^## Week of (\S+)\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m);
  if (!m) return null;
  const items = [];
  let progress = null;
  for (const line of m[2].split('\n')) {
    const it = line.match(/^\s*\d+\.\s+\*\*(.+?)\*\*(?:\s+by\s+(.+?))?\s+[—-]\s+(.*)$/);
    if (it) items.push({ title: it[1], author: it[2] || '', reason: it[3].replace(/\s*\(top pick\)\s*$/i, ''),
                         top: /\(top pick\)/i.test(it[3]) || items.length === 0 });
    const p = line.match(/^Progress:\s*(.*)$/i);
    if (p) progress = p[1];
  }
  return { week: m[1], items, progress };
}

// ---------- helpers ----------
// A cache or heartbeat write must never break a page: if KV refuses (e.g. the free tier's daily write limit),
// log it and carry on with the fresh value.
async function cachePut(env, key, value) {
  try { await env.STATE.put(key, JSON.stringify(value)); }
  catch (e) { console.warn(`KV put ${key} skipped: ${e.message || e}`); }
}
function json(v, status = 200) {
  return new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
function cors(env, res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', env.SITE_ORIGIN);
  h.set('Access-Control-Allow-Credentials', 'true');
  h.set('Vary', 'Origin');
  return new Response(res.body, { status: res.status, headers: h });
}
