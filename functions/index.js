// ═══════════════════════════════════════════════════════════
//  functions/index.js  —  Club de Leones Veracruz
//  Despliega con: firebase deploy --only functions
// ═══════════════════════════════════════════════════════════
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
setGlobalOptions({ region: 'us-central1' });
const { initializeApp }  = require('firebase-admin/app');
const { getFirestore }   = require('firebase-admin/firestore');
const { getMessaging }   = require('firebase-admin/messaging');

initializeApp();
const db  = getFirestore();
const fcm = getMessaging();

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  // 'usuario' incluido temporalmente para cubrir docs legacy hasta que
  // migrate-roles.js normalice todos a 'miembro'.
  return getTokensByRoles(['miembro','usuario','admin','subadmin','tesorero','cantinero','mutualista']);
}

// Tokens de admin y subadmin (colección roles nueva + legacy en usuarios)
async function getAdminSubadminTokens() {
  const tokens = [];

  // Sistema nuevo: colección roles
  const rolesSnap = await db.collection('roles')
    .where('rol', 'in', ['admin', 'subadmin'])
    .get();
  await Promise.all(rolesSnap.docs.map(async rd => {
    const userDoc = await db.collection('usuarios').doc(rd.id).get();
    const token = userDoc.data()?.fcmToken;
    if (token) tokens.push(token);
  }));

  // Legacy: rol guardado en usuarios
  const legacySnap = await db.collection('usuarios')
    .where('rol', 'in', ['admin', 'subadmin'])
    .get();
  legacySnap.forEach(d => {
    const token = d.data()?.fcmToken;
    if (token && !tokens.includes(token)) tokens.push(token);
  });

  return [...new Set(tokens)];
}

async function sendMulticast(tokens, title, body, clickUrl = 'https://app-club-de-leones.web.app') {
  if (!tokens.length) {
    console.log('⚠️ No hay tokens FCM disponibles');
    return;
  }
  const icon = 'https://res.cloudinary.com/dgfkkwypy/image/upload/c_fit,w_192,h_192/v1773701524/LCI_emblem_2color_web_leemft.png';
  const chunks = [];
  for (let i = 0; i < tokens.length; i += 500) chunks.push(tokens.slice(i, i + 500));

  for (const chunk of chunks) {
    try {
      const result = await fcm.sendEachForMulticast({
        tokens: chunk,
        notification: { title, body, imageUrl: icon },
        webpush: {
          notification: { icon, badge: icon, vibrate: [200, 100, 200] },
          fcmOptions: { link: clickUrl },
        },
        // iOS (APNS) requiere alert explícito con title y body dentro de aps
        apns: {
          payload: {
            aps: {
              alert: { title, body },
              sound: 'default',
              badge:  1,
            },
          },
          fcmOptions: { imageUrl: icon },
        },
      });

      console.log(`✅ Enviados: ${result.successCount}  ❌ Fallidos: ${result.failureCount}  Total: ${chunk.length}`);

      // Limpiar tokens inválidos de Firestore
      const deletePromises = [];
      result.responses.forEach((r, i) => {
        if (r.success) return;
        const code = r.error?.code;
        console.log(`❌ Error token[${i}]: código=${code}  mensaje=${r.error?.message}`);
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token'
        ) {
          const deadToken = chunk[i];
          console.log(`🗑️ Limpiando token inválido: ${deadToken.slice(0, 20)}...`);
          deletePromises.push(
            db.collection('usuarios')
              .where('fcmToken', '==', deadToken)
              .get()
              .then(snap => {
                snap.forEach(doc => {
                  console.log(`🗑️ Borrando fcmToken de usuario: ${doc.id}`);
                  return doc.ref.update({ fcmToken: null });
                });
              })
              .catch(e => console.error('Error limpiando token:', e.message))
          );
        }
      });

      if (deletePromises.length) await Promise.all(deletePromises);

    } catch (err) {
      console.error('❌ Error en sendEachForMulticast:', err?.code, err?.message);
    }
  }
}

