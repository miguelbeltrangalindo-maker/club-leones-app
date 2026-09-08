// Script de un solo uso: puebla el proyecto DEMO (club-leones-demo) con datos
// 100% ficticios para presentaciones a otros clubes/asociaciones.
// NO se ejecuta como Cloud Function — se corre manualmente:
//   cd functions && node seedDemo.js
//
// Usa Application Default Credentials del usuario logueado en gcloud/firebase CLI
// (debe tener rol Owner/Editor en el proyecto club-leones-demo).

const admin = require('firebase-admin');

const PROJECT_ID = 'club-leones-demo';
const BUCKET = 'club-leones-demo.firebasestorage.app';

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: PROJECT_ID,
  storageBucket: BUCKET,
});

const db = admin.firestore();
const auth = admin.auth();
const bucket = admin.storage().bucket();

const ANIO = 2026;
const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const MESES_SEED = ['Marzo','Abril','Mayo','Junio','Julio','Agosto']; // últimos 6 meses del demo

function nowISO() { return new Date().toISOString(); }
function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pad2(n) { return String(n).padStart(2, '0'); }

const NOMBRES_M = ['Carlos','Javier','Roberto','Miguel','Fernando','Alejandro','Ricardo','Eduardo','Jorge','Raúl','Sergio','Arturo','Héctor','Gerardo','Alberto','Rodrigo','Manuel','Óscar','Daniel','Andrés'];
const NOMBRES_F = ['María','Patricia','Verónica','Alejandra','Claudia','Sandra','Gabriela','Lucía','Adriana','Norma','Rosa','Silvia','Elena','Beatriz','Teresa','Carmen','Diana','Leticia','Marisol','Fernanda'];
const APELLIDOS = ['García','Hernández','Martínez','López','González','Rodríguez','Pérez','Sánchez','Ramírez','Torres','Flores','Rivera','Gómez','Díaz','Reyes','Morales','Cruz','Ortiz','Gutiérrez','Chávez','Vázquez','Castillo','Jiménez','Romero','Aguilar','Mendoza'];

function nombreCompleto(genero) {
  const nombre = genero === 'F' ? rand(NOMBRES_F) : rand(NOMBRES_M);
  const apellido = `${rand(APELLIDOS)} ${rand(APELLIDOS)}`;
  return { nombre, apellido };
}

function offlineId(i) {
  return `offline_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`;
}

async function commitBatchOps(ops) {
  // ops: array de { ref, data, merge }
  let batch = db.batch();
  let count = 0;
  for (const op of ops) {
    batch.set(op.ref, op.data, op.merge ? { merge: true } : {});
    count++;
    if (count === 450) {
      await batch.commit();
      batch = db.batch();
      count = 0;
    }
  }
  if (count > 0) await batch.commit();
}

// ── 1. Usuario admin de prueba (cuenta real de Auth) ──────────────────────
async function seedAdmin() {
  const email = 'admin@club-demo.org';
  const password = 'ClubDemo#2026';
  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(email);
    console.log('Admin ya existía en Auth, reutilizando UID:', userRecord.uid);
  } catch (e) {
    userRecord = await auth.createUser({
      email,
      password,
      displayName: 'Admin Demo',
      emailVerified: true,
    });
    console.log('Admin creado en Auth:', userRecord.uid);
  }
  const uid = userRecord.uid;

  await db.doc(`usuarios/${uid}`).set({
    nombre: 'Admin', apellido: 'Demo',
    correo: email,
    fechaNacimiento: '1980-01-01', fechaIngreso: '2018-01-01',
    whatsapp: '+52 55 0000 0000', conyuge: '',
    tipo: 'socio', rol: 'admin', cargos: ['Presidente'],
    cargosHistoricos: [{ cargo: 'Tesorero', anioInicio: 2020, anioFin: 2022 }],
    numeroSocio: '1', activo: true,
    padrinoUID: '', padrinoNombre: '',
    photoURL: '',
    creado: nowISO(),
  }, { merge: true });

  await db.doc(`roles/${uid}`).set({
    rol: 'admin', activo: true, uid, createdAt: nowISO(),
  }, { merge: true });

  console.log(`\n=== Acceso admin de prueba ===\nCorreo: ${email}\nContraseña: ${password}\n===============================\n`);
  return uid;
}

