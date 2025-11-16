const CACHE_NAME = "Mecha Man-v1";
const STATIC_ASSETS = [
  "/index.html", "/style.css", "/app.js", "/background.jpg", "/manifest.json"
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // --- START FIX ---
  // Don't cache API calls, streams, or Socket.IO
  if (url.pathname.startsWith('/stream/') ||
      url.pathname.startsWith('/art/') ||
      url.pathname.startsWith('/playlist') ||
      url.pathname.startsWith('/socket.io/')) {
    return; // Let the browser handle network requests
  }
  // --- END FIX ---

  e.respondWith(
    caches.match(e.request).then(cached => 
      cached || fetch(e.request).catch(()=>caches.match('/index.html'))
    )
  );
});