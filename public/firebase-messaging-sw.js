// ═══════════════════════════════════════════════════════
//  firebase-messaging-sw.js
//  Coloca este archivo en la RAÍZ de tu proyecto
//  (mismo nivel que index.html)
// ═══════════════════════════════════════════════════════
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            "AIzaSyDzuknHkLef6Vd_BuXhE_vvypgyl0cgAsQ",
  authDomain:        "app-club-de-leones.firebaseapp.com",
  projectId:         "app-club-de-leones",
  storageBucket:     "app-club-de-leones.firebasestorage.app",
  messagingSenderId: "863222115707",
  appId:             "1:863222115707:web:1f06b02ebf3e0d0acb61de",
});

const messaging = firebase.messaging();

// Notificaciones recibidas cuando la app está en BACKGROUND o cerrada
messaging.onBackgroundMessage(payload => {
  const { title, body, icon, click_action } = payload.notification || {};
  self.registration.showNotification(title || 'Club de Leones', {
    body:    body  || '',
    icon:    icon  || 'https://res.cloudinary.com/dgfkkwypy/image/upload/c_fit,w_192,h_192/v1773701524/LCI_emblem_2color_web_leemft.png',
    badge:   'https://res.cloudinary.com/dgfkkwypy/image/upload/c_fit,w_96,h_96/v1773701524/LCI_emblem_2color_web_leemft.png',
    data:    { url: click_action || 'https://app-club-de-leones.web.app' },
    vibrate: [200, 100, 200],
  });
});

// Al hacer click en la notificación → abrir la app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || 'https://app-club-de-leones.web.app';
  event.waitUntil(clients.openWindow(url));
});
