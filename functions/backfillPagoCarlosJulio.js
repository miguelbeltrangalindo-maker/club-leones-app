// Backfill puntual: el recibo de Julio 2026 de Carlos Eduardo Alcocer Leetch se
// completó (los $440 restantes) vía "Cobrar saldo" en el panel de Recibos, camino
// que hasta hoy NO dejaba registro en pagos_socios (bug corregido en rbConfirmarCobro,
// public/index.html). Este script solo AGREGA el registro faltante de ese pago
// puntual para que el historial de abonos del recibo quede completo — no toca
// el recibo, el movimiento financiero ni el pago compuesto original.
// Uso: node backfillPagoCarlosJulio.js
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'app-club-de-leones' });
const db = admin.firestore();

const RECIBO_ID = 'XxHttgCpDFoPnvwDXpxw';   // Julio 2026 — Carlos Eduardo Alcocer Leetch

(async () => {
  const rSnap = await db.collection('recibos').doc(RECIBO_ID).get();
  if (!rSnap.exists) throw new Error('Recibo no encontrado');
  const r = rSnap.data();

  const montoPrevio = 1140;              // aplicado en el pago compuesto del 1 de julio
  const aCobrar = Number(r.total) - montoPrevio; // 440

  const pagoSocio = {
    socioUID: r.socioUID, nombreSocio: r.nombreSocio, numeroSocio: r.numeroSocio || '',
    montoTotal: aCobrar, sobrante: 0, fechaPago: r.fechaPago,
    metodoPago: r.movimientoDestino || 'banco', destino: r.movimientoDestino || 'banco', destinoLabel: r.movimientoDestino || 'banco',
    referencia: '', origenComprobante: RECIBO_ID,
    desglose: [{
      reciboId: RECIBO_ID, mes: r.mes, anio: r.anio, totalRecibo: r.total,
      saldoPrevio: aCobrar, montoPrevio, montoAplicado: aCobrar,
      nuevoPagado: r.total, nuevoSaldo: 0, nuevoEstado: 'pagado',
    }],
    deudaAntes: aCobrar, deudaDespues: 0,
    movimientoFinId: r.movimientoFinId || null,
    tesoreroNombre: r.tesoreroNombre || '',
    creadoPorUid: '', creadoPorNombre: r.tesoreroNombre || '',
    creadoEn: new Date(r.fechaPago + 'T18:00:00.000Z').toISOString(),
    backfillNota: 'Registro reconstruido retroactivamente el 2026-07-09 — el pago original no dejó rastro en pagos_socios por el bug de rbConfirmarCobro.',
  };

  const ref = await db.collection('pagos_socios').add(pagoSocio);
  console.log('✅ Creado pagos_socios/' + ref.id, JSON.stringify(pagoSocio, null, 2));
  process.exit(0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
