// Este service worker fue consolidado en sw.js.
// Este archivo se mantiene vacío para que navegadores que lo tenían
// registrado previamente no entren en conflicto.
// El manejo de FCM ahora ocurre en sw.js.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
