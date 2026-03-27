// ═══════════════════════════════════════════════════════
//  functions/index.js
//  Cloud Functions — Club de Leones Veracruz
//  Despliega con: firebase deploy --only functions
// ═══════════════════════════════════════════════════════
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
setGlobalOptions({ region: 'us-central1' });
const { initializeApp }  = require('firebase-admin/app');
const { getFirestore }   = require('firebase-admin/firestore');
const { getMessaging }   = require('firebase-admin/messaging');

initializeApp();
const db  = getFirestore();
const fcm = getMessaging();

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getTokensByRoles(roles) {
  const snap = await db.collection('usuarios').get();
  const tokens = [];
  snap.forEach(doc => {
    const d = doc.data();
    if (roles.includes(d.rol) && d.fcmToken) tokens.push(d.fcmToken);
  });
  return [...new Set(tokens)];
}

async function getAllMemberTokens() {
  return getTokensByRoles(['miembro','admin','subadmin','tesorero','cantinero','mutualista']);
}

async function sendMulticast(tokens, title, body, clickUrl = 'https://app-club-de-leones.web.app') {
  if (!tokens.length) { console.log('⚠️ No hay tokens'); return; }
  const icon = 'https://res.cloudinary.com/dgfkkwypy/image/upload/c_fit,w_192,h_192/v1773701524/LCI_emblem_2color_web_leemft.png';

  const chunks = [];
  for (let i = 0; i < tokens.length; i += 500) chunks.push(tokens.slice(i, i + 500));

  for (const chunk of chunks) {
    const result = await fcm.sendEachForMulticast({
      tokens: chunk,
      notification: { title, body, imageUrl: icon },
      webpush: {
        notification: { icon, badge: icon, vibrate: [200, 100, 200] },
        fcmOptions:   { link: clickUrl },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1 } },
        fcmOptions: { imageUrl: icon },
      },
    });
    console.log('✅ Enviados:', result.successCount, '❌ Fallidos:', result.failureCount);
    result.responses.forEach((r, i) => {
      if (!r.success) console.log('❌ Error token', i, ':', r.error?.code, r.error?.message);
    });
  }
}

// ── TRIGGER 1: Nuevo comunicado ───────────────────────────────────────────────
exports.notificarNuevoComunicado = onDocumentCreated(
  'comunicados/{docId}',
  async (event) => {
    const data = event.data?.data();
    if (!data || !data.activo) return;
    console.log('🔔 Comunicado recibido:', JSON.stringify(data));

    const tipoEmoji = {
      aviso:   '📢',
      oficial: '📋',
      evento:  '🎉',
      urgente: '🚨',
      adeudo:  '💳',
    }[data.tipo] || '📢';

    const title = `${tipoEmoji} ${data.titulo}`;
    const body  = data.texto?.slice(0, 120) + (data.texto?.length > 120 ? '…' : '');

    if (data.destinatarios === 'directo' && data.destinatarioUID) {
      const userDoc = await db.collection('usuarios').doc(data.destinatarioUID).get();
      const token = userDoc.data()?.fcmToken;
      if (token) await sendMulticast([token], title, body);
      return;
    }

    let tokens = [];
    if (data.destinatarios === 'todos') {
      tokens = await getAllMemberTokens();
    } else {
      const snap = await db.collection('usuarios').get();
      snap.forEach(doc => {
        const d = doc.data();
        if (d.tipo === data.destinatarios && d.fcmToken) tokens.push(d.fcmToken);
      });
    }
    console.log('📤 Tokens encontrados:', tokens.length);
    await sendMulticast(tokens, title, body);
  }
);

// ── TRIGGER 2: Nuevo socio aprobado → notificar al admin ─────────────────────
exports.notificarSocioAprobado = onDocumentUpdated(
  'usuarios/{uid}',
  async (event) => {
    const before = event.data?.before?.data();
    const after  = event.data?.after?.data();
    if (!before || !after) return;
    if (before.rol !== 'pendiente' || after.rol === 'pendiente') return;

    const nombre = `${after.nombre || ''} ${after.apellido || ''}`.trim();
    const title  = '✅ Nuevo socio aprobado';
    const body   = `${nombre} ha sido aprobado como ${after.rol}.`;
    const tokens = await getTokensByRoles(['admin', 'subadmin']);
    await sendMulticast(tokens, title, body);
  }
);

// ── TRIGGER 3: Nueva solicitud de cargo → notificar al admin ─────────────────
exports.notificarSolicitudCargo = onDocumentCreated(
  'solicitudes/{docId}',
  async (event) => {
    const data = event.data?.data();
    if (!data) return;

    const title = '🎖 Solicitud de cargo pendiente';
    const body  = `${data.nombre} solicita el cargo: ${data.cargo}`;
    const tokens = await getTokensByRoles(['admin', 'subadmin']);
    await sendMulticast(tokens, title, body);
  }
);

// ── TRIGGER 4: Pago registrado a la mutualista → notificar al mutualista ──────
exports.notificarPagoMutualista = onDocumentCreated(
  'mutualista_pagos/{docId}',
  async (event) => {
    const data = event.data?.data();
    if (!data) return;

    const fmt   = n => '$' + (n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 });
    const title = '💰 Pago registrado al Fondo Mutualista';
    const body  = `${data.concepto || 'Pago a la Mutualista'} — ${fmt(data.monto)}`;
    const tokens = await getTokensByRoles(['mutualista']);
    await sendMulticast(tokens, title, body);
  }
);

// ── TRIGGER 5: Recordatorio de adeudo ────────────────────────────────────────
exports.notificarAdeudoManual = onDocumentCreated(
  'notificaciones_push/{docId}',
  async (event) => {
    const data = event.data?.data();
    if (!data || data.tipo !== 'adeudo_recordatorio') return;

    const title = '⚠️ Recordatorio de adeudo';
    const body  = `${data.nombre} tiene ${data.meses} mes${data.meses !== 1 ? 'es' : ''} pendiente${data.meses !== 1 ? 's' : ''} — ${data.total}`;

    if (data.uid) {
      const userDoc = await db.collection('usuarios').doc(data.uid).get();
      const token = userDoc.data()?.fcmToken;
      if (token) await sendMulticast([token], title, body);
    } else {
      const tokens = await getTokensByRoles(['admin', 'subadmin', 'tesorero']);
      await sendMulticast(tokens, title, body);
    }

    await event.data.ref.delete();
  }
);