// ── 2. Tarifas del año ──────────────────────────────────────────────────
async function seedTarifas() {
  await db.doc(`tarifas/${ANIO}`).set({
    anio: ANIO, c1: 150, c2: 80, c3: 30, c4: 200, c5: 50,
    c6: 0, c6label: '', c7: 0, c7label: '',
    inscripcionClub: 500, lionsInternational: 300,
    actualizadoPor: 'Admin Demo', actualizado: nowISO(),
  }, { merge: true });
  console.log('Tarifas', ANIO, 'creadas.');
  return { c1: 150, c2: 80, c3: 30, c4: 200, c5: 50 };
}

// ── 3. Socios ficticios (offline, sin cuenta de Auth) ───────────────────
function buildSocios(adminUid) {
  const perfiles = [];
  // Directiva / roles especiales (offline: solo para listados, no login real)
  perfiles.push({ tipo: 'socio', rol: 'subadmin', cargos: [] });
  perfiles.push({ tipo: 'socio', rol: 'tesorero', cargos: ['Tesorero'] });
  perfiles.push({ tipo: 'socio', rol: 'mutualista', cargos: [] });
  perfiles.push({ tipo: 'socio', rol: 'cantinero', cargos: ['Director del Bar'] });
  perfiles.push({ tipo: 'dama', rol: 'dama_admin', cargos: [] });
  perfiles.push({ tipo: 'socio', rol: 'miembro', cargos: ['Secretario'] });
  perfiles.push({ tipo: 'socio', rol: 'miembro', cargos: ['Vicepresidente'] });
  perfiles.push({ tipo: 'socio', rol: 'miembro', cargos: ['Segundo Vicepresidente'] });
  perfiles.push({ tipo: 'socio', rol: 'miembro', cargos: ['Past Presidente'] });
  perfiles.push({ tipo: 'socio', rol: 'miembro', cargos: ['Domador'] });

  // Socios comunes
  for (let i = 0; i < 20; i++) perfiles.push({ tipo: 'socio', rol: 'miembro', cargos: [] });
  // Damas
  for (let i = 0; i < 6; i++) perfiles.push({ tipo: 'dama', rol: 'miembro', cargos: [] });
  // Viudas
  for (let i = 0; i < 4; i++) perfiles.push({ tipo: 'viuda', rol: 'miembro', cargos: [] });
  // Cooperadoras
  for (let i = 0; i < 3; i++) perfiles.push({ tipo: 'cooperadora', rol: 'miembro', cargos: [] });
  // Empleados
  for (let i = 0; i < 2; i++) perfiles.push({ tipo: 'empleado', rol: 'miembro', cargos: [] });

  const socios = perfiles.map((p, idx) => {
    const genero = ['dama', 'viuda', 'cooperadora'].includes(p.tipo) ? 'F' : (Math.random() < 0.5 ? 'M' : 'F');
    const { nombre, apellido } = nombreCompleto(genero);
    const numeroSocio = String(idx + 2); // 1 quedó reservado para el admin
    const id = offlineId(idx);
    const bajaIdx = idx % 23 === 0 && idx > 0; // un par de bajas dispersas
    return {
      id,
      data: {
        nombre, apellido,
        nombreCompleto: `${nombre} ${apellido}`,
        correo: '',
        fechaNacimiento: `19${randInt(50, 90)}-${pad2(randInt(1, 12))}-${pad2(randInt(1, 28))}`,
        fechaIngreso: `20${pad2(randInt(10, 24))}-${pad2(randInt(1, 12))}-01`,
        whatsapp: `+52 229 ${randInt(100, 999)} ${randInt(1000, 9999)}`,
        conyuge: '',
        tipo: p.tipo, rol: p.rol, cargos: p.cargos,
        cargosHistoricos: [],
        numeroSocio,
        activo: !bajaIdx,
        ...(bajaIdx ? {
          estado: 'baja', fechaBaja: '2026-05-15', motivoBaja: 'Cambio de residencia',
          dadoDeBajaPorUid: adminUid, dadoDeBajaPorNombre: 'Admin Demo',
        } : {}),
        padrinoUID: '', padrinoNombre: '',
        photoURL: '',
        offline: true,
        creadoEn: nowISO(), creadoPor: adminUid,
      },
    };
  });
  return socios;
}

