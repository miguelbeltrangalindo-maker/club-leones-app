// ═══════════════════════════════════════════════════════════
//  migrate-recibos-movimientos.js  —  Club de Leones Veracruz
//  Ejecutar UNA sola vez desde la raíz del proyecto:
//    node migrate-recibos-movimientos.js
//
//  Qué hace:
//  Crea un movimiento_financiero de tipo 'ingreso' con rubro
//  'Cuotas de Socios' para cada recibo pagado que NO tenga
//  movimientoFinId, y luego actualiza el recibo con ese id.
//
//  Destino: todos se asignan a 'banco' por defecto, ya que no
//  hay manera de saber cómo se cobró antes del sistema.
//  Puedes ajustar manualmente los que correspondan a caja.
// ═══════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function migrateRecibos() {
  console.log('🦁 Iniciando migración de recibos → movimientos_financieros\n');

  // Cargar o crear el rubro 'Cuotas de Socios'
  let rubroId = null;
  const rubrosSnap = await db.collection('rubros_financieros')
    .where('nombre', '==', 'Cuotas de Socios')
    .where('tipo', '==', 'ingreso')
    .get();

  if (!rubrosSnap.empty) {
    rubroId = rubrosSnap.docs[0].id;
    console.log(`✅ Rubro existente: ${rubroId}`);
  } else {
    const ref = await db.collection('rubros_financieros').add({
      nombre: 'Cuotas de Socios',
      tipo: 'ingreso',
      activo: true,
      creadoEn: new Date().toISOString(),
      creadoPor: 'migración',
    });
    rubroId = ref.id;
    console.log(`✅ Rubro creado: ${rubroId}`);
  }

  // Obtener todos los recibos pagados sin movimientoFinId
  const recibosSnap = await db.collection('recibos')
    .where('estado', '==', 'pagado')
    .get();

  const pendientes = recibosSnap.docs.filter(d => !d.data().movimientoFinId);
  console.log(`📋 Recibos pagados sin movimiento: ${pendientes.length}\n`);

  if (!pendientes.length) {
    console.log('✅ No hay recibos pendientes de migrar.');
    return;
  }

  let migrados = 0, errores = 0;

  for (const docSnap of pendientes) {
    const r = docSnap.data();
    const total = Number(r.total || 0);
    if (total <= 0) {
      console.log(`⏭️ Omitido ${docSnap.id}: total = ${total}`);
      continue;
    }

    const nombreSocio = r.nombreSocio || '';
    const periodo = `${r.mes || ''} ${r.anio || ''}`.trim();
    // Fecha: usar fechaPago si existe, o construir desde mes/anio, o fallback hoy
    let fecha = r.fechaPago || '';
    if (!fecha && r.mes && r.anio) {
      const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                     'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
      const mesIdx = MESES.indexOf(r.mes);
      if (mesIdx >= 0) {
        fecha = `${r.anio}-${String(mesIdx + 1).padStart(2,'0')}-01`;
      }
    }
    if (!fecha) fecha = new Date().toISOString().slice(0, 10);

    try {
      // Crear movimiento financiero
      const movRef = await db.collection('movimientos_financieros').add({
        tipo:         'ingreso',
        rubroId,
        rubroNombre:  'Cuotas de Socios',
        concepto:     `Cuota ${periodo} — ${nombreSocio}`,
        monto:        total,
        fecha,
        metodoPago:   'transferencia',
        destino:      'banco',
        autoGenerado: true,
        origen:       'recibo',
        reciboId:     docSnap.id,
        registradoPor:       'migración',
        registradoPorNombre: 'Migración automática',
        creadoEn:     new Date().toISOString(),
      });

      // Actualizar recibo con movimientoFinId
      await docSnap.ref.update({
        movimientoFinId:    movRef.id,
        movimientoDestino:  'banco',
      });

      migrados++;
      console.log(`✅ Migrado recibo/${docSnap.id} → movimiento/${movRef.id}  (${nombreSocio} · ${periodo} · $${total})`);
    } catch (e) {
      errores++;
      console.error(`❌ Error en ${docSnap.id}:`, e.message);
    }
  }

  console.log('\n═══════════ RESUMEN ═══════════');
  console.log(`Recibos procesados : ${pendientes.length}`);
  console.log(`Movimientos creados: ${migrados}`);
  console.log(`Errores            : ${errores}`);
  console.log('═══════════════════════════════');
  console.log('✅ Migración completa.\n');
  console.log('⚠️  NOTA: Todos los movimientos fueron asignados a destino=banco.');
  console.log('   Si algunos pagos fueron en efectivo, ajústalos manualmente en el sistema.');
}

migrateRecibos()
  .then(() => process.exit(0))
  .catch(err => { console.error('Error general:', err); process.exit(1); });
