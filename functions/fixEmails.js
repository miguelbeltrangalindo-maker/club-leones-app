// ════════════════════════════════════════════════════════════════
//  Script one-off: arregla emails de Auth desincronizados.
//  Uso (desde la raíz del repo):
//    cd functions && node fixEmails.js
//  Edita FIXES[] abajo si encuentras más casos en el futuro.
// ════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

admin.initializeApp({ projectId: 'app-club-de-leones' });
const db = admin.firestore();

// Cada entrada: { uid, nuevoEmail, motivo }
const FIXES = [
  {
    uid: 'fVjhClwSbcczDejztN7TNUw7mQy2',
    nuevoEmail: 'navilac@gmail.com',
    motivo: 'Noel Ávila — Auth tenía avila_noel@hotmail.com, Firestore navilac@gmail.com'
  },
  {
    uid: 'iS7RHVh0DwOsWAi7AKEpDV5YFKH3',
    nuevoEmail: 'marcosagustin_47@hotmail.com',
    motivo: 'Marcos Aguirre — corregir typo "hotmsil" → "hotmail" en Auth'
  }
];

// UIDs de cuentas Auth huérfanas a borrar (sin doc en Firestore = test/junk)
// Safety: el script omite cualquier UID que sí tenga doc Firestore.
const DELETE_ORPHANS = [
  '9lsHi8p8OCemzP88mmg2MpAvVnk1',  // prueba@paloma.com
  'JfDcyuBAQdVzq3xBNaK9wd85Ygi1',  // cul@hks.com
  'VTocf7QASMNxT1b8n1N576NJJ903',  // dzoara80@hotmail.com
  'jlurcitiliSUz4Jy4wOGxffHhQG3',  // oscarcp72@hotmail.con (typo .con)
  'p7PuyqfmU6O8dB11cJkxZHVdE413',  // navilac@gmail.com — duplicado de Noel
  'v3lG3IowbwPvsAPEFzyCyuiDO1v2',  // soniia.ol@hot.com
];

async function fix() {
  console.log('🔧 Corrigiendo emails de Auth...\n');

  for (const f of FIXES) {
    try {
      const before = await admin.auth().getUser(f.uid);
      console.log(`▶ ${f.uid}`);
      console.log(`   Motivo: ${f.motivo}`);
      console.log(`   Auth actual:  ${before.email}`);

      await admin.auth().updateUser(f.uid, { email: f.nuevoEmail, emailVerified: false });

      // Asegurar que Firestore quede igual
      const fsRef = db.collection('usuarios').doc(f.uid);
      const fsSnap = await fsRef.get();
      if (fsSnap.exists && (fsSnap.data().correo || '').toLowerCase() !== f.nuevoEmail.toLowerCase()) {
        await fsRef.update({ correo: f.nuevoEmail });
        console.log(`   ✏️  Firestore correo también actualizado a ${f.nuevoEmail}`);
      }
      console.log(`   ✅ Auth actualizado a ${f.nuevoEmail}\n`);
    } catch (e) {
      console.error(`   ❌ ERROR en ${f.uid}: ${e.message}\n`);
    }
  }

  console.log('🧹 Borrando cuentas Auth huérfanas listadas...\n');
  for (const uid of DELETE_ORPHANS) {
    try {
      const u = await admin.auth().getUser(uid);
      // Seguridad: solo borrar si no existe doc Firestore
      const fsSnap = await db.collection('usuarios').doc(uid).get();
      if (fsSnap.exists) {
        console.log(`   ⚠️  ${uid} (${u.email}) tiene doc Firestore — NO se borra. Revísalo a mano.`);
        continue;
      }
      await admin.auth().deleteUser(uid);
      console.log(`   ✅ Borrado ${uid} (${u.email})`);
    } catch (e) {
      console.error(`   ❌ ERROR borrando ${uid}: ${e.message}`);
    }
  }
  console.log('\n🎯 Listo.');
}

fix()
  .then(() => process.exit(0))
  .catch(e => { console.error('❌ ERROR FATAL:', e); process.exit(1); });