// ── 4. Recibos + pagos + movimientos financieros (histórico 6 meses) ────
async function seedFinanzas(socios, tarifa, adminUid) {
  const ops = [];
  const financierosOps = [];
  let contadorRecibos = 0, contadorPagos = 0, contadorMovs = 0;

  const conPagosDe = socios.filter(s => ['socio', 'dama', 'viuda', 'cooperadora'].includes(s.data.tipo) && s.data.activo);

  for (const socio of conPagosDe) {
    // comportamiento de pago: al corriente / moroso leve / moroso severo
    const perfil = Math.random();
    let mesesAdeudo = 0;
    if (perfil < 0.55) mesesAdeudo = 0;
    else if (perfil < 0.80) mesesAdeudo = randInt(1, 2);
    else mesesAdeudo = randInt(3, 5);

    const esDama = ['dama', 'viuda', 'cooperadora'].includes(socio.data.tipo);

    MESES_SEED.forEach((mesNombre, mIdx) => {
      const c1 = esDama ? 0 : tarifa.c1;
      const c2 = esDama ? tarifa.c2 : 0;
      const c3 = tarifa.c3;
      const c7 = Math.random() < 0.12 ? 100 : 0;
      const c7label = c7 ? 'Cuota extraordinaria' : '';
      const total = c1 + c2 + c3 + c7;

      const reciboId = db.collection('recibos').doc().id;
      const mesesRestantes = MESES_SEED.length - mIdx; // cuántos meses faltan para llegar a "hoy" (incluido este)
      const estaAdeudado = mesesRestantes <= mesesAdeudo;

      const reciboBase = {
        socioUID: socio.id,
        nombreSocio: socio.data.nombre, apellidoSocio: socio.data.apellido,
        numeroSocio: socio.data.numeroSocio, subtipo: socio.data.tipo,
        mes: mesNombre, anio: ANIO,
        c1, c2, c3, c4: 0, c5: 0, c6: 0, c6label: '', c7, c7label,
        descuento: 0, descuentoLabel: '', notas: '',
        total,
        autorUID: adminUid, autorNombre: 'Admin Demo', tesoreroNombre: 'Admin Demo',
        creado: nowISO(), modificado: nowISO(),
      };

      if (estaAdeudado) {
        ops.push({ ref: db.doc(`recibos/${reciboId}`), data: { ...reciboBase, estado: 'pendiente', montoPagado: 0 } });
        contadorRecibos++;
      } else {
        const fechaPago = `${ANIO}-${pad2(3 + mIdx)}-${pad2(randInt(1, 25))}`;
        const pagoId = db.collection('pagos_socios').doc().id;
        const movId = db.collection('movimientos_financieros').doc().id;

        ops.push({
          ref: db.doc(`recibos/${reciboId}`),
          data: { ...reciboBase, estado: 'pagado', montoPagado: total, fechaPago, pagoSocioId: pagoId, movimientoFinId: movId, movimientoDestino: 'banco' },
        });
        contadorRecibos++;

        ops.push({
          ref: db.doc(`pagos_socios/${pagoId}`),
          data: {
            socioUID: socio.id, nombreSocio: `${socio.data.nombre} ${socio.data.apellido}`, numeroSocio: socio.data.numeroSocio,
            montoTotal: total, sobrante: 0, fechaPago,
            metodoPago: rand(['efectivo', 'transferencia', 'tarjeta']), destino: 'banco', destinoLabel: 'banco',
            referencia: '',
            desglose: [{ reciboId, mes: mesNombre, anio: ANIO, totalRecibo: total, saldoPrevio: total, montoPrevio: 0, montoAplicado: total, nuevoPagado: total, nuevoSaldo: 0, nuevoEstado: 'pagado' }],
            deudaAntes: total, deudaDespues: 0,
            movimientoFinId: movId,
            tesoreroNombre: 'Admin Demo',
            creadoPorUid: adminUid, creadoPorNombre: 'Admin Demo',
            creadoEn: `${fechaPago}T18:00:00.000Z`,
          },
        });
        contadorPagos++;

        financierosOps.push({
          ref: db.doc(`movimientos_financieros/${movId}`),
          data: {
            tipo: 'ingreso', rubroId: 'rubro_cuotas', rubroNombre: 'Cuotas de Socios', subgrupo: 'Cuotas',
            concepto: `Cuota ${mesNombre} ${ANIO} — ${socio.data.nombre} ${socio.data.apellido}`,
            monto: total, fecha: fechaPago, destino: 'banco', metodoPago: 'transferencia',
            referencia: null, notas: null, acreedorNombre: null,
            autoGenerado: true, origen: 'pago_socio',
            registradoPor: adminUid, registradoPorNombre: 'Admin Demo',
            creadoEn: `${fechaPago}T18:00:00.000Z`,
          },
        });
        contadorMovs++;
      }
    });
  }

  // Movimientos manuales adicionales (variedad para Panel de Finanzas)
  const manuales = [
    { tipo: 'ingreso', rubroNombre: 'Arrendamiento', subgrupo: 'Arrendamiento', concepto: 'Renta salón — evento privado', monto: 4500, fecha: '2026-07-10' },
    { tipo: 'ingreso', rubroNombre: 'Donativos', subgrupo: 'Donativos', concepto: 'Donativo empresa local', monto: 10000, fecha: '2026-06-05' },
    { tipo: 'egreso', rubroNombre: 'Mantenimiento', subgrupo: 'Mantenimiento', concepto: 'Reparación de aire acondicionado', monto: 3200, fecha: '2026-07-22' },
    { tipo: 'egreso', rubroNombre: 'Servicios', subgrupo: 'Servicios', concepto: 'CFE y agua — Julio', monto: 2100, fecha: '2026-07-30' },
    { tipo: 'egreso', rubroNombre: 'Nómina', subgrupo: 'Nómina', concepto: 'Nómina quincenal — personal de limpieza', monto: 5400, fecha: '2026-08-01' },
    { tipo: 'egreso', rubroNombre: 'Eventos', subgrupo: 'Eventos', concepto: 'Decoración Baile de Coronación', monto: 6800, fecha: '2026-08-03' },
  ];
  for (const m of manuales) {
    const movId = db.collection('movimientos_financieros').doc().id;
    financierosOps.push({
      ref: db.doc(`movimientos_financieros/${movId}`),
      data: {
        tipo: m.tipo, rubroId: `rubro_${m.subgrupo.toLowerCase()}`, rubroNombre: m.rubroNombre, subgrupo: m.subgrupo,
        concepto: m.concepto, monto: m.monto, fecha: m.fecha, destino: 'banco', metodoPago: 'transferencia',
        referencia: null, notas: null, acreedorNombre: null,
        autoGenerado: false, origen: '',
        registradoPor: adminUid, registradoPorNombre: 'Admin Demo',
        creadoEn: `${m.fecha}T12:00:00.000Z`,
      },
    });
    contadorMovs++;
  }

  await commitBatchOps(ops);
  await commitBatchOps(financierosOps);
  console.log(`Recibos: ${contadorRecibos}, Pagos: ${contadorPagos}, Movimientos financieros: ${contadorMovs}`);
}

