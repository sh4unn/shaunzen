// api.shaunzen.com — live data for the shaunzen.com launcher.
//
// Every route except /agent/* sits behind Cloudflare Access (your email only);
// the worker also verifies the Access JWT itself. /agent/* is an Access bypass
// used by the EC2 server, authenticated with the AGENT_SECRET bearer token.
//
// Bindings: STATE (KV). Vars: TEAM, AUD, HA_URL, SITE_ORIGIN.
// Secrets: AGENT_SECRET (set at deploy), HA_TOKEN and HARDCOVER_TOKEN (optional,
// add them in the Cloudflare dashboard; tiles show "connect" hints until then).

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
const HEARTBEAT_STALE_S = 180;
const CACHE_S = 60;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/agent/')) return await agent(req, env, url);

      const who = await verifyAccess(req, env);
      if (!who) return new Response('Unauthorized', { status: 401 });

      if (url.pathname === '/login') {
        const next = url.searchParams.get('next') || env.SITE_ORIGIN + '/';
        return Response.redirect(next.startsWith(env.SITE_ORIGIN + '/') ? next : env.SITE_ORIGIN + '/', 302);
      }
      if (req.method === 'GET' && url.pathname === '/summary') return cors(env, json(await summary(env)));
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
    await env.STATE.put('heartbeat', JSON.stringify(hb));
    return json({ ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/agent/inbox') return json(await listInbox(env));
  if (req.method === 'POST' && url.pathname === '/agent/ack') {
    const { ids } = await req.json();
    await Promise.all((ids || []).slice(0, 100).map(id => env.STATE.delete(`inbox:${id}`)));
    return json({ ok: true });
  }
  return new Response('Not found', { status: 404 });
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
    await env.STATE.put('summary', JSON.stringify({ t: Date.now(), v: base }));
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
  if (!env.HARDCOVER_TOKEN) return { needs: 'HARDCOVER_TOKEN' };
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

// ---------- helpers ----------
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
