// Consolida la cuenta partida de Enrique Garrido Bravo / Enrique Gilberto Garrido
// Bravo: reasigna recibos y pagos_socios del registro offline #45678 hacia la
// cuenta real (con la que hace login, #123456), y retira el registro offline
// (queda oculto, no se borra).
// Replica exactamente la lógica de consolidarCuentaOffline() en public/index.html,
// vía Admin SDK porque el registro offline no tiene sesión propia para ejecutarlo
// desde el cliente.
// Uso: node consolidarEnriqueGarrido.js
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'app-club-de-leones' });
const db = admin.firestore();

const OFFLINE_ID = 'offline_1788025567112_uj9t89';   // Enrique Gilberto Garrido Bravo — registro offline #45678 (recibo/pago reales)
const NEW_UID    = 'lrpnnyVYWoNNsdRqDwY1BcWQoKG3';   // Enrique Garrido Bravo — cuenta real (login) #123456
const EJECUTADO_POR_UID    = 'HHTYu5CJj2cxYv2Y5O7hbniO1jJ3'; // Miguel Ángel Beltrán Galindo (admin que autorizó)
const EJECUTADO_POR_NOMBRE = 'Miguel Ángel Beltrán Galindo';

async function consolidarCuentaOffline(offlineId, newUid) {
  const res = { recibos: 0, pagos: 0, copiados: [] };
  if (!offlineId || !newUid || offlineId === newUid) return res;

  const [offSnap, newSnap] = await Promise.all([
    db.collection('usuarios').doc(offlineId).get(),
    db.collection('usuarios').doc(newUid).get(),
  ]);
  if (!offSnap.exists) throw new Error(`No existe el doc offline ${offlineId}`);
  if (!newSnap.exists) throw new Error(`No existe el doc destino ${newUid}`);
  const off = offSnap.data();
  const nw  = newSnap.data();

  // 1) Heredar campos vacíos en la cuenta nueva desde la cuenta offline
  const heredables = ['numeroSocio','cargosHistoricos','whatsapp','fechaIngreso','conyuge','fechaNacimiento','padrinoUID','padrinoNombre'];
  const patch = {};
  heredables.forEach(k => {
    const cur = nw[k];
    const vacio = cur == null || cur === '' || (Array.isArray(cur) && cur.length === 0);
    const tieneOff = off[k] != null && off[k] !== '' && !(Array.isArray(off[k]) && off[k].length === 0);
    if (vacio && tieneOff) patch[k] = off[k];
  });
  if (Object.keys(patch).length) {
    await db.collection('usuarios').doc(newUid).update(patch);
    res.copiados = Object.keys(patch);
  }

  // 2) Reasignar recibos
  const recSnap = await db.collection('recibos').where('socioUID', '==', offlineId).get();
  for (const d of recSnap.docs) {
    await d.ref.update({ socioUID: newUid, migracionDesde: offlineId });
    res.recibos++;
  }

  // 3) Reasignar pagos_socios
  const psSnap = await db.collection('pagos_socios').where('socioUID', '==', offlineId).get();
  for (const d of psSnap.docs) {
    await d.ref.update({ socioUID: newUid });
    res.pagos++;
  }

  // 4) Retirar la cuenta offline (queda oculta de directorio/estadísticas)
  await db.collection('usuarios').doc(offlineId).update({
    migrado: true, migradoA: newUid, offline: false, activo: false,
    consolidadoEn: new Date().toISOString(),
  });

  return res;
}

(async () => {
  console.log(`Consolidando ${OFFLINE_ID} → ${NEW_UID} ...`);
  const res = await consolidarCuentaOffline(OFFLINE_ID, NEW_UID);
  console.log('Resultado:', res);

  await db.collection('auditoria').add({
    uid: EJECUTADO_POR_UID,
    nombre: EJECUTADO_POR_NOMBRE,
    rol: 'admin',
    accion: 'consolidar_offline',
    modulo: 'socios',
    registro: NEW_UID,
    antes: null,
    despues: null,
    datos: { offlineId: OFFLINE_ID, newUid: NEW_UID, recibos: res.recibos, pagos: res.pagos, copiados: res.copiados, via: 'script consolidarEnriqueGarrido.js' },
    severidad: 'importante',
    categoria: 'socios',
    origen: 'admin',
    revisado: false,
    ip: 'script-admin-sdk',
    dispositivo: 'Escritorio',
    fecha: new Date().toISOString(),
  });
  console.log('✅ Auditoría registrada.');
  process.exit(0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
