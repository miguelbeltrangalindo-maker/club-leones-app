// ════════════════════════════════════════════════════════════════
//  Audita coherencia entre Firebase Auth email y Firestore `correo`.
//  Uso (desde la raíz del repo):
//    cd functions && node auditEmails.js
//  Lista mismatches, docs huérfanos y socios offline para reconciliar.
// ════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

admin.initializeApp({ projectId: 'app-club-de-leones' });
const db = admin.firestore();

async function auditEmails() {
  console.log('🔍 Auditando emails Auth vs Firestore...\n');

  const stats = { total: 0, ok: 0, mismatch: 0, missingDoc: 0, missingFsEmail: 0 };
  const filas = [];

  // 1) Recorrer todos los usuarios de Firebase Auth
  let nextPageToken;
  const authUidSet = new Set();
  do {
    const r = await admin.auth().listUsers(1000, nextPageToken);
    for (const u of r.users) {
      stats.total++;
      authUidSet.add(u.uid);
      const authEmail = (u.email || '').toLowerCase();
      const fsSnap = await db.collection('usuarios').doc(u.uid).get();
      if (!fsSnap.exists) {
        stats.missingDoc++;
        filas.push({ tipo: 'AUTH_SIN_DOC', uid: u.uid, authEmail, fsEmail: '—', nombre: '—' });
        continue;
      }
      const d = fsSnap.data();
      const fsEmail = (d.correo || '').toLowerCase();
      const nombre = `${d.nombre || ''} ${d.apellido || ''}`.trim() || '(sin nombre)';
      if (!fsEmail) {
        stats.missingFsEmail++;
        filas.push({ tipo: 'FS_SIN_CORREO', uid: u.uid, authEmail, fsEmail: '—', nombre });
      } else if (authEmail && authEmail !== fsEmail) {
        stats.mismatch++;
        filas.push({ tipo: 'MISMATCH', uid: u.uid, authEmail, fsEmail: d.correo, nombre });
      } else {
        stats.ok++;
      }
    }
    nextPageToken = r.pageToken;
  } while (nextPageToken);

  // 2) Detectar docs de usuarios online en Firestore que no tengan Auth (sin contar offline)
  const fsSnap = await db.collection('usuarios').get();
  let huerfanos = 0;
  fsSnap.forEach(d => {
    const data = d.data();
    if (data.offline === true) return;        // socios offline no deben tener Auth
    if (data.migrado === true) return;        // docs offline ya migrados
    if (authUidSet.has(d.id)) return;
    huerfanos++;
    filas.push({ tipo: 'DOC_SIN_AUTH', uid: d.id, authEmail: '—', fsEmail: data.correo || '—', nombre: `${data.nombre||''} ${data.apellido||''}`.trim() || '(sin nombre)' });
  });

  // ── Reporte ──────────────────────────────────────────────────────────────
  console.log('═══ RESUMEN ═══');
  console.log(`Total Auth users:       ${stats.total}`);
  console.log(`✅ Coincidentes:        ${stats.ok}`);
  console.log(`❌ Desincronizados:     ${stats.mismatch}`);
  console.log(`⚠️  Auth sin doc FS:     ${stats.missingDoc}`);
  console.log(`⚠️  FS sin correo:       ${stats.missingFsEmail}`);
  console.log(`⚠️  Doc FS sin Auth:     ${huerfanos}\n`);

  if (!filas.length) {
    console.log('🎉 Sin incidencias. Todo en orden.\n');
    return;
  }

  const grupos = {
    'MISMATCH':      '❌ DESINCRONIZADOS (corregir con cambiarCorreoUsuario o Firebase Console)',
    'FS_SIN_CORREO': '⚠️  FS_SIN_CORREO (socio sin correo en Firestore)',
    'AUTH_SIN_DOC':  '⚠️  AUTH_SIN_DOC (Auth user huérfano — revisar manualmente)',
    'DOC_SIN_AUTH':  '⚠️  DOC_SIN_AUTH (doc Firestore sin cuenta Auth — socio offline o registro incompleto)'
  };

  for (const [tipo, titulo] of Object.entries(grupos)) {
    const sub = filas.filter(f => f.tipo === tipo);
    if (!sub.length) continue;
    console.log(`\n${titulo}  (${sub.length})`);
    console.log('─'.repeat(80));
    sub.forEach(f => {
      console.log(`UID:   ${f.uid}  —  ${f.nombre}`);
      console.log(`  Auth:      ${f.authEmail}`);
      console.log(`  Firestore: ${f.fsEmail}`);
    });
  }
  console.log('');
}

auditEmails()
  .then(() => process.exit(0))
  .catch(e => { console.error('❌ ERROR:', e); process.exit(1); });