// ── 5. Rubros financieros (catálogo) ─────────────────────────────────────
async function seedRubros(adminUid) {
  const rubros = [
    { nombre: 'Cuotas de Socios', tipo: 'ingreso', subgrupo: 'Cuotas' },
    { nombre: 'Arrendamiento', tipo: 'ingreso', subgrupo: 'Arrendamiento' },
    { nombre: 'Donativos', tipo: 'ingreso', subgrupo: 'Donativos' },
    { nombre: 'Mantenimiento', tipo: 'egreso', subgrupo: 'Mantenimiento' },
    { nombre: 'Servicios', tipo: 'egreso', subgrupo: 'Servicios' },
    { nombre: 'Nómina', tipo: 'egreso', subgrupo: 'Nómina' },
    { nombre: 'Eventos', tipo: 'egreso', subgrupo: 'Eventos' },
  ];
  const ops = rubros.map(r => ({
    ref: db.collection('rubros_financieros').doc(),
    data: { ...r, activo: true, creadoEn: nowISO(), creadoPor: adminUid },
  }));
  await commitBatchOps(ops);
  console.log('Rubros financieros:', rubros.length);
}

// ── 6. Fondo de reserva + Mutualista ─────────────────────────────────────
async function seedFondos(adminUid) {
  const reserva = [
    { tipo: 'saldo_inicial', monto: 25000, concepto: 'Saldo inicial Fondo de Reserva', fecha: '2026-01-01' },
    { tipo: 'deposito', monto: 5000, concepto: 'Aportación trimestral', fecha: '2026-04-01' },
    { tipo: 'deposito', monto: 5000, concepto: 'Aportación trimestral', fecha: '2026-07-01' },
    { tipo: 'retiro', monto: 3000, concepto: 'Apoyo evento comunitario', fecha: '2026-06-15', autorizadoPor: 'Admin Demo' },
  ];
  const opsReserva = reserva.map(r => ({
    ref: db.collection('fondo_reserva').doc(),
    data: { ...r, notas: '', comprobanteURL: '', comprobanteNombre: '', autorUID: adminUid, autorNombre: 'Admin Demo', creadoEn: `${r.fecha}T12:00:00.000Z` },
  }));
  await commitBatchOps(opsReserva);

  const mutualista = [
    { tipo: 'saldo_inicial', monto: 15000, concepto: 'Saldo inicial de la Mutualista', fecha: '2026-01-01' },
    { monto: 800, concepto: 'Pago a la Mutualista — aportación mensual', comprobanteURL: '', comprobanteNombre: '', fecha: '2026-05-05T12:00:00.000Z', soloRegistro: false },
    { monto: 800, concepto: 'Pago a la Mutualista — aportación mensual', comprobanteURL: '', comprobanteNombre: '', fecha: '2026-07-05T12:00:00.000Z', soloRegistro: false },
    { tipo: 'adeudo', periodoMes: 4, periodoAnio: 2026, monto: 800, nota: 'Adeudo pendiente de regularizar' },
  ];
  const opsMutualista = mutualista.map(m => ({
    ref: db.collection('mutualista_pagos').doc(),
    data: { ...m, autorUID: adminUid, autorNombre: 'Admin Demo', creadoEn: m.fecha || nowISO() },
  }));
  await commitBatchOps(opsMutualista);
  console.log('Fondo de reserva:', reserva.length, '| Mutualista:', mutualista.length);
}

