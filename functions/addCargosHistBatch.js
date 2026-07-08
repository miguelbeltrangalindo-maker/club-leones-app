// ════════════════════════════════════════════════════════════════
//  Carga historial de cargos (cargosHistoricos) para VARIOS socios.
//  Uso (desde functions/):  node addCargosHistBatch.js [--apply]
//    sin --apply = DRY RUN · con --apply = fusiona (sin duplicar) y guarda
// ════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'app-club-de-leones' });
const db = admin.firestore();
const APPLY = process.argv.includes('--apply');

const V = 'VERACRUZ', DB7 = 'District B 7';
// Cada persona: match (términos que deben aparecer en "nombre apellido") + cargos
const PAS = 'Presidente del Comité de Aumento de Socios del Club';
const PERSONAS = [
  {
    match: ['carlos', 'rodriguez', 'moreno'],
    cargos: [
      { cargo:'Secretario del Club', cuenta:V, estado:'Completed', fechaInicio:'2017-07-01', fechaFin:'2018-06-30' },
    ],
  },
  {
    match: ['zuniga', 'espinoza'],
    cargos: [
      { cargo:'Presidente del Club',    cuenta:V, estado:'Completed', fechaInicio:'2024-07-01', fechaFin:'2025-06-30' },
      { cargo:'Vicepresidente de Club', cuenta:V, estado:'Completed', fechaInicio:'2023-07-01', fechaFin:'2024-06-30' },
      { cargo:'Administrador del Club', cuenta:V, estado:'Completed', fechaInicio:'2024-07-01', fechaFin:'2025-06-30' },
      { cargo:'Tesorero del Club',      cuenta:V, estado:'Completed', fechaInicio:'2022-07-01', fechaFin:'2023-06-30' },
    ],
  },
  {
    match: ['arellano', 'zamudio'],
    cargos: [
      { cargo:'Segundo Vicepresidente de Club', cuenta:V, estado:'Completed', fechaInicio:'2016-07-01', fechaFin:'2017-06-30' },
      { cargo:'Segundo Vicepresidente de Club', cuenta:V, estado:'Completed', fechaInicio:'2017-07-01', fechaFin:'2018-06-30' },
      { cargo:PAS,                              cuenta:V, estado:'Completed', fechaInicio:'2006-07-01', fechaFin:'2007-06-30' },
    ],
  },
  {
    match: ['ramon', 'reyes', 'gonzalez'],
    cargos: [
      { cargo:'Tesorero del Club', cuenta:V, estado:'Completed', fechaInicio:'2021-07-01', fechaFin:'2022-06-30' },
      { cargo:'Tesorero del Club', cuenta:V, estado:'Pending',   fechaInicio:'2026-07-01', fechaFin:'2027-06-30' },
    ],
  },
  {
    match: ['vicente', 'rodriguez', 'alvarez'],
    cargos: [
      { cargo:'Presidente del Club',            cuenta:V, estado:'Completed', fechaInicio:'2018-07-01', fechaFin:'2019-06-30' },
      { cargo:'Presidente del Club',            cuenta:V, estado:'Completed', fechaInicio:'2004-07-01', fechaFin:'2005-06-30' },
      { cargo:'Vicepresidente de Club',         cuenta:V, estado:'Completed', fechaInicio:'2017-07-01', fechaFin:'2018-06-30' },
      { cargo:'Segundo Vicepresidente de Club', cuenta:V, estado:'Completed', fechaInicio:'2013-05-02', fechaFin:'2013-06-30' },
      { cargo:'Secretario del Club',            cuenta:V, estado:'Completed', fechaInicio:'2020-07-01', fechaFin:'2021-06-30' },
      { cargo:'Secretario del Club',            cuenta:V, estado:'Completed', fechaInicio:'2015-07-01', fechaFin:'2016-06-30' },
      { cargo:'Secretario del Club',            cuenta:V, estado:'Completed', fechaInicio:'2008-07-01', fechaFin:'2009-06-30' },
      { cargo:'Secretario del Club',            cuenta:V, estado:'Completed', fechaInicio:'2011-07-01', fechaFin:'2012-06-30' },
      { cargo:'Secretario del Club',            cuenta:V, estado:'Completed', fechaInicio:'2014-07-01', fechaFin:'2015-06-30' },
      { cargo:'Coordinador de LCIF de Club',    cuenta:V, estado:'Completed', fechaInicio:'2019-07-01', fechaFin:'2020-06-30' },
    ],
  },
  {
    match: ['huergo', 'gutierrez'],
    cargos: [
      { cargo:'Jefe de Zona',                   cuenta:DB7,      estado:'Completed', fechaInicio:'2020-07-01', fechaFin:'2020-08-14' },
      { cargo:'Jefe de Zona',                   cuenta:'Zona 10',estado:'Active',    fechaInicio:'2025-07-08', fechaFin:'2026-06-30' },
      { cargo:'Presidente del Club',            cuenta:V,        estado:'Completed', fechaInicio:'2013-07-01', fechaFin:'2014-06-30' },
      { cargo:'Vicepresidente de Club',         cuenta:V,        estado:'Completed', fechaInicio:'2012-08-24', fechaFin:'2013-06-30' },
      { cargo:'Segundo Vicepresidente de Club', cuenta:V,        estado:'Completed', fechaInicio:'2019-07-01', fechaFin:'2020-06-30' },
    ],
  },
  {
    match: ['nicolas', 'miguel', 'valera'],
    cargos: [
      { cargo:'Asesor de Distrito de Diabetes',                            cuenta:DB7, estado:'Completed', fechaInicio:'2017-10-04', fechaFin:'2018-06-30' },
      { cargo:'Coordinador del GMT de Distrito',                           cuenta:DB7, estado:'Completed', fechaInicio:'2019-07-01', fechaFin:'2020-06-30' },
      { cargo:'Miembro del Equipo de Aumento de Socios y Formación de Clubes', cuenta:DB7, estado:'Completed', fechaInicio:'2017-07-01', fechaFin:'2017-09-21' },
      { cargo:'Asesor Distrital de ALERTA',                                cuenta:DB7, estado:'Completed', fechaInicio:'2015-07-01', fechaFin:'2016-06-30' },
      { cargo:'Jefe de Región',                                            cuenta:DB7, estado:'Completed', fechaInicio:'2014-07-01', fechaFin:'2015-06-30' },
      { cargo:'Presidente del Club',                                       cuenta:V,   estado:'Completed', fechaInicio:'2019-07-01', fechaFin:'2020-06-30' },
      { cargo:'Vicepresidente de Club',                                    cuenta:V,   estado:'Completed', fechaInicio:'2018-07-01', fechaFin:'2019-06-30' },
      { cargo:'Secretario del Club',                                       cuenta:V,   estado:'Completed', fechaInicio:'2007-07-01', fechaFin:'2008-06-30' },
      { cargo:'Secretario del Club',                                       cuenta:V,   estado:'Active',    fechaInicio:'2025-07-01', fechaFin:'2026-06-30' },
      { cargo:PAS,                                                         cuenta:V,   estado:'Completed', fechaInicio:'2017-07-01', fechaFin:'2017-11-06' },
      { cargo:PAS,                                                         cuenta:V,   estado:'Completed', fechaInicio:'2025-07-01', fechaFin:'2025-08-15' },
    ],
  },
  {
    match: ['horacio', 'gil', 'rodriguez'],
    cargos: [
      { cargo:'Presidente del Club',            cuenta:V, estado:'Active',    fechaInicio:'2025-08-15', fechaFin:'2026-06-30' },
      { cargo:'Presidente del Club',            cuenta:V, estado:'Completed', fechaInicio:'2011-07-01', fechaFin:'2012-06-30' },
      { cargo:'Presidente del Club',            cuenta:V, estado:'Completed', fechaInicio:'2025-07-01', fechaFin:'2025-08-15' },
      { cargo:'Vicepresidente de Club',         cuenta:V, estado:'Completed', fechaInicio:'2025-04-10', fechaFin:'2025-06-30' },
      { cargo:'Secretario del Club',            cuenta:V, estado:'Completed', fechaInicio:'2019-07-01', fechaFin:'2020-06-30' },
      { cargo:'Tesorero del Club',              cuenta:V, estado:'Completed', fechaInicio:'2008-07-01', fechaFin:'2009-06-30' },
      { cargo:'Tesorero del Club',              cuenta:V, estado:'Completed', fechaInicio:'2015-07-01', fechaFin:'2016-06-30' },
      { cargo:'Tesorero del Club',              cuenta:V, estado:'Completed', fechaInicio:'2020-07-01', fechaFin:'2021-06-30' },
      { cargo:'Presidente del Comité de Afiliación', cuenta:V, estado:'Completed', fechaInicio:'2024-07-01', fechaFin:'2025-08-15' },
    ],
  },
  {
    match: ['teodoro', 'gomez', 'zorril'],
    cargos: [
      { cargo:'Presidente del Club', cuenta:V, estado:'Completed', fechaInicio:'2003-07-01', fechaFin:'2004-06-30' },
      { cargo:PAS,                   cuenta:V, estado:'Completed', fechaInicio:'2007-07-01', fechaFin:'2008-06-30' },
    ],
  },
  {
    match: ['daniel', 'galindo', 'moreno'],
    cargos: [
      { cargo:'Presidente del Club',    cuenta:V, estado:'Pending', fechaInicio:'2026-07-01', fechaFin:'2027-06-30' },
      { cargo:'Vicepresidente de Club', cuenta:V, estado:'Active',  fechaInicio:'2025-07-01', fechaFin:'2026-06-30' },
    ],
  },
].map(p => ({ ...p, cargos: p.cargos.map(c => ({ ...c, anioInicio:Number(c.fechaInicio.slice(0,4)), anioFin: c.fechaFin ? Number(c.fechaFin.slice(0,4)) : Number(c.fechaInicio.slice(0,4)) })) }));

