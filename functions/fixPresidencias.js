// ════════════════════════════════════════════════════════════════
//  Alinea cargosHistoricos (Presidente del Club) con la placa histórica.
//  Uso (desde functions/):  node fixPresidencias.js [--apply]
//    sin --apply = DRY RUN
// ════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'app-club-de-leones' });
const db = admin.firestore();
const APPLY = process.argv.includes('--apply');

const norm = s => String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ').replace(/\s+/g,' ').trim();

// Socios (por nombre completo tal cual en la BD) a los que se agrega "Presidente del Club" del año dado.
const ADD = [
  ['Francisco Santiago Silva', 1978],
  ['Teodoro Gerardo Gómez Zorrilla', 1980],
  ['Miguel Ángel Beltrán González', 1982],
  ['Heriberto Ortíz Ramírez', 1985],
  ['Carlos Rodríguez Moreno', 1987],
  ['Vicente Rodriguez Alvarez', 1988],
  ['Francisco Contreras Parra', 1991],
  ['Francisco Avila Camberos', 1996],
  ['Jaime Ramírez de Arellano Zamudio', 1997],
];

function nuevaEntrada(y){
  return {
    cargo: 'Presidente del Club',
    cuenta: 'VERACRUZ',
    estado: 'Completed',
    fechaInicio: `${y}-07-01`,
    fechaFin: `${y+1}-06-30`,
    anioInicio: y,
    anioFin: y+1,
  };
}

(async () => {
  console.log(`\n${APPLY ? '⚙️  APLICANDO' : '🔍 DRY RUN'} — alinear presidencias con la placa\n`);
  const us = await db.collection('usuarios').get();
  const byNorm = new Map();
  us.forEach(d => {
    const x = d.data();
    const full = norm(`${x.nombre||''} ${x.apellido||''}`);
    if (!byNorm.has(full)) byNorm.set(full, []);
    byNorm.get(full).push({ id: d.id, data: x });
  });

  const ops = []; // {ref, hist}
  let addCount = 0, skipCount = 0;

  // ── 1) Agregar presidencias faltantes ──
  for (const [nombre, y] of ADD) {
    const key = norm(nombre);
    const matches = byNorm.get(key) || [];
    if (matches.length !== 1) { console.error(`✗ "${nombre}": ${matches.length} coincidencias exactas — OMITIDO`); continue; }
    const m = matches[0];
    const hist = Array.isArray(m.data.cargosHistoricos) ? [...m.data.cargosHistoricos] : [];
    const yaExiste = hist.some(h => norm(h.cargo)==='PRESIDENTE DEL CLUB' && Number(h.anioInicio)===y);
    if (yaExiste) { console.log(`⏭  ${nombre}: ya tiene Presidente del Club ${y}-${y+1}`); skipCount++; continue; }
    hist.push(nuevaEntrada(y));
    ops.push({ id:m.id, ref: db.collection('usuarios').doc(m.id), hist, label:`${nombre} → + Presidente del Club ${y}-${y+1}` });
    addCount++;
  }

  // ── 2) Corregir Juan Caso Casal: 2002-2003 → 2001-2002 ──
  const jc = (byNorm.get(norm('Juan Caso Casal')) || []);
  if (jc.length === 1) {
    const m = jc[0];
    const hist = (m.data.cargosHistoricos||[]).map(h => {
      if (norm(h.cargo)==='PRESIDENTE DEL CLUB' && Number(h.anioInicio)===2002) {
        return { ...h, fechaInicio:'2001-07-01', fechaFin:'2002-06-30', anioInicio:2001, anioFin:2002 };
      }
      return h;
    });
    const cambio = JSON.stringify(hist) !== JSON.stringify(m.data.cargosHistoricos||[]);
    if (cambio) ops.push({ id:m.id, ref: db.collection('usuarios').doc(m.id), hist, label:'Juan Caso Casal → Presidente del Club 2002-2003 corregido a 2001-2002' });
    else console.log('⏭  Juan Caso Casal: sin cambios (ya 2001-2002 o no encontrado)');
  } else console.error(`✗ Juan Caso Casal: ${jc.length} coincidencias`);

  console.log(`\nActualizaciones de socios a aplicar: ${ops.length} (${addCount} altas, ${skipCount} ya existían)\n`);
  ops.forEach(o => console.log('  • ' + o.label));

  // ── 3) Corregir la placa: HORACIO GILL RODRIGUEZ → HORACIO GIL RODRIGUEZ ──
  const presSnap = await db.collection('presidentes').where('periodo','==','2025-2026').get();
  let gilOp = null;
  presSnap.forEach(d => {
    const x = d.data();
    if (/GILL/i.test(norm(x.nombre))) gilOp = { ref: d.ref, from: x.nombre, to: x.nombre.replace(/GILL/i,'GIL') };
  });
  if (gilOp) console.log(`\n  • Placa 2025-2026: "${gilOp.from}" → "${gilOp.to}"`);
  else console.log('\n  • Placa 2025-2026: sin "GILL" que corregir');

  if (!APPLY) { console.log('\n🔍 DRY RUN — nada escrito. Corre con --apply para aplicar.\n'); process.exit(0); }

  // Aplicar
  for (const o of ops) await o.ref.update({ cargosHistoricos: o.hist });
  if (gilOp) await gilOp.ref.update({ nombre: gilOp.to, actualizadoEn: admin.firestore.Timestamp.now() });
  console.log(`\n✅ Aplicado: ${ops.length} socios actualizados${gilOp?' + placa Gil corregida':''}.\n`);
  process.exit(0);
})().catch(e => { console.error('✗ Error:', e); process.exit(1); });
