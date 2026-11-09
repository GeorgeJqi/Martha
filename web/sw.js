/* ==========================================================================
   MARTHA - SERVICE WORKER (PWA & OFFLINE CACHE)
   ========================================================================== */

const CACHE_NAME = 'martha-pwa-v4.1';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './index.css?v=4.1',
    './base.css',
    './tokens.css',
    './app.js?v=4.1',
    './manifest.json',
    './background.jpg',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/apple-touch-icon.png',
    './icons/favicon.png',
    './icons/icon.svg'
];

// Install Event
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // Cache each asset on its own so an optional file, such as the
            // background photograph, cannot block the whole install.
            return Promise.all(
                ASSETS_TO_CACHE.map((asset) =>
                    cache.add(asset).catch(() => null)
                )
            );
        }).then(() => self.skipWaiting())
    );
});

// Activate Event - Clean up stale caches immediately
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keyList) => {
            return Promise.all(
                keyList.map((key) => {
                    if (key !== CACHE_NAME) {
                        console.log('[SW] Deleting stale cache:', key);
                        return caches.delete(key);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch Event - Network First with Cache Fallback
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Never cache API routes
    if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') {
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200) {
                    const responseToCache = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseToCache);
                    });
                }
                return networkResponse;
            })
            .catch(() => {
                return caches.match(event.request).then((cachedResponse) => {
                    if (cachedResponse) return cachedResponse;
                    if (event.request.mode === 'navigate') {
                        return caches.match('./index.html');
                    }
                });
            })
    );
});
