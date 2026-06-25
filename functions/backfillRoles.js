const admin = require("firebase-admin");

admin.initializeApp({
  projectId: "app-club-de-leones",
});

const db = admin.firestore();

async function backfillRoles() {
  console.log("🔥 Iniciando backfill de roles...");

  let nextPageToken;
  let created = 0;
  let existing = 0;

  do {
    const listUsersResult = await admin.auth().listUsers(1000, nextPageToken);

    for (const user of listUsersResult.users) {
      const uid = user.uid;
      const roleRef = db.collection("roles").doc(uid);
      const roleDoc = await roleRef.get();

      if (!roleDoc.exists) {
        await roleRef.set({
          rol: "usuario",
          activo: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`✅ Rol creado para ${uid}`);
        created++;
      } else {
        console.log(`ℹ️ Ya existía rol para ${uid}`);
        existing++;
      }
    }

    nextPageToken = listUsersResult.pageToken;
  } while (nextPageToken);

  console.log(`🎯 Backfill terminado. Creados: ${created}. Existentes: ${existing}.`);
}

backfillRoles()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Error en backfill:", err);
    process.exit(1);
  });