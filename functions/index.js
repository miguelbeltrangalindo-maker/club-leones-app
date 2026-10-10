// ═══════════════════════════════════════════════════════════
//  functions/index.js  —  Club de Leones Veracruz
//  Despliega con: firebase deploy --only functions
// ═══════════════════════════════════════════════════════════
const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
setGlobalOptions({ region: 'us-central1' });
const { initializeApp }  = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth }        = require('firebase-admin/auth');
const { getStorage }     = require('firebase-admin/storage');
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

// Tokens de miembros tipo 'socio' activos y aprobados (para votaciones/elecciones)
async function getSocioTokens() {
  const [usnap, rolesSnap] = await Promise.all([
    db.collection('usuarios').get(),
    db.collection('roles').get(),
  ]);
  const rolMap = {}; rolesSnap.forEach(d => { rolMap[d.id] = d.data(); });
  const tokens = [];
  usnap.forEach(d => {
    const u = d.data();
    if ((u.tipo || '') !== 'socio') return;
    if (u.estado === 'baja') return;
    const rd = rolMap[d.id];
    const rolEf = (rd && rd.rol) || u.rol || 'miembro';
    if (rolEf === 'pendiente') return;
    if (rd && rd.activo === false) return;
    if (u.fcmToken) tokens.push(u.fcmToken);
  });
  return [...new Set(tokens)];
}

