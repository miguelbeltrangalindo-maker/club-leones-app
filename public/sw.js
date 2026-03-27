// Service Worker — Club de Leones Veracruz
// La versión se actualiza automáticamente en cada deploy
const VERSION = '20260323-002';
const CACHE = 'leones-' + VERSION;

// Solo cacheamos el shell mínimo — no el index.html
// para que siempre se sirva la versión más reciente de la red
const ASSETS = ['/manifest.json'];

// Instalar
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
  // Activarse inmediatamente sin esperar tabs viejas
  self.skipWaiting();
});

// Activar: borra cachés viejos
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: Network First para HTML, Cache First para assets estáticos
self.addEventListener('fetch', e => {
  if (!e.request.url.startsWith(self.location.origin)) return;

  const url = new URL(e.request.url);

  // Para index.html: siempre intentar la red primero
  if (url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(
      fetch(e.request)
        .then(response => {
          // Guardar copia fresca
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, copy));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Para el resto: cache first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(e.request, copy));
        return response;
      });
    })
  );
});

// Mensajes desde la app
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
