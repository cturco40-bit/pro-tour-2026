const CACHE_NAME = 'protour2026-v20';

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

// Install — cache core assets (do NOT skipWaiting; let user confirm via prompt)
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
});

// Activate — clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network first, fall back to cache
self.addEventListener('fetch', event => {
  // Skip non-GET and Firebase/Google requests — always go network for those
  if (event.request.method !== 'GET') return;
  const url = event.request.url;
  if (url.includes('firebaseio.com') || url.includes('googleapis.com') || url.includes('gstatic.com')) return;
  // Always go network for HTML to avoid stale app shell
  if (url.endsWith('/') || url.endsWith('/index.html')) {
    event.respondWith(fetch(event.request).catch(() => caches.match('./index.html')));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache a fresh copy of the response
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