// Tokens de los integrantes de la mesa directiva (por cargo)
const VOT_DIRECTIVA_CARGOS = ['Presidente','Past Presidente','Vicepresidente','Segundo Vicepresidente','Secretario','Tesorero','Domador','Retorcedor','Vocal dos años','Vocal un año'];
async function getDirectivaTokens() {
  const snap = await db.collection('usuarios').get();
  const tokens = [];
  snap.forEach(d => {
    const data = d.data();
    const cargos = Array.isArray(data?.cargos) ? data.cargos : [];
    if (cargos.some(c => VOT_DIRECTIVA_CARGOS.includes(c)) && data?.fcmToken) tokens.push(data.fcmToken);
  });
  return [...new Set(tokens)];
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

// ── TRIGGER: Nueva votación (al crearse) ──────────────────────────────────────
// Avisa por push al público objetivo (todos los socios o solo la directiva).
exports.notificarNuevaVotacion = onDocumentCreated(
  'votaciones/{vid}',
  async (event) => {
    const data = event.data?.data();
    if (!data || data.estado !== 'abierta') return;
    const esEleccion = data.tipo === 'eleccion';
    const title = esEleccion ? '🗳️ Nueva elección' : '🗳️ Nueva votación';
    const body  = esEleccion
      ? `${data.cargo || 'Elección'} · Periodo ${data.periodo || ''} — toca para votar por tu candidato`
      : `${data.titulo || 'Hay una votación abierta'} — toca para votar`;
    let tokens;
    if (Array.isArray(data.votantesPermitidos)) {
      // Segunda vuelta: solo quienes votaron en la primera
      tokens = [];
      for (const u of data.votantesPermitidos) {
        try { const ud = await db.collection('usuarios').doc(u).get(); const t = ud.data()?.fcmToken; if (t) tokens.push(t); } catch(e) {}
      }
    } else if (data.audiencia === 'directiva') {
      tokens = await getDirectivaTokens();
    } else {
      tokens = await getSocioTokens();   // 'todos' = solo miembros tipo socio
    }
    console.log(`📤 notificarNuevaVotacion (${esEleccion?'eleccion':'votacion'}/${data.audiencia}${data.votantesPermitidos?'/2avuelta':''}) — tokens: ${tokens.length}`);
    await sendMulticast(tokens, title, body);
  }
);

// ── TRIGGER: Resultado de votación (al cerrarse) ──────────────────────────────
// Cuando una votación pasa de 'abierta' a 'cerrada', se cuentan los votos, se guarda
// el resultado agregado en el doc (para que los socios lo vean, secreto) y se envía
// el resultado por push a quienes participaron.
exports.notificarResultadoVotacion = onDocumentUpdated(
  'votaciones/{vid}',
  async (event) => {
    const before = event.data?.before?.data();
    const after  = event.data?.after?.data();
    if (!before || !after) return;
    // Solo en la transición abierta → cerrada (evita re-disparos por el merge del resultado)
    if (before.estado === 'cerrada' || after.estado !== 'cerrada') return;

    const vid = event.params.vid;
    console.log('🗳️ notificarResultadoVotacion — cerrando:', vid);
    const votosSnap = await db.collection('votaciones').doc(vid).collection('votos').get();

    // ── ELECCIÓN: conteo por candidato (voto secreto) ──
    if (after.tipo === 'eleccion') {
      const conteo = {};
      (after.candidatos || []).forEach(c => { conteo[c.uid] = 0; });
      votosSnap.forEach(v => {
        const cu = v.data().candidato;
        if (cu != null) conteo[cu] = (conteo[cu] || 0) + 1;
      });
      const total = Object.values(conteo).reduce((s, n) => s + n, 0);
      let maxN = 0; Object.values(conteo).forEach(n => { if (n > maxN) maxN = n; });
      const lideres = Object.keys(conteo).filter(u => conteo[u] === maxN && maxN > 0);
      const empate = lideres.length !== 1;
      const ganadorUID = empate ? null : lideres[0];
      const ganadorNombre = (after.candidatos || []).find(c => c.uid === ganadorUID)?.nombre || '';
      try {
        await event.data.after.ref.set({ resultado: { conteo, total, ganadorUID, ganadorNombre, empate } }, { merge: true });
      } catch (e) { console.error('No se pudo guardar resultado elección:', e.message); }
      // El resultado de la elección se envía a los socios
      const tokens = await getSocioTokens();
      const title = `🗳️ Resultado — ${after.cargo || 'Elección'} ${after.periodo || ''}`;
      const body = empate
        ? `Empate con ${maxN} voto(s). La directiva definirá una segunda vuelta.`
        : `Ganó ${ganadorNombre} con ${maxN} de ${total} votos.`;
      console.log(`📤 notificarResultadoVotacion (elección) — total votos: ${total}, tokens: ${tokens.length}`);
      await sendMulticast(tokens, title, body);
      return;
    }

    // ── VOTACIÓN normal: favor / contra / abstención ──
    let favor = 0, contra = 0, abstencion = 0;
    const uids = [];
    votosSnap.forEach(v => {
      const d = v.data();
      if (d.voto === 'favor') favor++;
      else if (d.voto === 'contra') contra++;
      else if (d.voto === 'abstencion') abstencion++;
      uids.push(v.id);
    });
    const total = favor + contra + abstencion;

    // Guardar resultado agregado en el doc (los socios solo ven estos números)
    try {
      await event.data.after.ref.set({ resultado: { favor, contra, abstencion, total } }, { merge: true });
    } catch (e) { console.error('No se pudo guardar resultado:', e.message); }

    // Push a los participantes
    const tokens = [];
    for (const uid of uids) {
      try {
        const u = await db.collection('usuarios').doc(uid).get();
        const t = u.data()?.fcmToken;
        if (t) tokens.push(t);
      } catch (e) { /* ignora usuario sin doc */ }
    }
    const title = `🗳️ Resultado: ${after.titulo || 'Votación'}`;
    const body  = `A favor: ${favor} · En contra: ${contra} · Abstención: ${abstencion} (de ${total})`;
    console.log(`📤 notificarResultadoVotacion — participantes: ${uids.length}, tokens: ${tokens.length}`);
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
    const APP_URL = process.env.APP_URL || 'https://app-club-de-leones.web.app';
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
//  AVISO DE ESTACIONAMIENTO — notificaciones push por reservaciones (programado)
//  Reservaciones Fase 3. Corre diario @ 9 AM; por cada evento que afecta el
//  estacionamiento envía push 7 días antes, 1 día antes y el día del evento.
//  Plantillas editables desde config/plantillas_estacionamiento (con defaults).
//  Cancelar el evento = la notificación futura simplemente no se dispara.
// ══════════════════════════════════════════════════════════════════════════════
const PLANTILLAS_ESTAC_DEFAULT = {
  t7d: '🅿️ Aviso: el {fecha} {salon} estará reservado de {hora_ini} a {hora_fin} por "{evento}". No habrá estacionamiento.',
  t1d: '🅿️ Recordatorio: mañana {fecha} {salon} estará ocupado por "{evento}". Sin estacionamiento.',
  t0d: '🅿️ Hoy {salon} está reservado por "{evento}". Recuerda que no hay estacionamiento.',
};

function renderPlantillaEstac(tpl, r) {
  return String(tpl || '')
    .replace(/\{fecha\}/g, r.fecha || '')
    .replace(/\{hora_ini\}/g, r.horaInicio || '')
    .replace(/\{hora_fin\}/g, r.horaFin || '')
    .replace(/\{evento\}/g, r.evento || '')
    .replace(/\{salon\}/g, r.salonNombre || '');
}

// Tokens de socios activos + damas león (por tipo, no por rol de seguridad)
async function getTokensByTipos(tipos) {
  const snap = await db.collection('usuarios').get();
  const tokens = [];
  snap.forEach(d => {
    const u = d.data();
    if (!u.fcmToken) return;
    if (u.activo === false || u.offline) return;
    if (tipos.includes(u.tipo)) tokens.push(u.fcmToken);
  });
  return [...new Set(tokens)];
}

exports.notificarEstacionamiento = onSchedule(
  { schedule: '0 9 * * *', timeZone: 'America/Mexico_City' },
  async () => {
    const APP_URL = process.env.APP_URL || 'https://app-club-de-leones.web.app';
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    // Plantillas editables (con fallback a defaults)
    let plantillas = { ...PLANTILLAS_ESTAC_DEFAULT };
    try {
      const cfg = await db.collection('config').doc('plantillas_estacionamiento').get();
      if (cfg.exists) plantillas = { ...plantillas, ...cfg.data() };
    } catch (e) { console.error('Error leyendo plantillas_estacionamiento:', e.message); }

    const snap = await db.collection('reservaciones')
      .where('afectaEstacionamiento', '==', true)
      .get();

    let tokens = null; // se cargan una sola vez, solo si hay algo que enviar

    for (const docSnap of snap.docs) {
      const r = docSnap.data();
      if (!r.fecha) continue;
      if ((r.estado || '') === 'cancelada') continue;
      if (r.fecha < today) continue;

      const eventDate = new Date(r.fecha + 'T12:00:00-06:00');
      const diffDays  = Math.round((eventDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      const keyMap = { 7: '7d', 1: '1d', 0: '0d' };
      const key = keyMap[diffDays];
      if (!key) continue;

      // Dedup transaccional: marcar enviado ANTES de notificar (evita duplicados
      // por reintentos o ejecuciones paralelas).
      let shouldSend = false;
      try {
        await db.runTransaction(async tx => {
          const fresh = await tx.get(docSnap.ref);
          const fd = fresh.data() || {};
          if ((fd.estado || '') === 'cancelada') { shouldSend = false; return; }
          const enviados = fd.notifsEstacionamiento || [];
          if (enviados.includes(key)) { shouldSend = false; return; }
          tx.update(docSnap.ref, { notifsEstacionamiento: FieldValue.arrayUnion(key) });
          shouldSend = true;
        });
      } catch (txErr) {
        console.error(`❌ Transacción estacionamiento ${key} reserva ${docSnap.id}:`, txErr);
        continue;
      }
      if (!shouldSend) continue;

      const tplKey = key === '7d' ? 't7d' : key === '1d' ? 't1d' : 't0d';
      const body   = renderPlantillaEstac(plantillas[tplKey], r);
      const title  = '🅿️ Estacionamiento del Club';

      if (tokens === null) tokens = await getTokensByTipos(['socio', 'dama', 'viuda', 'cooperadora']);
      await sendMulticast(tokens, title, body, APP_URL);
      console.log(`✅ Aviso estacionamiento ${key} enviado ("${r.evento}") a ${tokens.length} tokens`);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
//  CORREO ELECTRÓNICO — Helpers
// ══════════════════════════════════════════════════════════════════════════════

const APP_URL_EMAIL = process.env.APP_URL || 'https://app-club-de-leones.web.app';
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

// ── CALLABLE: socios elegibles como candidatos (no adeudan más de 1 mes) ──────
// Se ejecuta con privilegios de servidor para leer recibos de todos sin exponerlos.
exports.listarCandidatosElegibles = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Inicia sesión');

  // Verificar que el solicitante sea líder (cargo Presidente/Secretario/Tesorero o rol)
  const [udSnap, rdSnap] = await Promise.all([
    db.collection('usuarios').doc(uid).get(),
    db.collection('roles').doc(uid).get(),
  ]);
  const rol = (rdSnap.exists && rdSnap.data().rol) || (udSnap.exists && udSnap.data().rol) || '';
  const cargos = (udSnap.exists && Array.isArray(udSnap.data().cargos)) ? udSnap.data().cargos : [];
  const esLider = ['admin', 'subadmin', 'tesorero'].includes(rol) ||
    cargos.some(c => ['Presidente', 'Secretario', 'Tesorero'].includes(c));
  if (!esLider) throw new HttpsError('permission-denied', 'Solo la directiva puede crear elecciones');

  const [usnap, rsnap, rolesSnap] = await Promise.all([
    db.collection('usuarios').get(),
    db.collection('recibos').get(),
    db.collection('roles').get(),
  ]);
  const rolMap = {}; rolesSnap.forEach(d => { rolMap[d.id] = d.data(); });

  // Meses de adeudo por socio = recibos con saldo pendiente (no pagado/condonado)
  const deuda = {};
  rsnap.forEach(d => {
    const r = d.data();
    const estado = (r.estado || '').toLowerCase();
    if (estado === 'pagado' || estado === 'condonado') return;
    if ((Number(r.total || 0) - Number(r.montoPagado || 0)) <= 0) return;
    const su = r.socioUID; if (!su) return;
    deuda[su] = (deuda[su] || 0) + 1;
  });

  const candidatos = [];
  usnap.forEach(d => {
    const u = d.data();
    if (u.estado === 'baja') return;
    if ((u.tipo || '') !== 'socio') return;                 // solo socios
    const rd = rolMap[d.id];
    const rolEf = (rd && rd.rol) || u.rol || 'miembro';
    if (rolEf === 'pendiente') return;
    if (rd && rd.activo === false) return;
    const meses = deuda[d.id] || 0;
    if (meses > 1) return;                                   // no debe adeudar más de 1 mes
    candidatos.push({ uid: d.id, nombre: `${u.nombre || ''} ${u.apellido || ''}`.trim(), numeroSocio: u.numeroSocio || '', meses });
  });
  candidatos.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
  return { candidatos };
});

// ── CALLABLE: crear segunda vuelta (solo votantes de la 1ª ronda) ─────────────
// El voto es secreto, así que la lista de participantes se arma en el servidor.
exports.crearSegundaVuelta = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Inicia sesión');
  const [udSnap, rdSnap] = await Promise.all([
    db.collection('usuarios').doc(uid).get(),
    db.collection('roles').doc(uid).get(),
  ]);
  const rol = (rdSnap.exists && rdSnap.data().rol) || (udSnap.exists && udSnap.data().rol) || '';
  const cargos = (udSnap.exists && Array.isArray(udSnap.data().cargos)) ? udSnap.data().cargos : [];
  const esLider = ['admin', 'subadmin', 'tesorero'].includes(rol) ||
    cargos.some(c => ['Presidente', 'Secretario', 'Tesorero'].includes(c));
  if (!esLider) throw new HttpsError('permission-denied', 'Solo la directiva puede crear la segunda vuelta');

  const origenId = String(request.data?.votacionId || '');
  if (!origenId) throw new HttpsError('invalid-argument', 'Falta la elección de origen');
  const ref = db.collection('votaciones').doc(origenId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Elección no encontrada');
  const v = snap.data();
  if (v.tipo !== 'eleccion') throw new HttpsError('failed-precondition', 'No es una elección');
  if (v.estado !== 'cerrada') throw new HttpsError('failed-precondition', 'La elección debe estar cerrada');

  const votosSnap = await ref.collection('votos').get();
  const conteo = {}; (v.candidatos || []).forEach(c => { conteo[c.uid] = 0; });
  const votantes = [];
  votosSnap.forEach(d => {
    const cu = d.data().candidato;
    if (cu != null) conteo[cu] = (conteo[cu] || 0) + 1;
    votantes.push(d.id);
  });
  let max = 0; Object.values(conteo).forEach(n => { if (n > max) max = n; });
  const empatados = (v.candidatos || []).filter(c => (conteo[c.uid] || 0) === max && max > 0);
  if (empatados.length < 2) throw new HttpsError('failed-precondition', 'No hay empate que resolver');
  if (!votantes.length) throw new HttpsError('failed-precondition', 'La primera vuelta no tuvo votos');

  const candidatos = empatados.map(c => ({ uid: c.uid, nombre: c.nombre, numeroSocio: c.numeroSocio || '' }));
  const nombre = udSnap.exists ? `${udSnap.data().nombre || ''} ${udSnap.data().apellido || ''}`.trim() : '';
  const nueva = await db.collection('votaciones').add({
    tipo: 'eleccion', cargo: v.cargo || 'Primer Vicepresidente', periodo: v.periodo || '',
    titulo: `${v.titulo || 'Elección'} (2ª vuelta)`,
    audiencia: 'todos', estado: 'abierta',
    candidatos, candidatoUIDs: candidatos.map(c => c.uid),
    votantesPermitidos: votantes, segundaVueltaDe: origenId,
    creadaPorUID: uid, creadaPorNombre: nombre, creadaPorRol: 'directiva',
    createdAt: FieldValue.serverTimestamp(), closedAt: null,
  });
  console.log(`🔁 Segunda vuelta creada ${nueva.id} — ${votantes.length} votantes, ${empatados.length} candidatos`);
  return { id: nueva.id };
});

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

// ── TRIGGER 12: limpiar el PDF de un acta borrada ─────────────────────────────
// El borrado del doc en la colección 'actas' está protegido por cargo de directiva
// en firestore.rules. Storage Rules no puede validar ese cargo, así que el borrado
// directo del PDF desde el cliente quedó bloqueado (allow delete: if false). Aquí,
// con privilegios de Admin SDK, eliminamos el archivo asociado al acta.
exports.limpiarPdfActaBorrada = onDocumentDeleted(
  'actas/{docId}',
  async (event) => {
    const data = event.data?.data();
    const storagePath = data?.storagePath;
    if (!storagePath || typeof storagePath !== 'string' || !storagePath.startsWith('actas/')) {
      console.log('⏭️ limpiarPdfActaBorrada: sin storagePath válido, nada que borrar');
      return;
    }
    try {
      await getStorage().bucket().file(storagePath).delete();
      console.log(`🗑️ PDF de acta borrado: ${storagePath}`);
    } catch (e) {
      // 404 = el archivo ya no existía; cualquier otro error se registra sin fallar.
      if (e.code === 404) console.log(`⏭️ limpiarPdfActaBorrada: ${storagePath} ya no existía`);
      else console.error('limpiarPdfActaBorrada ERROR:', e.message);
    }
  }
);

// ── TRIGGER 13: limpiar los votos de una votación borrada ─────────────────────
// El cliente (líder) solo borra el doc padre; no puede leer los votos secretos de
// una elección ni borrar votos ajenos. Aquí, con Admin SDK, se elimina la
// subcolección votos/ para no dejar documentos huérfanos.
exports.limpiarVotosVotacionBorrada = onDocumentDeleted(
  'votaciones/{vid}',
  async (event) => {
    const vid = event.params.vid;
    try {
      await db.recursiveDelete(db.collection('votaciones').doc(vid).collection('votos'));
      console.log(`🗑️ Votos de votación ${vid} eliminados`);
    } catch (e) {
      console.error('limpiarVotosVotacionBorrada ERROR:', e.message);
    }
  }
);

// ── CALLABLE: buscar socios offline para el picker de registro ────────────────
// Antes el cliente leía /usuarios where offline==true directamente, lo que exponía
// PII (correo, whatsapp, cónyuge, fecha de nacimiento) a cualquier autenticado.
// Ahora el listado se sirve aquí devolviendo SOLO lo mínimo para que el socio se
// identifique (nombre, apellido, número de socio). No requiere sesión porque el
// picker se usa durante el registro (antes de existir la cuenta). La verificación
// real de identidad la hace activarSocioOffline comparando el correo de Auth con
// el correo que el admin registró en el doc offline.
exports.buscarSociosOffline = onCall(async () => {
  const snap = await db.collection('usuarios').where('offline', '==', true).get();
  const socios = [];
  snap.forEach(d => {
    const u = d.data();
    if (u.migrado === true) return;
    socios.push({
      id: d.id,
      nombre: u.nombre || '',
      apellido: u.apellido || '',
      numeroSocio: u.numeroSocio || '',
    });
  });
  socios.sort((a, b) =>
    (a.apellido + a.nombre).localeCompare(b.apellido + b.nombre, 'es', { sensitivity: 'base' })
  );
  return { socios };
});

// ═══════════════════════════════════════════════════════════════════════════
//  PAGO EN LÍNEA CON TARJETA (Stripe Checkout)
//  1) crearCheckoutPago (callable): el socio pide pagar su recibo más antiguo
//     o todo lo vencido. El MONTO SE CALCULA AQUÍ desde sus recibos — el
//     cliente solo manda el modo, nunca cantidades ni ids.
//  2) stripeWebhook (HTTP): Stripe avisa que el pago se cobró. Se verifica la
//     firma y se aplica el pago una sola vez (idempotente por pagos_en_linea).
//  Mientras la llave sea sk_test_ solo admin/subadmin pueden generar cobros.
// ═══════════════════════════════════════════════════════════════════════════
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const STRIPE_SECRET_KEY     = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');

const PAGO_MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const pagoNorm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const pagoPeriodIdx = r => (Number(r.anio) || 0) * 12 + Math.max(0, PAGO_MESES.indexOf(r.mes || 'Enero'));
const pagoTotal = r => Number(r.total ?? Math.max(0, (r.c1||0)+(r.c2||0)+(r.c3||0)+(r.c4||0)+(r.c5||0)+(r.c6||0)+(r.c7||0)-(r.descuento||0))) || 0;
const pagoSaldo = r => Math.max(0, Math.round((pagoTotal(r) - Number(r.montoPagado || 0)) * 100) / 100);
const pagoEsDeuda = r => { const e = pagoNorm(r.estado || 'pendiente'); return e !== 'pagado' && e !== 'condonado'; };
// Mes actual en hora de México (el servidor corre en UTC)
function pagoIdxHoy() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: 'numeric' }).formatToParts(new Date());
  const y = Number(p.find(x => x.type === 'year').value), m = Number(p.find(x => x.type === 'month').value);
  return y * 12 + (m - 1);
}
function pagoFechaHoyMX() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date()); // YYYY-MM-DD
}
// Mismo reparto que dpPagosCalcDistribucion en el cliente: más viejo → más nuevo
function pagoDistribuir(monto, recibos) {
  const pend = recibos.filter(r => pagoEsDeuda(r) && pagoSaldo(r) > 0).sort((a, b) => pagoPeriodIdx(a) - pagoPeriodIdx(b));
  let restante = Number(monto || 0);
  const lineas = pend.map(r => {
    const saldoPrevio = pagoSaldo(r);
    const aplicar = Math.round(Math.min(restante, saldoPrevio) * 100) / 100;
    restante = Math.max(0, Math.round((restante - aplicar) * 100) / 100);
    const montoPrevio = Number(r.montoPagado || 0);
    const nuevoPagado = Math.round((montoPrevio + aplicar) * 100) / 100;
    const nuevoSaldo = Math.max(0, Math.round((pagoTotal(r) - nuevoPagado) * 100) / 100);
    const nuevoEstado = nuevoSaldo <= 0.0001 ? 'pagado' : (aplicar > 0 ? 'parcial' : pagoNorm(r.estado || 'pendiente'));
    return { reciboId: r.id, mes: r.mes || '', anio: r.anio || '', totalRecibo: pagoTotal(r), saldoPrevio, montoPrevio, montoAplicado: aplicar, nuevoPagado, nuevoSaldo, nuevoEstado };
  });
  const deudaAntes = pend.reduce((s, r) => s + pagoSaldo(r), 0);
  const aplicado = lineas.reduce((s, l) => s + l.montoAplicado, 0);
  return { lineas, sobrante: restante, aplicado, deudaAntes, deudaDespues: Math.max(0, deudaAntes - aplicado) };
}
async function pagoRubroId(nombre, tipo) {
  const s = await db.collection('rubros_financieros').where('nombre', '==', nombre).where('tipo', '==', tipo).limit(5).get();
  const activo = s.docs.find(d => d.data().activo !== false);
  if (activo) return activo.id;
  const ref = await db.collection('rubros_financieros').add({ nombre, tipo, activo: true, creadoEn: new Date().toISOString(), creadoPor: 'stripe' });
  return ref.id;
}
async function pagoTesoreroNombre() {
  const s = await db.collection('usuarios').where('rol', '==', 'tesorero').limit(1).get();
  if (!s.empty) { const u = s.docs[0].data(); return `${u.nombre || ''} ${u.apellido || ''}`.trim(); }
  const c = await db.collection('usuarios').where('cargos', 'array-contains', 'Tesorero').limit(1).get();
  if (!c.empty) { const u = c.docs[0].data(); return `${u.nombre || ''} ${u.apellido || ''}`.trim(); }
  return 'Tesorero del Club';
}

