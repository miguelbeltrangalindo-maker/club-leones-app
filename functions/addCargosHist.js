// ════════════════════════════════════════════════════════════════
//  Agrega historial de cargos a un socio (cargosHistoricos en usuarios).
//  Uso (desde functions/):  node addCargosHist.js [--apply]
//    sin --apply = DRY RUN (busca al socio y muestra qué escribiría)
//    con --apply = fusiona (sin duplicar) y guarda
// ════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'app-club-de-leones' });
const db = admin.firestore();

const APPLY = process.argv.includes('--apply');

// Coincidencia del socio (nombre + apellido, sin importar acentos/mayúsculas)
const MATCH = ['miguel', 'beltran', 'galindo'];

// Cargos de la imagen del Portal del León (Lions International)
const CARGOS = [
  { cargo:'Jefe de Zona',                cuenta:'District B 7', estado:'Completed', fechaInicio:'2022-08-17', fechaFin:'2023-05-10' },
  { cargo:'Presidente del Club',         cuenta:'VERACRUZ',     estado:'Completed', fechaInicio:'2021-07-01', fechaFin:'2022-06-30' },
  { cargo:'Vicepresidente de Club',      cuenta:'VERACRUZ',     estado:'Completed', fechaInicio:'2020-07-01', fechaFin:'2021-06-30' },
  { cargo:'Secretario del Club',         cuenta:'VERACRUZ',     estado:'Completed', fechaInicio:'2023-07-01', fechaFin:'2024-06-30' },
  { cargo:'Secretario del Club',         cuenta:'VERACRUZ',     estado:'Completed', fechaInicio:'2018-07-01', fechaFin:'2019-06-30' },
  { cargo:'Secretario del Club',         cuenta:'VERACRUZ',     estado:'Pending',   fechaInicio:'2026-07-01', fechaFin:'2027-06-30' },
  { cargo:'Tesorero del Club',           cuenta:'VERACRUZ',     estado:'Completed', fechaInicio:'2025-07-01', fechaFin:'2025-08-15' },
  { cargo:'Coordinador de LCIF de Club', cuenta:'VERACRUZ',     estado:'Completed', fechaInicio:'2022-10-25', fechaFin:'2023-06-30' },
  { cargo:'Asesor de Mercadotecnia',     cuenta:'VERACRUZ',     estado:'Completed', fechaInicio:'2024-03-08', fechaFin:'2024-06-30' },
  { cargo:'Director de Club',            cuenta:'VERACRUZ',     estado:'Completed', fechaInicio:'2017-07-01', fechaFin:'2018-06-30' },
].map(c => ({ ...c, anioInicio: Number(c.fechaInicio.slice(0,4)), anioFin: Number(c.fechaFin.slice(0,4)) }));

const norm = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const key  = c => `${norm(c.cargo)}|${c.anioInicio}|${c.anioFin}`;

(async () => {
  console.log(`\n${APPLY ? '⚙️  APLICANDO' : '🔍 DRY RUN'} — historial de cargos\n`);

  // 1) Encontrar al socio
  const us = await db.collection('usuarios').get();
  const hits = [];
  us.forEach(d => {
    const u = d.data();
    const full = norm(`${u.nombre||''} ${u.apellido||''}`);
    if (MATCH.every(t => full.includes(t))) hits.push({ id:d.id, nombre:`${u.nombre||''} ${u.apellido||''}`.trim(), data:u });
  });

  if (hits.length !== 1) {
    console.log(`⚠️  Se esperaba 1 socio y se encontraron ${hits.length}:`);
    hits.forEach(h => console.log(`   - ${h.nombre} (${h.id})`));
    console.log('\nAjusta MATCH para acotar. No se escribió nada.\n');
    return;
  }
  const socio = hits[0];
  console.log(`👤 Socio: ${socio.nombre}  (uid ${socio.id})`);

  // 2) Fusionar con lo existente sin duplicar
  const prev = Array.isArray(socio.data.cargosHistoricos) ? socio.data.cargosHistoricos : [];
  const seen = new Set(prev.map(key));
  const nuevos = CARGOS.filter(c => !seen.has(key(c)));
  const merged = [...prev, ...nuevos].sort((a,b) => (b.anioInicio - a.anioInicio) || (b.anioFin - a.anioFin));

  console.log(`\n📋 Ya tenía: ${prev.length} · A agregar: ${nuevos.length} · Total final: ${merged.length}\n`);
  console.log('   Cargos a agregar:');
  nuevos.forEach(c => console.log(`   + ${c.cargo.padEnd(28)} ${c.anioInicio}–${c.anioFin}  (${c.fechaInicio} → ${c.fechaFin}) · ${c.estado} · ${c.cuenta}`));
  if (!nuevos.length) console.log('   (nada nuevo — ya estaban todos)');

  if (!APPLY) { console.log('\n(DRY RUN — no se escribió. Corre con --apply para guardar.)\n'); return; }

  await db.collection('usuarios').doc(socio.id).update({ cargosHistoricos: merged });
  console.log(`\n✅ Guardado. ${socio.nombre} ahora tiene ${merged.length} cargos en su historial.\n`);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
