// Renombra cargos ya guardados en cargosHistoricos (in-place, sin duplicar).
// Uso: node fixCargosNombres.js [--apply]
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'app-club-de-leones' });
const db = admin.firestore();
const APPLY = process.argv.includes('--apply');

// match de socio → { de: 'texto viejo', a: 'texto nuevo' }
const RENOMBRES = [
  { match:['adalberto','aguilar','rosado'], de:'Presidente del Comité de Aumento de Socios', a:'Presidente del Comité de Aumento de Socios del Club' },
  { match:['marcos','aguirre','ranero'],    de:'SECRETARIO',                                  a:'Secretario del Club' },
];

const norm = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();

(async () => {
  console.log(`\n${APPLY ? '⚙️  APLICANDO' : '🔍 DRY RUN'} — renombrar cargos\n`);
  const us = await db.collection('usuarios').get();
  const todos = [];
  us.forEach(d => todos.push({ id:d.id, ...d.data() }));

  for (const r of RENOMBRES) {
    const hits = todos.filter(u => { const f = norm(`${u.nombre||''} ${u.apellido||''}`); return r.match.every(t => f.includes(t)); });
    if (hits.length !== 1) { console.log(`⚠️  [${r.match.join(' ')}] ${hits.length} coincidencias — omite`); continue; }
    const socio = hits[0];
    const lista = Array.isArray(socio.cargosHistoricos) ? socio.cargosHistoricos : [];
    let n = 0;
    const nueva = lista.map(c => { if (c.cargo === r.de) { n++; return { ...c, cargo: r.a }; } return c; });
    console.log(`👤 ${socio.nombre||''} ${socio.apellido||''}: ${n} cargo(s) "${r.de}" → "${r.a}"`);
    if (APPLY && n) { await db.collection('usuarios').doc(socio.id).update({ cargosHistoricos: nueva }); console.log('   ✅ Guardado.'); }
  }
  console.log(APPLY ? '\n✅ Listo.\n' : '\n(DRY RUN — corre con --apply)\n');
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