exports.crearCheckoutPago = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Inicia sesión');
  const modo = request.data?.modo;
  if (!['antiguo', 'total'].includes(modo)) throw new HttpsError('invalid-argument', 'Modo de pago inválido');

  const [udSnap, rdSnap] = await Promise.all([db.collection('usuarios').doc(uid).get(), db.collection('roles').doc(uid).get()]);
  if (!udSnap.exists) throw new HttpsError('failed-precondition', 'No se encontró tu perfil');
  const u = udSnap.data();
  const rol = (rdSnap.exists && rdSnap.data().rol) || u.rol || '';
  if (!['socio', 'viuda'].includes(u.tipo) || u.estado === 'baja' || rol === 'pendiente') {
    throw new HttpsError('permission-denied', 'Tu cuenta no puede pagar en línea');
  }
  const key = STRIPE_SECRET_KEY.value();
  if (key.startsWith('sk_test_') && !['admin', 'subadmin'].includes(rol)) {
    throw new HttpsError('failed-precondition', 'El pago con tarjeta está en pruebas. Usa transferencia por ahora.');
  }

  const rs = await db.collection('recibos').where('socioUID', '==', uid).get();
  const pend = rs.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(r => pagoEsDeuda(r) && pagoSaldo(r) > 0)
    .sort((a, b) => pagoPeriodIdx(a) - pagoPeriodIdx(b));
  if (!pend.length) throw new HttpsError('failed-precondition', 'No tienes adeudo pendiente');

  // "antiguo" = solo el recibo más viejo; "total" = todo lo vencido hasta el mes actual
  // (los meses futuros prefacturados no se cobran en "total")
  const idxHoy = pagoIdxHoy();
  const sel = modo === 'antiguo' ? [pend[0]] : pend.filter(r => pagoPeriodIdx(r) <= idxHoy);
  if (!sel.length) throw new HttpsError('failed-precondition', 'No tienes meses vencidos por pagar');
  if (sel.some(r => r.revisionPago?.estado === 'pendiente_revision')) {
    throw new HttpsError('failed-precondition', 'Tienes un comprobante de transferencia en revisión. Espera a que tesorería lo confirme.');
  }
  const monto = Math.round(sel.reduce((s, r) => s + pagoSaldo(r), 0) * 100) / 100;
  const centavos = Math.round(monto * 100);
  if (centavos < 1000) throw new HttpsError('failed-precondition', 'El monto mínimo para pagar con tarjeta es $10.00');

  const periodos = sel.map(r => `${r.mes} ${r.anio}`).join(', ');
  const nombre = `${u.nombre || ''} ${u.apellido || ''}`.trim();
  const pagoRef = db.collection('pagos_en_linea').doc();
  await pagoRef.set({
    socioUID: uid, nombreSocio: nombre, numeroSocio: u.numeroSocio || '',
    modo, reciboIds: sel.map(r => r.id), periodos,
    saldosEsperados: Object.fromEntries(sel.map(r => [r.id, Number(r.montoPagado || 0)])),
    monto, montoCentavos: centavos, moneda: 'mxn',
    proveedor: 'stripe', modoStripe: key.startsWith('sk_test_') ? 'prueba' : 'real',
    estado: 'creado', creadoEn: new Date().toISOString(),
  });

  const stripe = require('stripe')(key);
  const APP_URL = process.env.APP_URL || 'https://app-club-de-leones.web.app';
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    locale: 'es',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'mxn',
        unit_amount: centavos,
        product_data: { name: `Cuotas Club de Leones Veracruz — ${periodos}`.slice(0, 250), description: `Socio: ${nombre}${u.numeroSocio ? ' · No. ' + u.numeroSocio : ''}`.slice(0, 250) },
      },
    }],
    customer_email: u.correo || undefined,
    client_reference_id: pagoRef.id,
    metadata: { pagoId: pagoRef.id, socioUID: uid },
    payment_intent_data: { metadata: { pagoId: pagoRef.id, socioUID: uid }, description: `Cuotas ${periodos} — ${nombre}`.slice(0, 500) },
    success_url: `${APP_URL}/?pago=ok&pid=${pagoRef.id}`,
    cancel_url: `${APP_URL}/?pago=cancelado&pid=${pagoRef.id}`,
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
  });
  await pagoRef.update({ stripeSessionId: session.id });
  return { url: session.url, monto, periodos };
});

