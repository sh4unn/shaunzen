// api.shaunzen.com — live data for the shaunzen.com launcher.
//
// Every route except /agent/* sits behind Cloudflare Access (your email only);
// the worker also verifies the Access JWT itself. /agent/* is an Access bypass
// used by the EC2 server, authenticated with the AGENT_SECRET bearer token.
//
// Bindings: STATE (KV). Vars: TEAM, AUD, HA_URL, SITE_ORIGIN.
// Secrets: AGENT_SECRET (set at deploy), HA_TOKEN, GITHUB_TOKEN, HARDCOVER_TOKEN, READ_LATER_TOKEN,
// KINDLE_UPLOAD_TOKEN, SHIFTS_PUSH_TOKEN, SHIFTS_FEED_TOKEN (plus var SHIFTS_USER_ID) and FINANCE_SECRET
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
      if (url.pathname.startsWith('/agent/shifts')) return await shifts(req, env, url);
      if (url.pathname.startsWith('/agent/coach/')) return await coachAgent(req, env, url);
      if (url.pathname.startsWith('/agent/finance/')) return await financeAgent(req, env, url);
      if (url.pathname.startsWith('/agent/')) return await agent(req, env, url);

      const who = await verifyAccess(req, env);
      if (!who) return new Response('Unauthorized', { status: 401 });

      if (url.pathname === '/login') {
        const next = url.searchParams.get('next') || env.SITE_ORIGIN + '/';
        return Response.redirect(next.startsWith(env.SITE_ORIGIN + '/') ? next : env.SITE_ORIGIN + '/', 302);
      }
      if (req.method === 'GET' && url.pathname === '/summary') return cors(env, json(await summary(env)));
      if (req.method === 'GET' && url.pathname === '/books') return cors(env, json(await books(env)));
      if (req.method === 'GET' && url.pathname === '/training') return cors(env, json(await training(env)));
      if (req.method === 'GET' && url.pathname === '/coach') return cors(env, json(await coachGet(env, url)));
      if (req.method === 'POST' && url.pathname === '/coach/approve') {
        if (req.headers.get('Origin') !== env.SITE_ORIGIN) return new Response('Bad origin', { status: 403 });
        let body;
        try { body = JSON.parse(await req.text()); } catch { return cors(env, json({ error: 'bad json' }, 400)); }
        const out = await coachApprove(env, body, who);
        return cors(env, json(out, out.error ? 400 : 200));
      }
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
      if (url.pathname.startsWith('/finance/')) return cors(env, await financePage(req, env, url, who));
      if (url.pathname === '/inbox') {
        if (req.method === 'GET') return cors(env, json(await listInbox(env)));
        if (req.method === 'POST') {
          if (req.headers.get('Origin') !== env.SITE_ORIGIN) return new Response('Bad origin', { status: 403 });
          const text = (await req.text()).trim().slice(0, 4000);
          if (!text) return cors(env, json({ error: 'empty' }, 400));
          const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
          const items = await listInbox(env);
          items.push({ id, text, at: new Date().toISOString(), by: who });
          await env.STATE.put(INBOX_KEY, JSON.stringify(items.slice(-200)));
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
    const done = new Set((ids || []).slice(0, 100));
    const items = await listInbox(env);
    const left = items.filter(x => !done.has(x.id));
    if (left.length !== items.length) await env.STATE.put(INBOX_KEY, JSON.stringify(left));
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

// The inbox is one KV key holding a JSON array. The server polls it every minute, and KV's free tier allows
// only 1,000 list operations a day, so polling must be a plain get. Items saved by the old one-key-per-item
// layout ("inbox:<id>") are moved into the array once, the first time it's read.
const INBOX_KEY = 'inbox';
async function listInbox(env) {
  const items = await env.STATE.get(INBOX_KEY, 'json');
  if (Array.isArray(items)) return items;
  const { keys } = await env.STATE.list({ prefix: 'inbox:' });
  const old = (await Promise.all(keys.map(k => env.STATE.get(k.name, 'json')))).filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
  try {
    await env.STATE.put(INBOX_KEY, JSON.stringify(old));
  } catch (e) {
    // KV refused the write (e.g. the daily limit): serve the old items as they are and try the move next time.
    console.warn(`inbox move postponed: ${e.message || e}`);
    return old;
  }
  await Promise.all(keys.map(k => env.STATE.delete(k.name)));
  return old;
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
  const inbox = (await listInbox(env)).length;
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

async function repoFile(env, path, repo = env.BOOKS_REPO || 'sh4unn/book-register', token = env.GITHUB_TOKEN) {
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw+json', 'User-Agent': 'shaunzen-api' },
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

// ---------- Training (from the private garmin-training repo) ----------
// A nightly GitHub Action there pulls Garmin Connect into training.json (activities + daily RHR/HRV/sleep).
// This passes it through; training.html does the analysis. Needs GITHUB_TOKEN with read-only Contents on
// that repo too (var TRAINING_REPO, default sh4unn/garmin-training), or TRAINING_TOKEN: a separate
// fine-grained token with read-only Contents on just that repo, used instead when set. Cached in KV like /books.
const TRAINING_CACHE_S = 600;

async function training(env) {
  const token = env.TRAINING_TOKEN || env.GITHUB_TOKEN;
  if (!token) return { needs: 'TRAINING_TOKEN' };
  const cached = await env.STATE.get('training', 'json');
  if (cached && Date.now() - cached.t < TRAINING_CACHE_S * 1000) return cached.v;
  const repo = env.TRAINING_REPO || 'sh4unn/garmin-training';
  const raw = await repoFile(env, 'training.json', repo, token);
  if (raw === null) {
    return { error: `GitHub can't see training.json in ${repo}. Give the ${env.TRAINING_TOKEN ? 'TRAINING_TOKEN' : 'GITHUB_TOKEN'} access to that repo (Contents: Read-only), and check the Garmin sync has run once.` };
  }
  const v = JSON.parse(raw);
  await cachePut(env, 'training', { t: Date.now(), v });
  return v;
}

// ---------- Coach (weekly training plans from garmin-coach on the EC2 server) ----------
// The server plans each week (Sunday 3pm), POSTs it here and emails a link to plan.html. Approving there marks
// that exact version (by hash) approved; the server polls /agent/coach/status and writes the workouts to Garmin.
// Agent routes use the existing AGENT_SECRET (systemd hands it to the coach service). KV: coach:plan:<week>,
// coach:weeks (last 12 Mondays), coach:today (this morning's readiness).
const COACH_KEEP = 12;
const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

async function coachAgent(req, env, url) {
  const auth = req.headers.get('Authorization') || '';
  if (!env.AGENT_SECRET || !timingSafeEqual(auth, `Bearer ${env.AGENT_SECRET}`)) return new Response('Unauthorized', { status: 401 });
  const p = url.pathname.slice('/agent/coach'.length);
  if (req.method === 'POST' && p === '/plan') {
    const rec = await req.json();
    if (!WEEK_RE.test(rec.week || '') || !rec.hash || !rec.plan) return json({ error: 'bad plan' }, 400);
    rec.approved = null; rec.pushed = null; rec.received = new Date().toISOString();
    await env.STATE.put(`coach:plan:${rec.week}`, JSON.stringify(rec));
    const weeks = ((await env.STATE.get('coach:weeks', 'json')) || []).filter(w => w !== rec.week);
    weeks.push(rec.week);
    weeks.sort();
    await env.STATE.put('coach:weeks', JSON.stringify(weeks.slice(-COACH_KEEP)));
    return json({ ok: true });
  }
  if (req.method === 'GET' && p === '/status') {
    const rec = await env.STATE.get(`coach:plan:${url.searchParams.get('week')}`, 'json');
    return json(rec ? { hash: rec.hash, approved: rec.approved, pushed: rec.pushed } : {});
  }
  if (req.method === 'POST' && p === '/pushed') {
    const b = await req.json();
    const rec = WEEK_RE.test(b.week || '') && await env.STATE.get(`coach:plan:${b.week}`, 'json');
    if (!rec || rec.hash !== b.hash) return json({ error: 'no such plan' }, 404);
    rec.pushed = { at: new Date().toISOString(), count: Number(b.count) || 0 };
    await env.STATE.put(`coach:plan:${b.week}`, JSON.stringify(rec));
    return json({ ok: true });
  }
  if (req.method === 'POST' && p === '/today') {
    const b = await req.json();
    await cachePut(env, 'coach:today', { at: new Date().toISOString(), readiness: b.readiness || null, change: b.change || null });
    return json({ ok: true });
  }
  return new Response('Not found', { status: 404 });
}

async function coachGet(env, url) {
  const weeks = (await env.STATE.get('coach:weeks', 'json')) || [];
  const asked = url.searchParams.get('week');
  const week = asked && WEEK_RE.test(asked) ? asked : weeks[weeks.length - 1];
  const plan = week ? await env.STATE.get(`coach:plan:${week}`, 'json') : null;
  return { weeks, plan, today: await env.STATE.get('coach:today', 'json') };
}

async function coachApprove(env, body, who) {
  if (!WEEK_RE.test(body.week || '')) return { error: 'bad week' };
  const rec = await env.STATE.get(`coach:plan:${body.week}`, 'json');
  if (!rec) return { error: 'no plan for that week' };
  if (rec.hash !== body.hash) return { error: 'This plan changed after you opened it. Reload and check it again.' };
  if (!rec.approved) {
    rec.approved = { at: new Date().toISOString(), by: who, hash: rec.hash };
    await env.STATE.put(`coach:plan:${body.week}`, JSON.stringify(rec));
  }
  return { ok: true, approved: rec.approved };
}

// ---------- Finance (finance.html ↔ finance-sync on the EC2 server) ----------
// The page encrypts each export in the browser with the server's RSA public key (envelope "SZF1"), so this worker
// only ever holds ciphertext. The server polls /agent/finance/*, decrypts and parses on its own disk, then PUTs back
// a summary (monthly totals only: no transactions, no account numbers). Budgets and confirmed categories go the
// other way. Agent routes use their own FINANCE_SECRET (not AGENT_SECRET), so the other agents can't read them.
// KV: fin:summary, fin:pubkey, fin:budgets, fin:catq (confirmed categories not yet picked up), fin:balq (balances typed
// on the page, not yet picked up), fin:uploads (log),
// fin:up:<id> (encrypted file, expires after 14 days whether or not it was picked up).
const FIN_MAX_BYTES = 12 * 1024 * 1024;   // page allows 10 MB; the envelope adds a little
const FIN_MAX_QUEUED = 30;
const FIN_UPLOAD_TTL_S = 14 * 86400;
const FIN_TYPES = ['macquarie-pdf', 'macquarie-csv', 'vpi-pdf', 'vpi-csv', 'super-csv', 'super-pdf'];
const FIN_ID_RE = /^[0-9a-z-]{4,64}$/;

async function financePage(req, env, url, who) {
  const p = url.pathname.slice('/finance'.length);
  if (req.method === 'GET' && p === '/summary') return json(await financeSummary(env));
  if (req.method === 'GET' && p === '/pubkey') {
    const pem = await env.STATE.get('fin:pubkey');
    return pem ? new Response(pem, { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } })
      : json({ error: 'The server has not set up its key yet' }, 503);
  }
  if (req.method !== 'POST') return new Response('Not found', { status: 404 });
  if (req.headers.get('Origin') !== env.SITE_ORIGIN) return new Response('Bad origin', { status: 403 });

  if (p === '/upload') {
    const type = url.searchParams.get('type') || '';
    if (!FIN_TYPES.includes(type)) return json({ error: 'unknown file type' }, 400);
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length < 64 || bytes.length > FIN_MAX_BYTES) return json({ error: 'file too big or empty' }, 400);
    if (new TextDecoder().decode(bytes.slice(0, 4)) !== 'SZF1') return json({ error: 'not an encrypted upload' }, 400);
    const log = (await env.STATE.get('fin:uploads', 'json')) || [];
    if (log.filter(u => u.status === 'queued').length >= FIN_MAX_QUEUED) return json({ error: 'Too many files waiting; try again once the server has caught up' }, 429);
    const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    await env.STATE.put(`fin:up:${id}`, bytes, { expirationTtl: FIN_UPLOAD_TTL_S });
    log.unshift({ id, type, at: new Date().toISOString(), size: bytes.length, status: 'queued', by: who });
    await env.STATE.put('fin:uploads', JSON.stringify(log.slice(0, 60)));
    return json({ ok: true, id });
  }

  let body;
  try { body = JSON.parse(await req.text()); } catch { return json({ error: 'bad json' }, 400); }
  if (p === '/budgets') {
    const out = {};
    for (const [k, v] of Object.entries(body.budgets || {}).slice(0, 60)) {
      const n = Math.round(Number(v));
      if (typeof k === 'string' && k.length <= 60 && Number.isFinite(n) && n >= 0 && n <= 1e7) out[k] = n;
    }
    await env.STATE.put('fin:budgets', JSON.stringify(out));
    return json({ ok: true, budgets: out });
  }
  if (p === '/categories') {
    const { id, merchant, category } = body;
    if (!FIN_ID_RE.test(String(id || ''))) return json({ error: 'bad id' }, 400);
    if (typeof merchant !== 'string' || typeof category !== 'string' || merchant.length > 200 || category.length > 60) return json({ error: 'bad category' }, 400);
    const q = ((await env.STATE.get('fin:catq', 'json')) || []).filter(x => x.id !== id);
    q.push({ id, merchant, category, at: new Date().toISOString() });
    await env.STATE.put('fin:catq', JSON.stringify(q.slice(-500)));
    return json({ ok: true });
  }
  if (p === '/balance') {
    // A balance read off the Vanguard portal, for accounts whose exports don't include one (super).
    const { account, date, amount } = body;
    const n = Math.round(Number(amount) * 100) / 100;
    if (!['super', 'invest'].includes(account) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !Number.isFinite(n) || n < 0 || n > 1e8) return json({ error: 'bad balance' }, 400);
    if (date > new Date(Date.now() + 864e5).toISOString().slice(0, 10)) return json({ error: 'date is in the future' }, 400);
    const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const q = (await env.STATE.get('fin:balq', 'json')) || [];
    q.push({ id, account, date, amount: n });
    await env.STATE.put('fin:balq', JSON.stringify(q.slice(-50)));
    return json({ ok: true, id });
  }
  if (p === '/adjust') {
    // Move part of a month's spending between categories (e.g. cash that paid for solar → Housing), or undo one.
    const q = (await env.STATE.get('fin:adjq', 'json')) || [];
    if (body.remove) {
      if (!FIN_ID_RE.test(String(body.remove))) return json({ error: 'bad id' }, 400);
      q.push({ remove: String(body.remove) });
    } else {
      const { month, from, to } = body;
      const n = Math.round(Number(body.amount) * 100) / 100;
      if (!/^\d{4}-\d{2}$/.test(String(month || '')) || typeof from !== 'string' || typeof to !== 'string' || from === to
          || from.length > 60 || to.length > 60 || !Number.isFinite(n) || n <= 0 || n > 1e7) return json({ error: 'bad adjustment' }, 400);
      q.push({ id: `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`, month, from, to, amount: n, note: String(body.note || '').slice(0, 60) });
    }
    await env.STATE.put('fin:adjq', JSON.stringify(q.slice(-100)));
    return json({ ok: true });
  }
  return new Response('Not found', { status: 404 });
}

// What the page reads: the server's last summary, with the page's own newer inputs laid over it
// (budgets saved since, merchants already confirmed but not yet picked up, the upload log).
async function financeSummary(env) {
  const [s, budgets, catq, log] = await Promise.all([
    env.STATE.get('fin:summary', 'json'), env.STATE.get('fin:budgets', 'json'),
    env.STATE.get('fin:catq', 'json'), env.STATE.get('fin:uploads', 'json'),
  ]);
  const out = s || { months: [], categories: [], review: [] };
  const done = new Set((catq || []).map(x => x.id));
  out.review = (out.review || []).filter(x => !done.has(x.id));
  if (budgets) out.budgets = budgets;
  out.budgets = out.budgets || {};
  out.uploads = (log || []).map(({ type, at, status, rows }) => ({ type, at, status, rows }));
  return out;
}

async function financeAgent(req, env, url) {
  const auth = req.headers.get('Authorization') || '';
  if (!env.FINANCE_SECRET || !timingSafeEqual(auth, `Bearer ${env.FINANCE_SECRET}`)) return new Response('Unauthorized', { status: 401 });
  const p = url.pathname.slice('/agent/finance'.length);
  // Everything the server needs each poll, in one read-only call (KV reads are cheap, writes are not).
  if (req.method === 'GET' && p === '/inbox') {
    const [log, budgets, catq, balq, adjq] = await Promise.all([
      env.STATE.get('fin:uploads', 'json'), env.STATE.get('fin:budgets', 'json'), env.STATE.get('fin:catq', 'json'),
      env.STATE.get('fin:balq', 'json'), env.STATE.get('fin:adjq', 'json')]);
    return json({ uploads: (log || []).filter(u => u.status === 'queued').map(({ id, type, at, size }) => ({ id, type, at, size })),
      budgets: budgets || {}, categories: catq || [], balances: balq || [], adjustments: adjq || [] });
  }
  const m = p.match(/^\/upload\/([0-9a-z-]+)$/);
  if (req.method === 'GET' && m) {
    const bytes = await env.STATE.get(`fin:up:${m[1]}`, 'arrayBuffer');
    return bytes ? new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } }) : json({ error: 'gone' }, 404);
  }
  if (req.method === 'POST' && p === '/done') {
    // [{id, status:'processed'|'rejected', rows?}] – deletes the encrypted file and updates the log.
    const items = (await req.json()).filter(x => FIN_ID_RE.test(String(x.id || '')));
    const log = (await env.STATE.get('fin:uploads', 'json')) || [];
    for (const it of items) {
      const u = log.find(u => u.id === it.id);
      if (u) { u.status = it.status === 'processed' ? 'processed' : 'rejected'; u.rows = Number.isFinite(it.rows) ? it.rows : null; }
      await env.STATE.delete(`fin:up:${it.id}`);
    }
    await env.STATE.put('fin:uploads', JSON.stringify(log));
    return json({ ok: true });
  }
  if (req.method === 'POST' && p === '/adjustments-ack') {
    // the server took the first n queued items (adds and removes, in order)
    const n = Number((await req.json()).count) || 0;
    const q = (await env.STATE.get('fin:adjq', 'json')) || [];
    await env.STATE.put('fin:adjq', JSON.stringify(q.slice(n)));
    return json({ ok: true });
  }
  if (req.method === 'POST' && p === '/balances-ack') {
    const ids = new Set((await req.json()).ids || []);
    const q = ((await env.STATE.get('fin:balq', 'json')) || []).filter(x => !ids.has(x.id));
    await env.STATE.put('fin:balq', JSON.stringify(q));
    return json({ ok: true });
  }
  if (req.method === 'POST' && p === '/categories-ack') {
    const ids = new Set((await req.json()).ids || []);
    const q = ((await env.STATE.get('fin:catq', 'json')) || []).filter(x => !ids.has(x.id));
    await env.STATE.put('fin:catq', JSON.stringify(q));
    return json({ ok: true });
  }
  if (req.method === 'PUT' && p === '/summary') {
    const text = await req.text();
    if (text.length > 1024 * 1024) return json({ error: 'summary too big' }, 400);
    const s = JSON.parse(text);
    if (!Array.isArray(s.months)) return json({ error: 'bad summary' }, 400);
    await env.STATE.put('fin:summary', text);
    return json({ ok: true });
  }
  if (req.method === 'PUT' && p === '/pubkey') {
    const pem = (await req.text()).trim();
    if (!/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----$/.test(pem)) return json({ error: 'not a PEM public key' }, 400);
    await env.STATE.put('fin:pubkey', pem);
    return json({ ok: true });
  }
  return new Response('Not found', { status: 404 });
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