// ── TRIGGER 1: Nuevo comunicado ───────────────────────────────────────────────
exports.notificarNuevoComunicado = onDocumentCreated(
  'comunicados/{docId}',
  async (event) => {
    console.log('🔔 notificarNuevoComunicado disparado, docId:', event.params.docId);
    const data = event.data?.data();
    console.log('📄 data parseado:', JSON.stringify(data));
    if (!data || !data.activo) {
      console.log('⏭️ Ignorado: activo =', data?.activo);
      return;
    }
    const tipoEmoji = { aviso:'📢', oficial:'📋', evento:'🎉', urgente:'🚨', adeudo:'💳' }[data.tipo] || '📢';
    const title = `${tipoEmoji} ${data.titulo}`;
    const body  = (data.texto || '').slice(0, 120) + ((data.texto || '').length > 120 ? '…' : '');
    if (data.destinatarios === 'directo' && data.destinatarioUID) {
      console.log('📨 Comunicado directo a UID:', data.destinatarioUID);
      const userDoc = await db.collection('usuarios').doc(data.destinatarioUID).get();
      const token = userDoc.data()?.fcmToken;
      if (token) await sendMulticast([token], title, body);
      else console.log('⚠️ El usuario destinatario no tiene fcmToken');
      return;
    }
    let tokens = [];
    if (data.destinatarios === 'todos') {
      tokens = await getAllMemberTokens();
    } else {
      const snap = await db.collection('usuarios').get();
      snap.forEach(doc => { const d = doc.data(); if (d.tipo === data.destinatarios && d.fcmToken) tokens.push(d.fcmToken); });
    }
    console.log(`📤 Tokens encontrados: ${tokens.length}`);
    await sendMulticast(tokens, title, body);
  }
);

// ── TRIGGER 2: Socio aprobado ─────────────────────────────────────────────────
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
    console.log(`📤 notificarSocioAprobado — tokens: ${tokens.length}`);
    await sendMulticast(tokens, title, body);
  }
);

// ── TRIGGER 3: Solicitud de cargo ─────────────────────────────────────────────
exports.notificarSolicitudCargo = onDocumentCreated(
  'solicitudes/{docId}',
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    const title  = '🎖 Solicitud de cargo pendiente';
    const body   = `${data.nombre} solicita el cargo: ${data.cargo}`;
    const tokens = await getTokensByRoles(['admin', 'subadmin']);
    console.log(`📤 notificarSolicitudCargo — tokens: ${tokens.length}`);
    await sendMulticast(tokens, title, body);
  }
);

// ── TRIGGER 4: Pago mutualista ────────────────────────────────────────────────
exports.notificarPagoMutualista = onDocumentCreated(
  'mutualista_pagos/{docId}',
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    const fmt   = n => '$' + (n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 });
    const title  = '💰 Pago registrado al Fondo Mutualista';
    const body   = `${data.concepto || 'Pago a la Mutualista'} — ${fmt(data.monto)}`;
    const tokens = await getTokensByRoles(['mutualista']);
    console.log(`📤 notificarPagoMutualista — tokens: ${tokens.length}`);
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
      else console.log('⚠️ Usuario sin fcmToken:', data.uid);
    } else {
      const tokens = await getTokensByRoles(['admin', 'subadmin', 'tesorero']);
      console.log(`📤 notificarAdeudoManual — tokens: ${tokens.length}`);
      await sendMulticast(tokens, title, body);
    }
    await event.data.ref.delete();
  }
);

