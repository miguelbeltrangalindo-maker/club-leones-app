// Audita socios duplicados (offline+online) y recibos partidos entre UIDs. Solo lectura.
// Uso: node auditDuplicados.js
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'app-club-de-leones' });
const db = admin.firestore();
const norm = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
const fmt = n => '$'+Number(n||0).toLocaleString('es-MX');

(async () => {
  const [usSnap, recSnap, psSnap] = await Promise.all([
    db.collection('usuarios').get(),
    db.collection('recibos').get(),
    db.collection('pagos_socios').get(),
  ]);
  const users = [];
  usSnap.forEach(d => users.push({ id:d.id, ...d.data() }));

  // Recibos y pagos por socioUID
  const recByUid = {}, psByUid = {};
  recSnap.forEach(d => { const r=d.data(); (recByUid[r.socioUID]=recByUid[r.socioUID]||[]).push(r); });
  psSnap.forEach(d => { const p=d.data(); psByUid[p.socioUID]=(psByUid[p.socioUID]||0)+1; });
  const recInfo = uid => { const rs=recByUid[uid]||[]; return { n:rs.length, tot:rs.reduce((s,r)=>s+Number(r.total||0),0), pag:rs.filter(r=>r.estado==='pagado'||r.estado==='parcial').length }; };

  // Agrupar por nombre normalizado y por numeroSocio
  const byName = {}, byNum = {};
  users.forEach(u => {
    const full = norm(`${u.nombre||''} ${u.apellido||''}`);
    if (full) (byName[full]=byName[full]||[]).push(u);
    const num = String(u.numeroSocio||'').trim();
    if (num) (byNum[num]=byNum[num]||[]).push(u);
  });

  const full = u => `${u.nombre||''} ${u.apellido||''}`.trim();
  const line = u => {
    const ri = recInfo(u.id);
    const flags = [u.offline?'offline':null, u.migrado?'migrado':null, u.migradoA?'migradoA':null, u.linkedToUID?'linked':null, u.correo?'con-correo':'sin-correo', (u.activo===false)?'INACTIVO':null, u.estado==='baja'?'BAJA':null].filter(Boolean).join(' · ');
    return `      ${u.id}\n        "${full(u)}" · #${u.numeroSocio||'—'} · ${flags}\n        recibos:${ri.n} (cobrados:${ri.pag}, ${fmt(ri.tot)}) · pagos_socios:${psByUid[u.id]||0} · cargos:${(u.cargosHistoricos||[]).length}`;
  };

  // CASO A: MISMA PERSONA (mismo nombre normalizado, distinto UID)
  console.log('\n\n████ CASO A — MISMA PERSONA duplicada (mismo nombre) ████');
  let dupPersona = 0, splitPersona = 0;
  Object.values(byName).filter(a => a.length>1).forEach(arr => {
    console.log(`\n═══ ${full(arr[0])} ═══`);
    arr.forEach(u => console.log(line(u)));
    const conRec = arr.filter(u => (recByUid[u.id]||[]).length>0);
    if (conRec.length>1) { console.log('   ⚠️  RECIBOS PARTIDOS — consolidar en una sola cuenta'); splitPersona++; }
    else console.log('   ℹ️  Duplicado (recibos en 1 solo UID o ninguno) — limpieza');
    dupPersona++;
  });
  if (!dupPersona) console.log('   ✅ Ninguno.');

  // CASO B: MISMO NÚMERO DE SOCIO en personas con DISTINTO nombre (colisión de #)
  console.log('\n\n████ CASO B — NÚMERO DE SOCIO COMPARTIDO por personas distintas ████');
  let colision = 0;
  Object.entries(byNum).filter(([,a]) => a.length>1).forEach(([num,arr]) => {
    const nombresDistintos = new Set(arr.map(u => norm(full(u))));
    if (nombresDistintos.size <= 1) return; // mismo nombre → ya está en Caso A
    console.log(`\n═══ #${num} usado por ${nombresDistintos.size} personas distintas ═══`);
    arr.forEach(u => console.log(line(u)));
    console.log('   ⚠️  COLISIÓN DE NÚMERO — asignar números distintos');
    colision++;
  });
  if (!colision) console.log('   ✅ Ninguno.');

  console.log(`\n\n📊 Resumen: ${dupPersona} personas duplicadas (${splitPersona} con recibos partidos) · ${colision} colisiones de número de socio\n`);
  process.exit(0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
