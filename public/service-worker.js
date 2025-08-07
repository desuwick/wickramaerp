/* Wickrama HW – offline shell */
const CACHE = 'whs-shell-v1';
const CORE  = [
  '/', '/index.html', '/track.html',
  '/uploads/logo.png'
];
// 1) Install: cache core files
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)));
  self.skipWaiting();
});
// 2) Activate: clear old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});
// 3) Fetch: network-first for API, cache-first for everything else
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.url.includes('/api/')) return;               // let API fail if offline
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req))
  );
});
