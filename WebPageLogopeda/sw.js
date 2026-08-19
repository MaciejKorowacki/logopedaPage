/* ============================================================================
   sw.js – Service Worker v3
   ============================================================================ */

const CACHE_NAME = 'gabinet-v3';

const CACHE_URLS = [
  '/',
  '/index.html',
  '/login.html',
  '/app.html',
  '/login.js',
  '/app.js',
  '/security.js',
  '/security.css',
  '/style.css',
  '/manifest.json',
  '/icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(async cached => {
      const response = cached || await fetch(event.request);

      // Inject the security compatibility layer into the existing app without
      // duplicating the large legacy app.html file.
      if (new URL(event.request.url).pathname.endsWith('/app.html')) {
        const text = await response.clone().text();
        if (!text.includes('security.js')) {
          const injected = text.replace(
            '</body>',
            '<script src="security.js"></script></body>'
          );
          return new Response(injected, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
        }
      }

      return response;
    }).catch(() => fetch(event.request))
  );
});
