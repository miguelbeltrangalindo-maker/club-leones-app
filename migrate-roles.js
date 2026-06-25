// ═══════════════════════════════════════════════════════════
//  migrate-roles.js  —  Club de Leones Veracruz
//  Ejecutar UNA sola vez desde la raíz del proyecto:
//    node migrate-roles.js
//
//  Qué hace:
//  1. Crea/sincroniza documentos en /roles/{uid} para todos los usuarios.
//  2. Normaliza el rol 'usuario' (legacy) → 'miembro' en ambas colecciones.
// ═══════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function migrateRoles() {
  console.log('🦁 Iniciando migración de roles — Club de Leones\n');

  const usuariosSnap = await db.collection('usuarios').get();

  if (usuariosSnap.empty) {
    console.log('No hay usuarios para migrar.');
    return;
  }

  let total = 0, creados = 0, actualizados = 0, normalizados = 0, errores = 0;

  for (const docSnap of usuariosSnap.docs) {
    total++;
    const uid = docSnap.id;
    const data = docSnap.data();

    // Normalizar 'usuario' → 'miembro'
    const rolOriginal = data.rol || 'pendiente';
    const rolFinal = rolOriginal === 'usuario' ? 'miembro' : rolOriginal;
    const activo = data.activo !== false;

    try {
      const batch = db.batch();

      // Corregir el documento /usuarios/{uid} si tiene rol 'usuario'
      if (rolOriginal === 'usuario') {
        batch.update(db.collection('usuarios').doc(uid), { rol: 'miembro' });
        normalizados++;
        console.log(`🔄 Normalizado usuarios/${uid}: 'usuario' → 'miembro'`);
      }

      // Crear o sincronizar /roles/{uid}
      const roleRef = db.collection('roles').doc(uid);
      const roleSnap = await roleRef.get();

      const rolePayload = {
        rol: rolFinal,
        activo,
        migratedAt: new Date().toISOString()
      };

      if (!roleSnap.exists) {
        batch.set(roleRef, { ...rolePayload, createdAt: new Date().toISOString() });
        creados++;
        console.log(`✅ Creado   roles/${uid} → ${rolFinal}`);
      } else {
        const existingRol = roleSnap.data().rol;
        const normalizedExisting = existingRol === 'usuario' ? 'miembro' : existingRol;
        // Solo actualizar si hay cambio real
        if (existingRol !== normalizedExisting || !roleSnap.data().migratedAt) {
          batch.set(roleRef, { ...rolePayload, rol: normalizedExisting }, { merge: true });
          actualizados++;
          console.log(`♻️ Actualizado roles/${uid} → ${normalizedExisting}`);
        }
      }

      await batch.commit();

    } catch (error) {
      errores++;
      console.error(`❌ Error en ${uid}:`, error.message);
    }
  }

  console.log('\n═══════════ RESUMEN ═══════════');
  console.log(`Total usuarios procesados : ${total}`);
  console.log(`Roles creados             : ${creados}`);
  console.log(`Roles actualizados        : ${actualizados}`);
  console.log(`Roles normalizados        : ${normalizados}  (usuario → miembro)`);
  console.log(`Errores                   : ${errores}`);
  console.log('═══════════════════════════════');
  console.log('✅ Migración completa.\n');
}

migrateRoles()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error general:', err);
    process.exit(1);
  });