const norm = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const key  = c => `${norm(c.cargo)}|${c.anioInicio}|${c.anioFin}`;

(async () => {
  console.log(`\n${APPLY ? '⚙️  APLICANDO' : '🔍 DRY RUN'} — historial de cargos (lote)\n`);
  const us = await db.collection('usuarios').get();
  const todos = [];
  us.forEach(d => todos.push({ id:d.id, ...d.data() }));

  for (const p of PERSONAS) {
    const hits = todos.filter(u => { const f = norm(`${u.nombre||''} ${u.apellido||''}`); return p.match.every(t => f.includes(t)); });
    const etiqueta = p.match.join(' ');
    if (hits.length !== 1) {
      console.log(`\n⚠️  [${etiqueta}] se encontraron ${hits.length} socios — se OMITE:`);
      hits.forEach(h => console.log(`     - ${h.nombre||''} ${h.apellido||''} (${h.id})`));
      continue;
    }
    const socio = hits[0];
    const prev = Array.isArray(socio.cargosHistoricos) ? socio.cargosHistoricos : [];
    const seen = new Set(prev.map(key));
    const nuevos = p.cargos.filter(c => !seen.has(key(c)));
    const merged = [...prev, ...nuevos].sort((a,b) => (b.anioInicio - a.anioInicio) || (b.anioFin - a.anioFin));

    console.log(`\n👤 ${socio.nombre||''} ${socio.apellido||''}  (uid ${socio.id})`);
    console.log(`   Ya tenía: ${prev.length} · A agregar: ${nuevos.length} · Total final: ${merged.length}`);
    nuevos.forEach(c => console.log(`   + ${c.cargo.padEnd(42)} ${c.anioInicio}–${c.anioFin}  (${c.fechaInicio} → ${c.fechaFin}) · ${c.estado} · ${c.cuenta}`));
    if (!nuevos.length) console.log('   (nada nuevo — ya estaban todos)');

    if (APPLY && nuevos.length) {
      await db.collection('usuarios').doc(socio.id).update({ cargosHistoricos: merged });
      console.log(`   ✅ Guardado (${merged.length} cargos).`);
    }
  }
  console.log(APPLY ? '\n✅ Lote aplicado.\n' : '\n(DRY RUN — no se escribió. Corre con --apply para guardar.)\n');
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