// ---------- Teams Shifts → subscribable calendar ----------
// Work blocks every way out of Shifts except Power Automate, so a work flow (hourly) POSTs the output of
// "List all shifts" here, and calendar apps subscribe to the .ics. Both live under /agent/ for the Access bypass:
//   POST /agent/shifts                          "Authorization: Bearer <SHIFTS_PUSH_TOKEN>", body = the JSON list
//   GET  /agent/shifts/<SHIFTS_FEED_TOKEN>.ics   subscribe to this (phone, Google, Outlook.com, HA Remote Calendar)
//   GET  /agent/shifts/<SHIFTS_FEED_TOKEN>.json  on shift now? next shift? (for HA REST sensors)
// The feed token is in the path because calendar apps can't send headers. Keep both tokens long and random.
// Optional var SHIFTS_USER_ID (your Entra object id) keeps only your shifts if the flow sends the whole team's.
// A push is the truth for everything not yet finished: shifts missing from it are deleted, changed ones updated.
// Finished shifts are kept as history for SHIFTS_KEEP_DAYS. One KV key; written only when something changed.
const SHIFTS_KEY = 'shifts';
const SHIFTS_KEEP_DAYS = 400;

async function shifts(req, env, url) {
  if (req.method === 'POST' && url.pathname === '/agent/shifts') {
    const auth = req.headers.get('Authorization') || '';
    if (!env.SHIFTS_PUSH_TOKEN || !timingSafeEqual(auth, `Bearer ${env.SHIFTS_PUSH_TOKEN}`)) return new Response('Unauthorized', { status: 401 });
    let payload;
    const text = await req.text();
    try { payload = parseFlowJson(text); }
    catch (e) {
      const head = [...text.slice(0, 8)].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');
      const h = {};
      for (const [k, v] of req.headers) if (!/^(authorization|cookie|cf-access)/i.test(k)) h[k] = v.slice(0, 120);
      return json({ error: 'body is not JSON', detail: String(e.message || e), length: text.length, first_chars_hex: head, method: req.method, headers: h }, 400);
    }
    const list = shiftItems(payload);
    if (!list) return json({ error: 'expected a list of shifts, or an object with a "value" list' }, 400);
    const incoming = {};
    for (const raw of list) { const s = normaliseShift(raw, env); if (s) incoming[s.id] = s; }
    const now = Date.now(), oldest = now - SHIFTS_KEEP_DAYS * 864e5;
    const store = (await env.STATE.get(SHIFTS_KEY, 'json')) || { shifts: {} };
    const merged = {};
    for (const [id, s] of Object.entries(store.shifts)) {
      const end = Date.parse(s.end);
      if (!incoming[id] && end < now && end > oldest) merged[id] = s;
    }
    Object.assign(merged, incoming);
    const changed = JSON.stringify(sortById(merged)) !== JSON.stringify(sortById(store.shifts));
    if (changed) await env.STATE.put(SHIFTS_KEY, JSON.stringify({ shifts: merged, updated: new Date(now).toISOString() }));
    return json({ ok: true, received: list.length, yours: Object.keys(incoming).length, in_calendar: Object.keys(merged).length, changed });
  }
  const m = url.pathname.match(/^\/agent\/shifts\/([^/]+)\.(ics|json)$/);
  if (req.method === 'GET' && m && env.SHIFTS_FEED_TOKEN && timingSafeEqual(m[1], env.SHIFTS_FEED_TOKEN)) {
    const store = (await env.STATE.get(SHIFTS_KEY, 'json')) || { shifts: {}, updated: null };
    const all = mergeSameShifts(Object.values(store.shifts), env);
    if (m[2] === 'ics') {
      return new Response(shiftsIcs(all, store.updated, env), {
        headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    const now = Date.now();
    const current = all.find(s => Date.parse(s.start) <= now && Date.parse(s.end) > now) || null;
    const next = all.find(s => Date.parse(s.start) > now) || null;
    return json({ on_shift: !!current, current, next, updated: store.updated });
  }
  return new Response('Not found', { status: 404 });
}

// Power Automate's HTTP action can prefix a byte-order mark, or send the JSON double-encoded as a string.
function parseFlowJson(text) {
  let v = JSON.parse(text.replace(/^\uFEFF/, '').trim());
  if (typeof v === 'string') v = JSON.parse(v.replace(/^\uFEFF/, '').trim());
  return v;
}

// The Shifts connector may send the bare list or wrap it (value / body / shifts / items).
function shiftItems(p) {
  if (Array.isArray(p)) return p;
  if (p && typeof p === 'object') for (const k of ['value', 'shifts', 'body', 'items']) if (k in p) return shiftItems(p[k]);
  return null;
}

function normaliseShift(raw, env) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id || raw.shiftId;
  const me = (env.SHIFTS_USER_ID || '').trim().toLowerCase();
  if (me && raw.userId && String(raw.userId).toLowerCase() !== me) return null;
  let shared = raw.sharedShift;
  if (!shared) {  // flattened connector output, e.g. sharedShift_startDateTime
    shared = {};
    for (const [k, v] of Object.entries(raw)) if (k.startsWith('sharedShift_')) shared[k.slice(12)] = v;
  }
  const start = shiftTime(shared.startDateTime), end = shiftTime(shared.endDateTime);
  if (!id || !start || !end) return null;  // unpublished (draft only) or malformed
  const activities = (shared.activities || []).map(a => a && a.displayName).filter(Boolean);
  return { id: String(id), start, end, title: shared.displayName || '', notes: shared.notes || '', activities };
}

// Shifts times are UTC; Graph sometimes sends 7 fractional digits or no zone.
function shiftTime(v) {
  if (!v) return null;
  let s = String(v).trim().replace(/(\.\d{3})\d+/, '$1');
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(s)) s += 'Z';
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function sortById(o) { return Object.keys(o).sort().map(k => o[k]); }

// Event name: the shift's name in Shifts, else SHIFTS_DEFAULT_TITLE (default "Work").
function shiftTitle(s, env) { return s.title && s.title !== 'Shift' ? s.title : (env.SHIFTS_DEFAULT_TITLE || 'Work'); }

// Shifts sometimes holds the same shift twice under different IDs. Show one: same start, end and name.
// Sorted by start then ID, so the copy kept (and its UID) stays the same from one push to the next.
function mergeSameShifts(list, env) {
  const seen = new Set();
  return list.slice().sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id))
    .filter(s => { const k = `${s.start}|${s.end}|${shiftTitle(s, env)}`; return !seen.has(k) && seen.add(k); })
    .map(s => ({ ...s, title: shiftTitle(s, env) }));
}