// ── 7. Comunicados ────────────────────────────────────────────────────
async function seedComunicados(adminUid) {
  const items = [
    { titulo: 'Bienvenida al sistema demo', texto: 'Este es un comunicado de ejemplo para la demostración del sistema.', tipo: 'aviso' },
    { titulo: 'Convocatoria a Junta de Directiva', texto: 'Se convoca a Junta de Directiva el próximo mes.', tipo: 'junta', fechaEvento: '2026-09-05' },
    { titulo: 'Recordatorio de cuotas pendientes', texto: 'Se recuerda a los socios regularizar sus cuotas.', tipo: 'adeudo' },
    { titulo: 'Baile de Coronación 2026', texto: 'Los invitamos al Baile de Coronación de este año.', tipo: 'evento', fechaEvento: '2026-11-20' },
    { titulo: 'Resultado de asamblea', texto: 'Gracias a todos los socios que asistieron a la asamblea general.', tipo: 'oficial' },
  ];
  const ops = items.map(it => ({
    ref: db.collection('comunicados').doc(),
    data: {
      titulo: it.titulo, texto: it.texto, tipo: it.tipo,
      fechaEvento: it.fechaEvento || '',
      enviarCorreo: false,
      destinatarios: 'todos',
      destinatarioRoles: [], destinatarioCargos: [], destinatarioUIDs: [], destinatarioEstados: [], destinatarioTipos: [],
      destinatarioUID: '', destinatarioNombre: '',
      imageURL: '', adjuntoURL: '', adjuntoTipo: '',
      activo: true,
      autorUID: adminUid, autorNombre: 'Admin Demo',
      fecha: nowISO(), creadoEn: nowISO(),
    },
  }));
  await commitBatchOps(ops);
  console.log('Comunicados:', items.length);
}

