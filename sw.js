const CACHE = 'shaunzen-v9';
const ASSETS = [
  './',
  './index.html',
  './books.html',
  './training.html',
  './plan.html',
  './finance.html',
  './sql.html',
  './favicon.svg',
  './manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Only intercept same-origin GET requests
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith(self.location.origin)) return;

  // Pages: network first, so a deploy shows on the next load; the cached copy is only the offline fallback.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) { const clone = res.clone(); caches.open(CACHE).then(cache => cache.put(e.request, clone)); }
        return res;
      }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(c => c || caches.match('./index.html')))
    );
    return;
  }

  // Everything else: cached first, refreshed in the background.
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return res;
      });
      // Return cached immediately if available, fetch in background to update
      return cached || network;
    })
  );
});