// Times are written in Brisbane local time (UTC+10 all year, no daylight saving) with a VTIMEZONE,
// so calendar apps show them as local times rather than GMT/UTC.
// Optional var SHIFTS_LOCATION: an address or "lat, long" (dashboard only: this repo is public).
function shiftsIcs(list, updated, env) {
  const esc = t => String(t).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const utc = iso => iso.replace(/[-:]/g, '').replace(/\.\d+/, '');
  const local = iso => new Date(Date.parse(iso) + 10 * 3600e3).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  const TZ = 'Australia/Brisbane';
  const dtstamp = utc(updated || new Date().toISOString());
  const where = (env.SHIFTS_LOCATION || '').trim();
  const geo = where.match(/^(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)$/);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//shaunzen//shifts//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(env.SHIFTS_CAL_NAME || 'Shifts')}`, `X-WR-TIMEZONE:${TZ}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M',
    'BEGIN:VTIMEZONE', `TZID:${TZ}`, 'BEGIN:STANDARD', 'DTSTART:19700101T000000',
    'TZOFFSETFROM:+1000', 'TZOFFSETTO:+1000', 'TZNAME:AEST', 'END:STANDARD', 'END:VTIMEZONE',
  ];
  for (const s of list) {
    const desc = [s.notes, (s.activities || []).join('\n')].filter(Boolean).join('\n\n');
    lines.push('BEGIN:VEVENT', `UID:${esc(s.id)}@shifts.shaunzen.com`, `DTSTAMP:${dtstamp}`, `LAST-MODIFIED:${dtstamp}`,
      `DTSTART;TZID=${TZ}:${local(s.start)}`, `DTEND;TZID=${TZ}:${local(s.end)}`, `SUMMARY:${esc(s.title)}`);
    if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
    if (where) {
      lines.push(`LOCATION:${esc(where)}`);
      if (geo) {
        lines.push(`GEO:${geo[1]};${geo[2]}`,
          `X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-APPLE-RADIUS=100;X-TITLE="${where.replace(/"/g, '')}":geo:${geo[1]},${geo[2]}`);
      }
    }
    lines.push('TRANSP:OPAQUE', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

// iCalendar lines are at most 75 bytes; longer ones continue on the next line after a space.
function foldIcsLine(line) {
  const enc = new TextEncoder();
  const parts = [];
  let cur = '', len = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (len + n > (parts.length ? 74 : 75)) { parts.push(cur); cur = ''; len = 0; }
    cur += ch; len += n;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}