// ── 8. Votaciones ─────────────────────────────────────────────────────
async function seedVotaciones(adminUid, socios) {
  const candidatos = socios.filter(s => s.data.tipo === 'socio').slice(0, 3).map(s => ({
    uid: s.id, nombre: `${s.data.nombre} ${s.data.apellido}`, numeroSocio: s.data.numeroSocio,
  }));

  // Votación simple (abierta)
  const votSimpleRef = db.collection('votaciones').doc();
  await votSimpleRef.set({
    titulo: '¿Aprobar el presupuesto anual 2027?',
    descripcion: 'Votación de ejemplo para la demostración.',
    audiencia: 'todos', estado: 'abierta',
    creadaPorUID: adminUid, creadaPorNombre: 'Admin Demo', creadaPorRol: 'Presidente',
    createdAt: admin.firestore.Timestamp.now(), closedAt: null,
  });
  const votantesSimple = socios.filter(s => s.data.tipo === 'socio').slice(3, 10);
  const votosSimple = [];
  votantesSimple.forEach((s, i) => {
    const voto = i < 5 ? 'favor' : (i < 6 ? 'contra' : 'abstencion');
    votosSimple.push({
      ref: votSimpleRef.collection('votos').doc(s.id),
      data: { voto, nombre: `${s.data.nombre} ${s.data.apellido}`, numeroSocio: s.data.numeroSocio, ts: admin.firestore.Timestamp.now() },
    });
  });
  await commitBatchOps(votosSimple);

  // Elección (cerrada, con resultado)
  const votEleccionRef = db.collection('votaciones').doc();
  await votEleccionRef.set({
    tipo: 'eleccion', cargo: 'Primer Vicepresidente', periodo: '2026–2027',
    titulo: 'Elección · Primer Vicepresidente · Periodo 2026–2027',
    audiencia: 'todos', estado: 'cerrada',
    candidatos, candidatoUIDs: candidatos.map(c => c.uid),
    creadaPorUID: adminUid, creadaPorNombre: 'Admin Demo', creadaPorRol: 'Presidente',
    createdAt: admin.firestore.Timestamp.now(), closedAt: admin.firestore.Timestamp.now(),
    resultado: { ganadorNombre: candidatos[0]?.nombre || '', empate: false },
  });
  const votantesEleccion = socios.filter(s => s.data.tipo === 'socio').slice(10, 20);
  const votosEleccion = votantesEleccion.map((s, i) => ({
    ref: votEleccionRef.collection('votos').doc(s.id),
    data: { candidato: candidatos[i % candidatos.length]?.uid || candidatos[0].uid, ts: admin.firestore.Timestamp.now() },
  }));
  await commitBatchOps(votosEleccion);

  console.log('Votaciones: 2 (1 abierta, 1 cerrada con resultado)');
}

// ── 9. Actas (con PDF real subido a Storage) ─────────────────────────────
function minimalPdfBuffer(texto) {
  const contentStream = `BT /F1 18 Tf 50 700 Td (${texto}) Tj ET`;
  const objs = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj',
    '4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
    `5 0 obj<</Length ${contentStream.length}>>stream\n${contentStream}\nendstream endobj`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  for (const o of objs) { offsets.push(body.length); body += o + '\n'; }
  const xrefStart = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(body, 'utf-8');
}

async function seedActas(adminUid) {
  const actas = [
    { titulo: 'Acta de Junta de Directiva — Junio 2026', tipo: 'directiva', fecha: '2026-06-05' },
    { titulo: 'Acta de Asamblea General — Marzo 2026', tipo: 'asamblea', fecha: '2026-03-15' },
  ];
  for (const a of actas) {
    const storagePath = `actas/demo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.pdf`;
    const file = bucket.file(storagePath);
    await file.save(minimalPdfBuffer(a.titulo), { contentType: 'application/pdf' });
    await file.makePublic();
    const pdfUrl = `https://storage.googleapis.com/${BUCKET}/${storagePath}`;
    await db.collection('actas').doc().set({
      tipo: a.tipo, titulo: a.titulo, fecha: a.fecha,
      pdfUrl, storagePath,
      subidoPorUID: adminUid, subidoPorNombre: 'Admin Demo',
      creadoEn: `${a.fecha}T12:00:00.000Z`,
    });
  }
  console.log('Actas:', actas.length);
}

