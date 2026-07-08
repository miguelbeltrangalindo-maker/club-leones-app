// ════════════════════════════════════════════════════════════════
//  Backfill: recibos de Junio 2026 hacia atrás → tesoreroNombre fijo.
//  Uso (desde functions/):  node backfillTesoreroHist.js [--apply]
//    sin --apply = DRY RUN (solo cuenta y muestra, no escribe)
//    con --apply = ejecuta la actualización en lotes
// ════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'app-club-de-leones' });
const db = admin.firestore();

const TESORERO = 'Rafael Contreras Fernández';
const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const CUTOFF = 2026 * 12 + MESES.indexOf('Junio'); // Junio 2026 inclusive
const APPLY = process.argv.includes('--apply');

function periodIdx(r) {
  const mi = MESES.indexOf(r.mes);
  return Number(r.anio || 0) * 12 + (mi < 0 ? 0 : mi);
}

(async () => {
  console.log(`\n${APPLY ? '⚙️  APLICANDO' : '🔍 DRY RUN'} — recibos de Junio 2026 hacia atrás → "${TESORERO}"\n`);

  // 1) Buscar al socio para confirmar la grafía exacta
  const us = await db.collection('usuarios').get();
  const matches = [];
  us.forEach(d => {
    const u = d.data();
    const full = `${u.nombre || ''} ${u.apellido || ''}`.trim();
    if (/rafael/i.test(full) && /contreras/i.test(full)) matches.push(full);
  });
  console.log('👤 Socios que coinciden con "Rafael Contreras":', matches.length ? matches.join(' | ') : '(ninguno)');

  // 2) Recorrer recibos
  const snap = await db.collection('recibos').get();
  let total = 0, enRango = 0, yaCorrecto = 0, aCambiar = 0;
  const porPeriodo = {};
  const cambios = [];
  snap.forEach(d => {
    total++;
    const r = d.data();
    if (periodIdx(r) > CUTOFF) return;
    enRango++;
    const key = `${r.anio}-${String(MESES.indexOf(r.mes)+1).padStart(2,'0')} ${r.mes}`;
    porPeriodo[key] = (porPeriodo[key] || 0) + 1;
    if (r.tesoreroNombre === TESORERO) { yaCorrecto++; return; }
    aCambiar++;
    cambios.push(d.id);
  });

  console.log(`\n📊 Recibos totales: ${total}`);
  console.log(`   En rango (≤ Junio 2026): ${enRango}`);
  console.log(`   Ya con "${TESORERO}": ${yaCorrecto}`);
  console.log(`   A actualizar: ${aCambiar}`);
  console.log('\n📅 Desglose por periodo (en rango):');
  Object.keys(porPeriodo).sort().forEach(k => console.log(`   ${k.slice(8)} ${k.slice(0,4)}: ${porPeriodo[k]}`));

  if (!APPLY) {
    console.log('\n(DRY RUN — no se escribió nada. Corre con --apply para actualizar.)\n');
    return;
  }

  // 3) Aplicar en lotes de 400
  let done = 0;
  for (let i = 0; i < cambios.length; i += 400) {
    const batch = db.batch();
    cambios.slice(i, i + 400).forEach(id => {
      batch.update(db.collection('recibos').doc(id), {
        tesoreroNombre: TESORERO,
        tesoreroBackfill: true,
        modificado: new Date().toISOString(),
      });
    });
    await batch.commit();
    done += Math.min(400, cambios.length - i);
    console.log(`   ...actualizados ${done}/${cambios.length}`);
  }
  console.log(`\n✅ Listo. ${done} recibos actualizados a "${TESORERO}".\n`);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
