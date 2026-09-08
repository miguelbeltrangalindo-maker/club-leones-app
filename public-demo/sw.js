// ═══════════════════════════════════════════════════════════
//  sw.js  —  Club Demo A.C.
//  Service Worker unificado: PWA cache + FCM push notifications
// ═══════════════════════════════════════════════════════════

// Firebase compat para FCM en background
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

// ── Config ────────────────────────────────────────────────
// IMPORTANTE: VERSION debe coincidir SIEMPRE con APP_VERSION en index.html
// y con "version" en version.json. Si las 3 no son idénticas:
//   - El banner de actualización queda enganchado (version.json vs APP_VERSION)
//   - El caché del SW no se invalida en deploy (este VERSION vs APP_VERSION)
// Bumpear las 3 juntas en cada release que requiera refresh.
const VERSION = '20260803-001';
const CACHE   = 'club-demo-' + VERSION;
const APP_URL = 'https://club-leones-demo.web.app';
const ICON    = '/icons/icon-192.png';

// ── Firebase init ─────────────────────────────────────────
firebase.initializeApp({
  apiKey:            'AIzaSyClFbLxWAssHc0UkDoRoLi_A6JDkW6vzzY',
  authDomain:        'club-leones-demo.firebaseapp.com',
  projectId:         'club-leones-demo',
  storageBucket:     'club-leones-demo.firebasestorage.app',
  messagingSenderId: '98420705454',
  appId:             '1:98420705454:web:bd31d2be14ae130006053f',
});

const messaging = firebase.messaging();

// ── Cache: instalar ───────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(['/manifest.json']))
  );
  self.skipWaiting(); // activar inmediatamente, sin esperar tabs viejas
});

// ── Cache: activar y limpiar versiones viejas ─────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Cache: fetch — Network First para HTML, Cache First para assets ──
self.addEventListener('fetch', e => {
  if (!e.request.url.startsWith(self.location.origin)) return;
  const url = new URL(e.request.url);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(
      fetch(e.request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, copy));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

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

// ── Mensajes desde la app (ej: forzar actualización) ──────
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING' || e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── FCM: notificaciones en BACKGROUND o con app cerrada ───
messaging.onBackgroundMessage(payload => {
  const notif = payload.notification || {};
  const title = notif.title || 'Club Demo';
  const body  = notif.body  || '';
  const url   = payload.fcmOptions?.link || notif.click_action || APP_URL;

  self.registration.showNotification(title, {
    body,
    icon:    ICON,
    badge:   ICON,
    data:    { url },
    vibrate: [200, 100, 200],
    tag:     payload.collapseKey || 'club-leones',
  });
});

// ── FCM: tap en la notificación → abrir / enfocar la app ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || APP_URL;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.startsWith(APP_URL) && 'focus' in client) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});