// ── TRIGGER 6: Nuevo recibo emitido ──────────────────────────────────────────
exports.notificarNuevoRecibo = onDocumentCreated(
  'recibos/{docId}',
  async (event) => {
    const data = event.data?.data();
    if (!data || !data.socioUID) return;
    const fmt   = n => '$' + (n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 });
    const periodo = `${data.mes || ''} ${data.anio || ''}`.trim();
    const title = `🧾 Nuevo recibo — ${periodo}`;
    const body  = `Monto: ${fmt(data.total)} · ${data.estado === 'pagado' ? 'Pagado' : 'Pendiente de pago'}`;
    const userDoc = await db.collection('usuarios').doc(data.socioUID).get();
    const token = userDoc.data()?.fcmToken;
    if (token) {
      console.log(`📤 notificarNuevoRecibo → UID: ${data.socioUID}, periodo: ${periodo}`);
      await sendMulticast([token], title, body);
    } else {
      console.log('⚠️ Socio sin fcmToken:', data.socioUID);
    }
  }
);
// ── TRIGGER 7: Activar socio offline (self-registration linking) ─────────────
// Se dispara cuando un usuario nuevo se registra con offlineLinkedId en su doc.
// Migra recibos, adeudos y pagos del doc offline al nuevo UID con Admin SDK.
exports.activarSocioOffline = onDocumentCreated(
  'usuarios/{uid}',
  async (event) => {
    const newUid = event.params.uid;
    const data   = event.data?.data();
    if (!data || !data.offlineLinkedId) return; // no es un registro vinculado

    const offlineId = data.offlineLinkedId;
    console.log(`🔗 activarSocioOffline: newUid=${newUid}  offlineId=${offlineId}`);

    // Validar que offlineId apunte a un documento offline real (no migrado)
    const offlineDocSnap = await db.collection('usuarios').doc(offlineId).get();
    if (!offlineDocSnap.exists) {
      console.warn(`⚠️ activarSocioOffline: offlineId no existe: ${offlineId}`);
      return;
    }
    const offlineData = offlineDocSnap.data();
    if (offlineData.offline !== true) {
      console.warn(`⚠️ activarSocioOffline: doc ${offlineId} no es offline (offline=${offlineData.offline})`);
      return;
    }
    if (offlineData.migrado === true) {
      console.warn(`⚠️ activarSocioOffline: doc ${offlineId} ya fue migrado`);
      return;
    }

    const batch = db.batch();
    let count = { recibos: 0, adeudos: 0, pagos: 0 };

    // ── Migrar recibos ──────────────────────────────────────────────────────
    const recSnap = await db.collection('recibos').where('socioUID', '==', offlineId).get();
    recSnap.forEach(d => {
      batch.update(d.ref, { socioUID: newUid });
      count.recibos++;
    });

    // ── Migrar adeudos (doc ID = uid) ───────────────────────────────────────
    const adeudoRef = db.collection('adeudos').doc(offlineId);
    const adeudoSnap = await adeudoRef.get();
    if (adeudoSnap.exists) {
      const newAdeudoRef = db.collection('adeudos').doc(newUid);
      batch.set(newAdeudoRef, adeudoSnap.data());
      batch.delete(adeudoRef);
      count.adeudos = 1;
    }

    // ── Migrar pagos ────────────────────────────────────────────────────────
    const pagosSnap = await db.collection('pagos').where('uid', '==', offlineId).get();
    pagosSnap.forEach(d => {
      batch.update(d.ref, { uid: newUid });
      count.pagos++;
    });

    // ── Marcar doc offline ──────────────────────────────────────────────────
    const offlineRef = db.collection('usuarios').doc(offlineId);
    batch.update(offlineRef, { migrado: true, linkedToUID: newUid });

    await batch.commit();
    console.log(`✅ activarSocioOffline completado: recibos=${count.recibos}  adeudos=${count.adeudos}  pagos=${count.pagos}`);
  }
);

// ── TRIGGER 8: Nuevo registro pendiente → notificar admins y subadmins ────────
exports.notificarNuevoRegistro = onDocumentCreated(
  'usuarios/{uid}',
  async (event) => {
    const data = event.data?.data();
    if (!data) return;

    // Solo registros nuevos en estado pendiente (no socios offline ni migraciones)
    if (data.rol !== 'pendiente') return;
    if (data.offline === true) return;  // socios offline no necesitan aprobación

    const nombre = `${data.nombre || ''} ${data.apellido || ''}`.trim() || data.correo || 'Nuevo usuario';
    const tipo   = { socio:'Socio', dama:'Dama León', viuda:'Viuda León', cooperadora:'Cooperadora', empleado:'Empleado', paloma:'Paloma' }[data.tipo] || data.tipo || 'Socio';

    console.log(`📬 notificarNuevoRegistro: ${nombre} (${tipo})`);

    const tokens = await getAdminSubadminTokens();
    if (!tokens.length) {
      console.log('⚠️ No hay admins con token FCM registrado');
      return;
    }

    await sendMulticast(
      tokens,
      '🦁 Nuevo registro pendiente',
      `${nombre} · ${tipo} solicita acceso a la app`,
      'https://app-club-de-leones.web.app'
    );
  }
);