// Aplica un pago confirmado por Stripe. Idempotente: si pagos_en_linea ya está
// 'aplicado' no hace nada (Stripe puede reenviar el mismo evento).
async function pagoAplicarSesion(stripe, session) {
  const pagoId = session.metadata?.pagoId || session.client_reference_id;
  if (!pagoId) { console.warn('stripe: sesión sin pagoId', session.id); return; }
  const pagoRef = db.collection('pagos_en_linea').doc(pagoId);
  const pre = await pagoRef.get();
  if (!pre.exists) { console.warn('stripe: pagos_en_linea no existe', pagoId); return; }
  if (pre.data().estado === 'aplicado') return;

  const p = pre.data();
  const montoCobrado = Number(session.amount_total || 0) / 100;
  const fecha = pagoFechaHoyMX();
  const ahora = new Date().toISOString();
  const [rubroIngreso, tesoreroNombre] = await Promise.all([pagoRubroId('Cuotas de Socios', 'ingreso'), pagoTesoreroNombre()]);

  const resultado = await db.runTransaction(async (tx) => {
    const cur = await tx.get(pagoRef);
    if (cur.data().estado === 'aplicado') return null;
    const snaps = await Promise.all(p.reciboIds.map(id => tx.get(db.collection('recibos').doc(id))));
    const recibos = snaps.filter(s => s.exists).map(s => ({ id: s.id, ...s.data() }));
    const dist = pagoDistribuir(montoCobrado, recibos);
    const afectadas = dist.lineas.filter(l => l.montoAplicado > 0);
    // Si algo cambió desde que se creó el cobro (p. ej. tesorería registró otro
    // pago), lo que no se pudo aplicar queda como sobrante para revisión manual.
    const requiereRevision = dist.sobrante > 0.009 || session.currency !== 'mxn' || Math.round(montoCobrado * 100) !== p.montoCentavos;

    const movRef = db.collection('movimientos_financieros').doc();
    const pagoSocioRef = db.collection('pagos_socios').doc();
    const periodos = afectadas.map(l => `${l.mes} ${l.anio}`).join(', ') || p.periodos;
    if (dist.aplicado > 0) {
      tx.set(movRef, {
        tipo: 'ingreso', rubroId: rubroIngreso, rubroNombre: 'Cuotas de Socios',
        concepto: `Cuotas — ${p.nombreSocio} (${periodos}) · Pago con tarjeta en línea`,
        monto: dist.aplicado, fecha, metodoPago: 'tarjeta', destino: 'banco',
        autoGenerado: true, origen: 'pago_socio', registradoPor: 'stripe', registradoPorNombre: 'Pago en línea (Stripe)',
        referencia: session.payment_intent || session.id, pagoEnLineaId: pagoId, creadoEn: ahora,
      });
      tx.set(pagoSocioRef, {
        socioUID: p.socioUID, nombreSocio: p.nombreSocio, numeroSocio: p.numeroSocio || '',
        montoTotal: dist.aplicado, sobrante: dist.sobrante, fechaPago: fecha,
        metodoPago: 'tarjeta', destino: 'banco', destinoLabel: 'tarjeta',
        referencia: String(session.payment_intent || session.id), desglose: afectadas,
        deudaAntes: dist.deudaAntes, deudaDespues: dist.deudaDespues, movimientoFinId: movRef.id,
        tesoreroNombre, creadoPorUid: p.socioUID, creadoPorNombre: `${p.nombreSocio} (pago en línea)`,
        creadoEn: ahora, pagoEnLineaId: pagoId,
      });
      const fechaIso = new Date(fecha + 'T12:00:00').toISOString();
      for (const l of afectadas) {
        const up = { montoPagado: l.nuevoPagado, estado: l.nuevoEstado, fechaUltimoAbono: fechaIso, pagoSocioId: pagoSocioRef.id, modificado: ahora };
        if (l.nuevoEstado === 'pagado') { up.fechaPago = fecha; up.movimientoFinId = movRef.id; up.movimientoDestino = 'tarjeta'; }
        tx.update(db.collection('recibos').doc(l.reciboId), up);
      }
    }
    tx.update(pagoRef, {
      estado: 'aplicado', aplicadoEn: ahora, montoCobrado, montoAplicado: dist.aplicado, sobrante: dist.sobrante,
      requiereRevision, stripePaymentIntent: String(session.payment_intent || ''),
      movimientoFinId: dist.aplicado > 0 ? movRef.id : null, pagoSocioId: dist.aplicado > 0 ? pagoSocioRef.id : null,
    });
    return { dist, afectadas, requiereRevision };
  });
  if (!resultado) return;

  // Comisión de Stripe: la absorbe el club → egreso en "Comisiones bancarias"
  try {
    const pi = await stripe.paymentIntents.retrieve(session.payment_intent, { expand: ['latest_charge.balance_transaction'] });
    const bt = pi.latest_charge?.balance_transaction;
    const fee = bt && typeof bt === 'object' ? Number(bt.fee || 0) / 100 : 0;
    if (fee > 0) {
      const rubroEgreso = await pagoRubroId('Comisiones bancarias', 'egreso');
      const feeRef = await db.collection('movimientos_financieros').add({
        tipo: 'egreso', rubroId: rubroEgreso, rubroNombre: 'Comisiones bancarias',
        concepto: `Comisión Stripe — pago de ${p.nombreSocio} (${p.periodos})`,
        monto: fee, fecha, metodoPago: 'transferencia', destino: 'banco',
        autoGenerado: true, origen: 'comision_stripe', registradoPor: 'stripe', registradoPorNombre: 'Pago en línea (Stripe)',
        referencia: String(session.payment_intent), pagoEnLineaId: pagoId, creadoEn: new Date().toISOString(),
      });
      await pagoRef.update({ comision: fee, comisionMovId: feeRef.id });
    }
  } catch (e) { console.error('stripe: no se pudo registrar comisión', pagoId, e.message); }

  await db.collection('adeudos').doc(p.socioUID).set({ ultimoPagoAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
  await db.collection('auditoria').add({
    uid: p.socioUID, nombre: p.nombreSocio, rol: 'socio', accion: 'pago_en_linea_tarjeta', modulo: 'pagos',
    datos: { pagoId, monto: montoCobrado, aplicado: resultado.dist.aplicado, sobrante: resultado.dist.sobrante, periodos: p.periodos, paymentIntent: String(session.payment_intent || '') },
    severidad: resultado.requiereRevision ? 'importante' : 'normal', categoria: 'finanzas', origen: 'servidor',
    revisado: false, ip: '', dispositivo: 'Stripe', fecha: new Date().toISOString(),
  }).catch(() => {});
  // Push al socio
  try {
    const ud = await db.collection('usuarios').doc(p.socioUID).get();
    const token = ud.exists ? ud.data().fcmToken : null;
    if (token) await sendMulticast([token], '✅ Pago recibido', `Tu pago de $${montoCobrado.toFixed(2)} (${p.periodos}) quedó registrado. ¡Gracias!`);
  } catch (e) { console.warn('stripe: push', e.message); }
}

exports.stripeWebhook = onRequest({ secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }
  const stripe = require('stripe')(STRIPE_SECRET_KEY.value());
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET.value());
  } catch (e) {
    console.warn('stripe: firma inválida', e.message);
    res.status(400).send('Firma inválida'); return;
  }
  try {
    const session = event.data.object;
    if ((event.type === 'checkout.session.completed' && session.payment_status === 'paid') ||
        event.type === 'checkout.session.async_payment_succeeded') {
      await pagoAplicarSesion(stripe, session);
    } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      const pagoId = session.metadata?.pagoId;
      if (pagoId) {
        const ref = db.collection('pagos_en_linea').doc(pagoId);
        await db.runTransaction(async tx => {
          const s = await tx.get(ref);
          if (s.exists && s.data().estado === 'creado') tx.update(ref, { estado: event.type.endsWith('expired') ? 'expirado' : 'fallido', actualizadoEn: new Date().toISOString() });
        });
      }
    }
    res.json({ received: true });
  } catch (e) {
    console.error('stripe: error aplicando evento', event.id, e);
    res.status(500).send('Error'); // Stripe reintenta
  }
});