// ── 10. Reservaciones de salones ─────────────────────────────────────────
async function seedReservaciones(adminUid) {
  const salones = [
    { nombre: 'Salón Reinas', capacidad: 150, costoSugerido: 3500, rubroNombre: 'Renta de instalaciones', afectaEstacionamiento: true },
    { nombre: 'Salón Gobernadores', capacidad: 80, costoSugerido: 2200, rubroNombre: 'Renta de instalaciones', afectaEstacionamiento: true },
    { nombre: 'Instalaciones Deportivas', capacidad: 300, costoSugerido: 1500, rubroNombre: 'Renta de instalaciones', afectaEstacionamiento: false },
  ];
  const salonRefs = [];
  for (const s of salones) {
    const ref = db.collection('salones').doc();
    await ref.set({ ...s, descuentoFijo: 0, fotoURL: '', notas: '', activo: true, creadoEn: nowISO(), creadoPor: adminUid, actualizadoEn: nowISO(), actualizadoPor: adminUid });
    salonRefs.push({ id: ref.id, ...s });
  }

  const reservas = [
    { salon: salonRefs[0], fecha: '2026-09-15', evento: 'Boda', anfitrion: 'Familia Ramírez', estado: 'confirmada', fianzaRecibida: true },
    { salon: salonRefs[0], fecha: '2026-10-02', evento: 'XV Años', anfitrion: 'Familia Torres', estado: 'tentativa', fianzaRecibida: false },
    { salon: salonRefs[1], fecha: '2026-07-20', evento: 'Conferencia empresarial', anfitrion: 'Cámara de Comercio', estado: 'realizada', fianzaRecibida: true },
    { salon: salonRefs[2], fecha: '2026-08-25', evento: 'Torneo deportivo', anfitrion: 'Liga Municipal', estado: 'confirmada', fianzaRecibida: true },
    { salon: salonRefs[1], fecha: '2026-06-10', evento: 'Cumpleaños', anfitrion: 'Familia López', estado: 'cancelada', fianzaRecibida: false },
  ];
  const ops = reservas.map(r => ({
    ref: db.collection('reservaciones').doc(),
    data: {
      salonId: r.salon.id, salonNombre: r.salon.nombre,
      afectaEstacionamiento: r.salon.afectaEstacionamiento, rubroNombre: r.salon.rubroNombre,
      fecha: r.fecha, horaInicio: '18:00', horaFin: '23:00',
      evento: r.evento, anfitrion: r.anfitrion, contacto: '229 123 4567', numInvitados: randInt(50, r.salon.capacidad),
      observaciones: '',
      costo: r.salon.costoSugerido, descuentoAplicado: 0,
      horasExtraPrecio: 300, horasExtraCantidad: 0, horasExtraCosto: 0,
      aplicaIva: false, iva: 0,
      estado: r.estado,
      fianzaMonto: 2000, fianzaRecibida: r.fianzaRecibida, fianzaNota: '', fianzaDestino: 'banco',
      anticipo: r.fianzaRecibida ? 2000 : 0, saldoPagado: 0,
      movimientoFinIds: [],
      notifsEstacionamiento: [],
      creadoEn: nowISO(), creadoPor: adminUid, actualizadoEn: nowISO(), actualizadoPor: adminUid,
    },
  }));
  await commitBatchOps(ops);
  console.log('Salones:', salones.length, '| Reservaciones:', reservas.length);
}

// ── 11. Solicitudes de cargo ──────────────────────────────────────────
async function seedSolicitudes(socios) {
  const candidatos = socios.filter(s => s.data.tipo === 'socio' && s.data.cargos.length === 0).slice(0, 2);
  const cargosDisponibles = ['Vocal un año', 'Comité de Afiliación'];
  const ops = candidatos.map((s, i) => ({
    ref: db.collection('solicitudes').doc(),
    data: {
      uid: s.id, nombre: `${s.data.nombre} ${s.data.apellido}`,
      cargo: cargosDisponibles[i % cargosDisponibles.length],
      estado: 'pendiente', fecha: nowISO(),
    },
  }));
  await commitBatchOps(ops);
  console.log('Solicitudes de cargo:', ops.length);
}

// ── 12. Galería histórica (presidentes / reinas) ─────────────────────
async function seedGaleria() {
  const presidentes = [
    { nombre: 'Roberto Domínguez Salas', periodo: '2020-2021' },
    { nombre: 'Ana Luisa Cervantes', periodo: '2021-2022' },
    { nombre: 'Miguel Ángel Solís', periodo: '2022-2023' },
    { nombre: 'Patricia Núñez Vega', periodo: '2023-2024' },
    { nombre: 'Carlos Estrada Muñoz', periodo: '2024-2025' },
  ];
  const reinas = [
    { nombre: 'Daniela Fuentes', periodo: '2020-2021', alias: 'Reina de la Amistad' },
    { nombre: 'Camila Rosales', periodo: '2021-2022', alias: 'Reina de la Amistad' },
    { nombre: 'Valeria Campos', periodo: '2022-2023', alias: 'Reina de la Amistad' },
    { nombre: 'Ximena Delgado', periodo: '2023-2024', alias: 'Reina de la Amistad' },
    { nombre: 'Regina Ibarra', periodo: '2024-2025', alias: 'Reina de la Amistad' },
  ];
  const ops = [
    ...presidentes.map(p => ({ ref: db.collection('presidentes').doc(), data: { ...p, creadoEn: admin.firestore.Timestamp.now(), creadoPor: 'seed', actualizadoEn: admin.firestore.Timestamp.now() } })),
    ...reinas.map(r => ({ ref: db.collection('reinas').doc(), data: { ...r, creadoEn: admin.firestore.Timestamp.now(), creadoPor: 'seed', actualizadoEn: admin.firestore.Timestamp.now() } })),
  ];
  await commitBatchOps(ops);
  console.log('Galería histórica — presidentes:', presidentes.length, '| reinas:', reinas.length);
}

