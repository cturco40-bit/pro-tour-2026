const CACHE_NAME = 'protour2026-v75';

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ─── Firebase Cloud Messaging (true push, app-closed delivery) ──────────────
// Wrapped in try/catch so a CDN/network hiccup loading the SDKs can never break
// the core offline caching behaviour below. The Cloud Function sends DATA-only
// messages so the browser never auto-shows a duplicate — we build the notification
// here, giving us full control over title/body/icon.
try {
  importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');
  firebase.initializeApp({
    apiKey: 'AIzaSyCSXRYTl3EZ2wGWaqpMKPtYmqPajVDQ9D0',
    projectId: 'pro-tour-2026-58184',
    messagingSenderId: '695221419712',
    appId: '1:695221419712:web:773e5820397adbe8517725'
  });
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage(payload => {
    const d = (payload && payload.data) || {};
    self.registration.showNotification(d.title || 'Pro Tour', {
      body: d.body || 'Update',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: d.tag || 'protour',   // distinct tags so scoring & schedule don't replace each other
      renotify: true
    });
  });
} catch (e) { /* push unavailable on this device — core SW still works */ }

// Focus (or open) the app when a push notification is tapped
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './logo-pro-tour.png'
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
