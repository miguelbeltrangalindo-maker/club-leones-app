// ═══════════════════════════════════════════════════════════
//  functions/index.js  —  Club de Leones Veracruz
//  Despliega con: firebase deploy --only functions
// ═══════════════════════════════════════════════════════════
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
setGlobalOptions({ region: 'us-central1' });
const { initializeApp }  = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth }        = require('firebase-admin/auth');
const { getMessaging }   = require('firebase-admin/messaging');
const nodemailer         = require('nodemailer');

initializeApp();
const db  = getFirestore();
const fcm = getMessaging();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getTokensByRoles(roles) {
  const tokens = [];

  // Sistema nuevo: leer roles desde colección /roles/
  // (in admite hasta 30 valores; los roles del sistema son menos)
  const rolesSnap = await db.collection('roles').where('rol', 'in', roles).get();
  await Promise.all(rolesSnap.docs.map(async rd => {
    const userDoc = await db.collection('usuarios').doc(rd.id).get();
    const token = userDoc.data()?.fcmToken;
    if (token) tokens.push(token);
  }));

  // Legacy: rol guardado en /usuarios/
  const legacySnap = await db.collection('usuarios').where('rol', 'in', roles).get();
  legacySnap.forEach(d => {
    const token = d.data()?.fcmToken;
    if (token) tokens.push(token);
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
  // A2: filtrar tokens que no sean strings válidos antes de enviar
  const validTokens = tokens.filter(t => typeof t === 'string' && t.trim().length > 20);
  if (!validTokens.length) {
    console.log('⚠️ No hay tokens FCM válidos disponibles');
    return;
  }
  const icon = 'https://res.cloudinary.com/dgfkkwypy/image/upload/c_fit,w_192,h_192/v1773701524/LCI_emblem_2color_web_leemft.png';
  const chunks = [];
  for (let i = 0; i < validTokens.length; i += 500) chunks.push(validTokens.slice(i, i + 500));

  // A3: acumular todos los tokens inválidos y limpiarlos en un solo scan al final
  const deadTokenSet = new Set();

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

      result.responses.forEach((r, i) => {
        if (r.success) return;
        const code = r.error?.code;
        console.log(`❌ Error token[${i}]: código=${code}  mensaje=${r.error?.message}`);
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token'
        ) {
          deadTokenSet.add(chunk[i]);
        }
      });

    } catch (err) {
      console.error('❌ Error en sendEachForMulticast:', err?.code, err?.message);
    }
  }

  // A3: un solo scan de usuarios para limpiar todos los tokens muertos en batch
  if (deadTokenSet.size > 0) {
    console.log(`🗑️ Limpiando ${deadTokenSet.size} token(s) inválido(s) con un solo scan...`);
    try {
      const snap = await db.collection('usuarios').get();
      const batch = db.batch();
      let count = 0;
      snap.forEach(docRef => {
        const token = docRef.data()?.fcmToken;
        if (token && deadTokenSet.has(token)) {
          batch.update(docRef.ref, { fcmToken: null });
          console.log(`🗑️ Marcando para borrar fcmToken de usuario: ${docRef.id}`);
          count++;
        }
      });
      if (count > 0) await batch.commit();
      console.log(`✅ ${count} token(s) inválido(s) eliminado(s)`);
    } catch (e) {
      console.error('Error limpiando tokens inválidos:', e.message);
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
    const tipoEmoji = { aviso:'📢', oficial:'📋', evento:'🎉', urgente:'🚨', adeudo:'💳', junta:'📅', asamblea:'🏛️' }[data.tipo] || '📢';
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
    let ok = false;
    try {
      if (data.uid) {
        const userDoc = await db.collection('usuarios').doc(data.uid).get();
        const token = userDoc.data()?.fcmToken;
        if (token) { await sendMulticast([token], title, body); ok = true; }
        else console.log('⚠️ Usuario sin fcmToken:', data.uid);
      } else {
        const tokens = await getTokensByRoles(['admin', 'subadmin', 'tesorero']);
        console.log(`📤 notificarAdeudoManual — tokens: ${tokens.length}`);
        if (tokens.length) { await sendMulticast(tokens, title, body); ok = true; }
      }
    } catch (e) {
      console.error('notificarAdeudoManual ERROR:', e);
    }
    // Sólo borramos el doc disparador si el envío fue exitoso; si no,
    // marcamos un campo de error para inspección/reintentos manuales.
    if (ok) await event.data.ref.delete();
    else await event.data.ref.update({ procesadoConError: true, procesadoEn: new Date().toISOString() });
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

    // ── Anti-secuestro: el correo de Auth del nuevo usuario DEBE coincidir
    //    con el correo registrado por admin en el doc offline. De lo contrario
    //    cualquier nuevo registro podría reclamar la identidad de otro socio.
    try {
      const authUser = await getAuth().getUser(newUid);
      const authEmail  = (authUser.email || '').toLowerCase();
      const offlineEmail = (offlineData.correo || '').toLowerCase();
      if (!authEmail || !offlineEmail || authEmail !== offlineEmail) {
        console.error(`🛑 activarSocioOffline BLOQUEADO: email mismatch  authUid=${newUid} auth=${authEmail} offline=${offlineEmail}`);
        // Marcar el doc del nuevo usuario para revisión manual
        await db.collection('usuarios').doc(newUid).update({
          activacionBloqueada: true,
          activacionMotivo: 'Correo de Auth no coincide con el offline reclamado',
          offlineLinkedIdIntentado: offlineId,
        });
        return;
      }
    } catch (e) {
      console.error('activarSocioOffline: no se pudo verificar Auth user', e);
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

// ── TRIGGER 9: Recordatorios de Junta y Asamblea (diario 8 AM hora Ciudad de México) ──
exports.recordarJuntasAsambleas = onSchedule(
  { schedule: '0 8 * * *', timeZone: 'America/Mexico_City' },
  async () => {
    const APP_URL = 'https://app-club-de-leones.web.app';
    const now = new Date();

    // Skip eventos pasados antes del trabajo pesado (transacción + notify).
    // No usamos where('fechaEvento','>=',today) en la query porque combinar
    // un IN con otra range query exigiría un composite index aparte.
    const today = new Date().toISOString().slice(0, 10);

    const snap = await db.collection('comunicados')
      .where('tipo', 'in', ['junta', 'asamblea'])
      .where('activo', '==', true)
      .get();

    for (const docSnap of snap.docs) {
      const c = docSnap.data();
      if (!c.fechaEvento) continue;
      if (c.fechaEvento < today) continue;

      // Calcular días completos hasta el evento (medianoche hora México)
      const eventDate = new Date(c.fechaEvento + 'T12:00:00-06:00');
      const diffMs   = eventDate.getTime() - now.getTime();
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

      const keyMap = { 7: '7d', 2: '2d', 0: '0d' };
      const key = keyMap[diffDays];
      if (!key) continue;

      // A4: transacción para marcar como enviado ANTES de notificar,
      // garantizando que ejecuciones paralelas o reintentos no envíen duplicados
      let shouldSend = false;
      try {
        await db.runTransaction(async tx => {
          const fresh = await tx.get(docSnap.ref);
          const enviados = fresh.data()?.recordatoriosEnviados || [];
          if (enviados.includes(key)) {
            shouldSend = false;
            return;
          }
          tx.update(docSnap.ref, { recordatoriosEnviados: FieldValue.arrayUnion(key) });
          shouldSend = true;
        });
      } catch (txErr) {
        console.error(`❌ Transacción fallida para recordatorio ${key} del comunicado ${docSnap.id}:`, txErr);
        continue;
      }

      if (!shouldSend) {
        console.log(`⏭️ Recordatorio ${key} ya enviado para comunicado ${docSnap.id}`);
        continue;
      }

      const tipoLabel = c.tipo === 'junta' ? 'Junta' : 'Asamblea';
      const dayLabel  = diffDays === 0 ? '¡Es hoy!' : diffDays === 2 ? 'en 2 días' : 'en 1 semana';
      const title     = `📅 ${tipoLabel} ${dayLabel}`;
      const body      = `"${c.titulo}" — ${c.fechaEvento}`;

      console.log(`🔔 Enviando recordatorio ${key} para: ${c.titulo} (${c.fechaEvento})`);

      const tokens = await getAllMemberTokens();
      await sendMulticast(tokens, title, body, APP_URL);

      console.log(`✅ Recordatorio ${key} enviado a ${tokens.length} tokens`);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
//  CORREO ELECTRÓNICO — Helpers
// ══════════════════════════════════════════════════════════════════════════════

const APP_URL_EMAIL = 'https://app-club-de-leones.web.app';
const LOGO_URL = 'https://res.cloudinary.com/dgfkkwypy/image/upload/v1773701524/Logo_leones_veracruz_yfyhgg.png';

function crearTransporter(user, pass) {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

async function enviarCorreo(transporter, to, subject, html) {
  if (!to || typeof to !== 'string' || !to.includes('@')) return;
  const from = `"Club de Leones Veracruz" <${process.env.GMAIL_USER}>`;
  await transporter.sendMail({ from, to, subject, html });
  console.log(`📧 Correo enviado a: ${to}`);
}

async function getEmailsByDestinatarios(destinatarios, destinatarioUID, destinatarioTipos) {
  const snap = await db.collection('usuarios').get();
  const emails = [];
  const tiposMulti = Array.isArray(destinatarioTipos) ? destinatarioTipos : null;
  const damaTipos = ['dama','viuda','cooperadora'];
  snap.forEach(d => {
    const u = d.data();
    if (!u.correo || !u.correo.includes('@')) return;
    if (u.activo === false || u.offline) return;
    if (destinatarios === 'todos') {
      emails.push(u.correo);
    } else if (destinatarios === 'directo') {
      if (d.id === destinatarioUID) emails.push(u.correo);
    } else if (destinatarios === 'multi' && tiposMulti) {
      // Broadcast a varios tipos seleccionados (ej. ['socio','dama','empleado'])
      const tipoUser = u.tipo;
      if (tiposMulti.includes(tipoUser)) emails.push(u.correo);
      else if (tiposMulti.includes('dama') && damaTipos.includes(tipoUser)) emails.push(u.correo);
    } else if (destinatarios === 'socio' && u.tipo === 'socio') {
      emails.push(u.correo);
    } else if (destinatarios === 'dama' && damaTipos.includes(u.tipo)) {
      emails.push(u.correo);
    } else if (destinatarios === 'empleado' && u.tipo === 'empleado') {
      emails.push(u.correo);
    }
  });
  return [...new Set(emails)];
}

function emailHeaderFooter(contenido) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F4F1EC;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;margin-top:24px;margin-bottom:24px;">
    <div style="background:#0D1B2A;padding:28px 24px;text-align:center;">
      <img src="${LOGO_URL}" height="56" style="margin-bottom:8px;display:block;margin-left:auto;margin-right:auto;">
      <div style="color:#E8B84B;font-size:11px;letter-spacing:3px;font-weight:bold;">CLUB DE LEONES VERACRUZ A.C.</div>
    </div>
    <div style="padding:32px 28px;">${contenido}</div>
    <div style="background:#F8F6F1;padding:16px 24px;text-align:center;font-size:11px;color:#8A9BB0;border-top:1px solid #EFE6D7;">
      Club de Leones Veracruz A.C. &nbsp;·&nbsp; Correo automático — no responder
      <br><a href="${APP_URL_EMAIL}" style="color:#C9973A;text-decoration:none;">Abrir la app</a>
    </div>
  </div>
  </body></html>`;
}

function buildComunicadoEmail(c) {
  const tipoEmoji = { aviso:'📢', oficial:'📋', evento:'🎉', urgente:'🚨', adeudo:'💳', junta:'📅', asamblea:'🏛️' }[c.tipo] || '📢';
  const tipoLabel = { aviso:'Aviso', oficial:'Oficial', evento:'Evento', urgente:'Urgente', adeudo:'Adeudo', junta:'Junta', asamblea:'Asamblea' }[c.tipo] || c.tipo;
  const tipoColor = { aviso:'#2980B9', oficial:'#C9973A', evento:'#1A7A4A', urgente:'#C0392B', adeudo:'#8B0000', junta:'#7B3F9E', asamblea:'#E67E22' }[c.tipo] || '#888';
  const fechaEvento = c.fechaEvento
    ? `<div style="background:#F5F0E8;border-radius:8px;padding:12px 16px;margin:20px 0;display:flex;align-items:center;gap:8px;"><span style="font-size:18px;">📅</span><strong>Fecha: ${c.fechaEvento}</strong></div>`
    : '';
  const adjunto = c.adjuntoURL && c.adjuntoTipo === 'pdf'
    ? `<div style="margin-top:16px;"><a href="${c.adjuntoURL}" style="display:inline-block;background:#F5F0E8;color:#0D1B2A;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;">📄 Ver PDF adjunto</a></div>`
    : c.adjuntoURL && c.adjuntoTipo === 'image'
    ? `<img src="${c.adjuntoURL}" style="width:100%;border-radius:8px;margin-top:16px;">`
    : '';
  const contenido = `
    <div style="display:inline-block;background:${tipoColor}20;color:${tipoColor};padding:4px 12px;border-radius:50px;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;margin-bottom:16px;">${tipoEmoji} ${tipoLabel}</div>
    <h2 style="color:#0D1B2A;margin:0 0 16px;font-size:22px;line-height:1.3;">${c.titulo}</h2>
    <p style="color:#3A4A5C;line-height:1.8;font-size:15px;white-space:pre-wrap;margin:0 0 16px;">${c.texto || ''}</p>
    ${fechaEvento}
    ${adjunto}
    <div style="margin-top:28px;text-align:center;">
      <a href="${APP_URL_EMAIL}" style="background:#E8B84B;color:#0D1B2A;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px;">Ver en la App →</a>
    </div>`;
  return emailHeaderFooter(contenido);
}

function buildReciboEmail(r) {
  const fmt = n => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 });
  const periodo = `${r.mes || ''} ${r.anio || ''}`.trim() || '—';
  const estadoColor = r.estado === 'pagado' ? '#1A7A4A' : '#C0392B';
  const estadoLabel = r.estado === 'pagado' ? '✅ Pagado' : '⏳ Pendiente de pago';
  const lineas = [
    ['Cuota Socio', r.c1], ['Cuota Dama', r.c2], ['Percápita', r.c3],
    ['Baile de Coronación', r.c4], ['Navidad Escuela', r.c5],
    [r.c6label || 'Concepto adicional', r.c6], [r.c7label || 'Concepto extra', r.c7],
  ].filter(([, v]) => Number(v) > 0);
  const filasLineas = lineas.map(([label, val]) =>
    `<tr><td style="padding:6px 0;color:#5A6A7A;font-size:13px;">${label}</td><td style="padding:6px 0;text-align:right;font-size:13px;">${fmt(val)}</td></tr>`
  ).join('');
  const contenido = `
    <h2 style="color:#0D1B2A;margin:0 0 8px;">🧾 Recibo generado</h2>
    <p style="color:#5A6A7A;margin:0 0 24px;">Hola <strong>${r.nombreSocio || 'Socio'}</strong>, se ha generado un recibo a tu nombre.</p>
    <div style="background:#F8F6F1;border-radius:10px;padding:20px 24px;margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #EFE6D7;">
        <span style="color:#8A9BB0;font-size:13px;">Período</span><strong>${periodo}</strong>
      </div>
      <table style="width:100%;border-collapse:collapse;">${filasLineas}</table>
      <div style="display:flex;justify-content:space-between;margin-top:12px;padding-top:12px;border-top:2px solid #E8B84B;">
        <strong style="font-size:15px;">Total</strong>
        <strong style="font-size:18px;color:#C9973A;">${fmt(r.total)}</strong>
      </div>
      <div style="margin-top:12px;text-align:right;">
        <span style="background:${estadoColor}20;color:${estadoColor};padding:4px 12px;border-radius:50px;font-size:12px;font-weight:bold;">${estadoLabel}</span>
      </div>
    </div>
    <div style="text-align:center;margin-top:24px;">
      <a href="${APP_URL_EMAIL}" style="background:#E8B84B;color:#0D1B2A;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px;">Ver mis recibos →</a>
    </div>`;
  return emailHeaderFooter(contenido);
}

// ── TRIGGER 10: Email al publicar un nuevo comunicado ─────────────────────────
exports.emailNuevoComunicado = onDocumentCreated(
  { document: 'comunicados/{docId}', secrets: ['GMAIL_USER', 'GMAIL_PASS'] },
  async (event) => {
    const data = event.data?.data();
    if (!data || data.activo === false) return;
    if (!data.enviarCorreo) {
      console.log('⏭️ emailNuevoComunicado: envío por correo desactivado para este comunicado');
      return;
    }
    // Idempotencia: si el runtime reintenta este trigger, no re-enviamos.
    if (data.correoEnviado === true) {
      console.log('⏭️ emailNuevoComunicado: correoEnviado=true, skip');
      return;
    }
    console.log('📧 emailNuevoComunicado disparado:', event.params.docId);
    try {
      const transporter = crearTransporter(process.env.GMAIL_USER, process.env.GMAIL_PASS);
      const emails = await getEmailsByDestinatarios(
        data.destinatarios,
        data.destinatarioUID,
        data.destinatarioTipos
      );
      if (!emails.length) {
        console.log('⚠️ Sin destinatarios con correo');
        await event.data.ref.update({ correoEnviado: true, correoEnviadoCount: 0 });
        return;
      }
      const subject = `${data.titulo} — Club de Leones Veracruz`;
      const html = buildComunicadoEmail(data);
      // Enviar en lotes de 10 para no saturar Gmail
      let enviados = 0;
      for (let i = 0; i < emails.length; i += 10) {
        const lote = emails.slice(i, i + 10);
        const resultados = await Promise.all(lote.map(email =>
          enviarCorreo(transporter, email, subject, html)
            .then(() => 1)
            .catch(e => { console.error(`❌ Error enviando a ${email}:`, e.message); return 0; })
        ));
        enviados += resultados.reduce((a, b) => a + b, 0);
      }
      // Marcamos como procesado SOLO después del bucle completo.
      await event.data.ref.update({ correoEnviado: true, correoEnviadoCount: enviados });
      console.log(`✅ Comunicado enviado por correo a ${enviados}/${emails.length} destinatarios`);
    } catch (e) {
      console.error('❌ emailNuevoComunicado ERROR:', e.message);
    }
  }
);

// ── TRIGGER 11: Email al generar un nuevo recibo ──────────────────────────────
exports.emailNuevoRecibo = onDocumentCreated(
  { document: 'recibos/{docId}', secrets: ['GMAIL_USER', 'GMAIL_PASS'] },
  async (event) => {
    const data = event.data?.data();
    if (!data || !data.socioUID) return;
    // Idempotencia: no re-enviar si el runtime reintenta este trigger.
    if (data.correoEnviado === true) {
      console.log('⏭️ emailNuevoRecibo: correoEnviado=true, skip');
      return;
    }
    console.log('📧 emailNuevoRecibo disparado, socioUID:', data.socioUID);
    try {
      const userDoc = await db.collection('usuarios').doc(data.socioUID).get();
      const correo = userDoc.data()?.correo;
      if (!correo || !correo.includes('@')) {
        console.log('⚠️ Socio sin correo registrado:', data.socioUID);
        await event.data.ref.update({ correoEnviado: true, correoEnviadoMotivo: 'sin_correo' });
        return;
      }
      const transporter = crearTransporter(process.env.GMAIL_USER, process.env.GMAIL_PASS);
      const periodo = `${data.mes || ''} ${data.anio || ''}`.trim();
      const subject = `🧾 Tu recibo ${periodo} — Club de Leones Veracruz`;
      const html = buildReciboEmail(data);
      await enviarCorreo(transporter, correo, subject, html);
      await event.data.ref.update({ correoEnviado: true });
      console.log(`✅ Recibo enviado por correo a: ${correo}`);
    } catch (e) {
      console.error('❌ emailNuevoRecibo ERROR:', e.message);
    }
  }
);

// ── CALLABLE: Cambiar mi correo (Auth + Firestore atómico) ────────────────────
// Mantiene sincronizados el email de Firebase Auth (login/reset) y el `correo`
// de Firestore (notificaciones). Requiere login reciente (auth_time < 5 min).
async function isAdminUid(uid) {
  if (!uid) return false;
  const roleDoc = await db.collection('roles').doc(uid).get();
  if (roleDoc.exists && roleDoc.data().rol === 'admin') return true;
  const userDoc = await db.collection('usuarios').doc(uid).get();
  return userDoc.exists && userDoc.data().rol === 'admin';
}

exports.cambiarCorreoUsuario = onCall(async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión');

  const targetUid   = String(request.data?.targetUid || callerUid);
  const nuevoEmail  = String(request.data?.nuevoEmail || '').trim().toLowerCase();
  const cambioPropio = targetUid === callerUid;

  if (!nuevoEmail || nuevoEmail.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nuevoEmail)) {
    throw new HttpsError('invalid-argument', 'Correo inválido');
  }

  if (cambioPropio) {
    const authTimeMs = (request.auth.token.auth_time || 0) * 1000;
    if (!authTimeMs || Date.now() - authTimeMs > 5 * 60 * 1000) {
      throw new HttpsError('failed-precondition', 'Por seguridad, vuelve a iniciar sesión antes de cambiar tu correo');
    }
  } else {
    if (!(await isAdminUid(callerUid))) {
      throw new HttpsError('permission-denied', 'Solo un admin puede cambiar el correo de otro usuario');
    }
  }

  // Verificar que el email no esté en uso por otro usuario
  try {
    const existing = await getAuth().getUserByEmail(nuevoEmail);
    if (existing.uid !== targetUid) {
      throw new HttpsError('already-exists', 'Ese correo ya está en uso por otra cuenta');
    }
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    if (e.code !== 'auth/user-not-found') {
      console.error('cambiarCorreoUsuario getUserByEmail ERROR:', e);
      throw new HttpsError('internal', 'Error verificando correo');
    }
    // 'user-not-found' es esperado si el target todavía no tiene Auth (socio offline).
  }

  // Update Auth (si existe) + Firestore. Si Firestore falla DESPUÉS de Auth,
  // revertimos Auth para evitar divergencia (caso #5 del audit).
  let authPrevEmail = null;
  let authUpdated = false;
  try {
    const authUser = await getAuth().getUser(targetUid);
    authPrevEmail = authUser.email || null;
    await getAuth().updateUser(targetUid, { email: nuevoEmail, emailVerified: false });
    authUpdated = true;
  } catch (e) {
    if (e.code !== 'auth/user-not-found') {
      console.error('cambiarCorreoUsuario updateUser ERROR:', e);
      throw new HttpsError('internal', 'No se pudo actualizar el correo en Auth: ' + e.message);
    }
    // target sin Auth (socio offline): seguimos con Firestore únicamente
  }
  try {
    // set/merge en lugar de update — soporta docs que no existen (raro pero posible)
    await db.collection('usuarios').doc(targetUid).set({ correo: nuevoEmail }, { merge: true });
  } catch (fsErr) {
    console.error('cambiarCorreoUsuario Firestore ERROR — intentando revertir Auth:', fsErr);
    if (authUpdated && authPrevEmail) {
      try {
        await getAuth().updateUser(targetUid, { email: authPrevEmail });
        console.log(`↩️ Auth revertido a ${authPrevEmail} para ${targetUid}`);
      } catch (revertErr) {
        console.error(`🆘 INCONSISTENCIA: Auth quedó como ${nuevoEmail} pero Firestore tiene el anterior. Revisar manualmente:`, revertErr);
      }
    }
    throw new HttpsError('internal', 'No se pudo guardar en Firestore. Cambio revertido.');
  }
  console.log(`✉️ cambiarCorreoUsuario: ${targetUid} → ${nuevoEmail} (por ${callerUid})`);
  return { ok: true, correo: nuevoEmail };
});