// ── 13. Informe del Secretario ────────────────────────────────────────
async function seedSecretario(adminUid) {
  const conceptos = [
    { nombre: 'Consulta oftalmológica', categoria: 'Conservación de la vista', tipo: 'calculado', tasa: 50, unidad: 'personas' },
    { nombre: 'Lentes donados', categoria: 'Conservación de la vista', tipo: 'calculado', tasa: 200, unidad: 'personas' },
    { nombre: 'Pruebas de audición', categoria: 'Servicios de audición', tipo: 'calculado', tasa: 30, unidad: 'personas' },
    { nombre: 'Árboles plantados', categoria: 'Medio ambiente', tipo: 'calculado', tasa: 10, unidad: 'personas' },
    { nombre: 'Becas otorgadas', categoria: 'Servicios Juveniles', tipo: 'fijo', tasa: 0, unidad: 'personas' },
    { nombre: 'Despensas entregadas', categoria: 'Servicios a la comunidad', tipo: 'calculado', tasa: 150, unidad: 'personas' },
  ];
  const conceptoRefs = [];
  for (let i = 0; i < conceptos.length; i++) {
    const ref = db.collection('secretario_conceptos').doc();
    await ref.set({ ...conceptos[i], activo: true, orden: i, creadoEn: nowISO(), creadoPor: adminUid, actualizadoEn: nowISO(), actualizadoPor: adminUid });
    conceptoRefs.push({ id: ref.id, ...conceptos[i] });
  }

  const informeConceptos = conceptoRefs.map(c => {
    const cantidad = c.tipo === 'calculado' ? randInt(5, 40) : 0;
    const monto = c.tipo === 'calculado' ? cantidad * c.tasa : randInt(1000, 5000);
    return { conceptoId: c.id, nombre: c.nombre, categoria: c.categoria, tipo: c.tipo, tasa: c.tasa, unidad: c.unidad, cantidad, monto };
  });
  const total = informeConceptos.reduce((a, c) => a + c.monto, 0);

  await db.doc(`secretario_informes/2025-2026_07`).set({
    ejercicio: '2025-2026', anio: 2026, mes: 7, mesNombre: 'Julio',
    estado: 'firmado', conceptos: informeConceptos, total,
    socios: { inicio: 45, altas: 1, bajas: 0, reingresos: 0, cierre: 46 },
    secretarioNombre: 'Admin Demo', secretarioUid: adminUid, fechaFirma: '2026-07-31T20:00:00.000Z',
    creadoEn: nowISO(), creadoPor: adminUid, actualizadoEn: nowISO(), actualizadoPor: adminUid,
  });
  console.log('Informe del Secretario: conceptos', conceptos.length, '| 1 informe firmado (Julio 2026)');
}

// ── main ──────────────────────────────────────────────────────────────
async function main() {
  console.log(`Poblando proyecto ${PROJECT_ID} con datos ficticios...\n`);
  const adminUid = await seedAdmin();
  const tarifa = await seedTarifas();
  const socios = buildSocios(adminUid);
  await commitBatchOps(socios.map(s => ({ ref: db.doc(`usuarios/${s.id}`), data: s.data })));
  console.log('Socios ficticios creados:', socios.length);

  await seedRubros(adminUid);
  await seedFinanzas(socios, tarifa, adminUid);
  await seedFondos(adminUid);
  await seedComunicados(adminUid);
  await seedVotaciones(adminUid, socios);
  await seedActas(adminUid);
  await seedReservaciones(adminUid);
  await seedSolicitudes(socios);
  await seedGaleria();
  await seedSecretario(adminUid);

  console.log('\n✅ Seed completo.');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Error en el seed:', err);
  process.exit(1);
});
