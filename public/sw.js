// ═══════════════════════════════════════════════════════════
//  sw.js  —  Club de Leones Veracruz
//  Service Worker unificado: PWA cache + FCM push notifications
// ═══════════════════════════════════════════════════════════

// Firebase compat para FCM en background
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

// ── Config ────────────────────────────────────────────────
const VERSION = '20260405-027';
const CACHE   = 'leones-' + VERSION;
const APP_URL = 'https://app-club-de-leones.web.app';
const ICON    = 'https://res.cloudinary.com/dgfkkwypy/image/upload/c_fit,w_192,h_192/v1773701524/LCI_emblem_2color_web_leemft.png';

// ── Firebase init ─────────────────────────────────────────
firebase.initializeApp({
  apiKey:            'AIzaSyDzuknHkLef6Vd_BuXhE_vvypgyl0cgAsQ',
  authDomain:        'app-club-de-leones.firebaseapp.com',
  projectId:         'app-club-de-leones',
  storageBucket:     'app-club-de-leones.firebasestorage.app',
  messagingSenderId: '863222115707',
  appId:             '1:863222115707:web:1f06b02ebf3e0d0acb61de',
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
  const title = notif.title || 'Club de Leones';
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
