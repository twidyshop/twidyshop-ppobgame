const CACHE_NAME = 'twidy-pwa-v1';
const urlsToCache = [
    '/',
    '/logo.png',
    '/favicon.png'
];

// Install Service Worker
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(urlsToCache);
        })
    );
});

// Fetch & Cache (Agar loading web lebih cepat di HP)
self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request).then(response => {
            return response || fetch(event.request);
        }).catch(() => {
            return caches.match('/');
        })
    );
});
