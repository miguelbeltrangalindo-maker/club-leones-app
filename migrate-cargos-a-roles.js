// ═══════════════════════════════════════════════════════════
//  migrate-cargos-a-roles.js  —  Club de Leones Veracruz
//
//  Migra Tesoreros identificados por cargos[] al sistema /roles/.
//  La regla isTesorero() tiene un fallback que mira cargos[]; tras
//  esta migración podemos eliminarlo y reducir superficie de ataque.
//
//  Uso:
//    node migrate-cargos-a-roles.js             (dry-run, no escribe)
//    node migrate-cargos-a-roles.js --apply     (aplica cambios)
//
//  Política conservadora:
//   • Solo migramos cuando NO hay conflicto: el usuario debe estar en
//     /roles/ como 'pendiente', 'miembro', 'usuario', sin rol, o sin doc.
//   • Si ya es admin / subadmin / tesorero / mutualista / cantinero en
//     /roles/, NO tocamos y reportamos como "skip" (ya tiene rol fuerte).
//   • Conflictos (cargos=Tesorero pero rol=otra cosa fuerte) se imprimen
//     como CONFLICT para revisión manual.
// ═══════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const APPLY = process.argv.includes('--apply');

const TIENE_ROL_FUERTE = new Set([
  'admin', 'subadmin', 'tesorero', 'mutualista', 'cantinero',
  'dama_admin', 'dama_admin_paloma'
]);
const ROL_SOBRESCRIBIBLE = new Set(['', 'pendiente', 'miembro', 'usuario']);

function tieneCargoTesorero(cargos) {
  if (!Array.isArray(cargos)) return false;
  return cargos.some(c => typeof c === 'string' && c.toLowerCase() === 'tesorero');
}

async function migrate() {
  console.log(`🦁 migrate-cargos-a-roles  —  modo: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

  const usuariosSnap = await db.collection('usuarios').get();

  const filas = { migrate: [], skip: [], conflict: [], noCargo: 0 };

  for (const userSnap of usuariosSnap.docs) {
    const uid = userSnap.id;
    const u = userSnap.data();
    const nombre = `${u.nombre || ''} ${u.apellido || ''}`.trim() || '(sin nombre)';

    if (!tieneCargoTesorero(u.cargos)) { filas.noCargo++; continue; }

    const roleSnap = await db.collection('roles').doc(uid).get();
    const rolActual = roleSnap.exists ? (roleSnap.data().rol || '') : '';

    const fila = { uid, nombre, cargos: u.cargos, rolActual, tieneDoc: roleSnap.exists };

    if (rolActual === 'tesorero') {
      filas.skip.push({ ...fila, motivo: 'ya es tesorero en /roles/' });
    } else if (TIENE_ROL_FUERTE.has(rolActual)) {
      filas.conflict.push({ ...fila, motivo: `rol fuerte distinto: ${rolActual}` });
    } else if (ROL_SOBRESCRIBIBLE.has(rolActual)) {
      filas.migrate.push(fila);
    } else {
      filas.conflict.push({ ...fila, motivo: `rol inesperado: ${rolActual}` });
    }
  }

  console.log(`Usuarios totales:                  ${usuariosSnap.size}`);
  console.log(`Sin 'Tesorero' en cargos[]:        ${filas.noCargo}`);
  console.log(`Ya con rol tesorero (skip):        ${filas.skip.length}`);
  console.log(`A migrar a /roles/ tesorero:       ${filas.migrate.length}`);
  console.log(`Conflictos (revisar manualmente):  ${filas.conflict.length}\n`);

  if (filas.migrate.length) {
    console.log('═══ A MIGRAR ═══');
    filas.migrate.forEach(f => {
      console.log(`  ${f.uid}  —  ${f.nombre}`);
      console.log(`    rol actual: '${f.rolActual}'  (doc: ${f.tieneDoc ? 'sí' : 'no'}), cargos: ${JSON.stringify(f.cargos)}`);
    });
    console.log('');
  }

  if (filas.conflict.length) {
    console.log('⚠️  CONFLICTOS — NO se tocan, revisar manualmente:');
    filas.conflict.forEach(f => {
      console.log(`  ${f.uid}  —  ${f.nombre}`);
      console.log(`    motivo: ${f.motivo}, cargos: ${JSON.stringify(f.cargos)}`);
    });
    console.log('');
  }

  if (filas.skip.length) {
    console.log('✅ YA migrados (skip):');
    filas.skip.forEach(f => console.log(`  ${f.uid}  —  ${f.nombre}`));
    console.log('');
  }

  if (!APPLY) {
    console.log('🔎 DRY-RUN: no se escribió nada. Re-corre con --apply para aplicar.');
    return;
  }

  if (!filas.migrate.length) {
    console.log('✨ Sin cambios que aplicar.');
    return;
  }

  console.log('💾 Aplicando cambios…');
  let exitos = 0, errores = 0;
  for (const f of filas.migrate) {
    try {
      await db.collection('roles').doc(f.uid).set({
        rol: 'tesorero',
        activo: true,
        migratedFromCargosAt: new Date().toISOString()
      }, { merge: true });
      console.log(`  ✅ ${f.uid}  —  ${f.nombre}`);
      exitos++;
    } catch (e) {
      console.error(`  ❌ ${f.uid}  —  ${e.message}`);
      errores++;
    }
  }
  console.log(`\nResultado: ${exitos} aplicados, ${errores} errores.`);
}

migrate()
  .then(() => process.exit(0))
  .catch(err => { console.error('Error general:', err); process.exit(1); });
