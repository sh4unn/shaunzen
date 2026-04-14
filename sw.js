const CACHE = 'shaunzen-v1';
const ASSETS = [
  './',
  './index.html',
  './shaunswatch.html',
  './shauns-commonplace.html',
  './shauns-ledger.html',
  './book-recommender.html',
  './rs3-hiscores.html',
  './drug-reference.html',
  './qigong.html',
  './daily-tracker.html',
  './lean-season.html',
  './sql-dojo.html',
  './cardiac-surgery-reference.html',
  './shauns-scrolls.html',
  './study-flashcards.html',
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
