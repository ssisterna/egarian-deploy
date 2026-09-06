/* =============================================================================
 *  REPROCESAR PEDIDOS DE MERCADO LIBRE RECHAZADOS POR LA GUARDA DE MEDIOS DIGITALES
 *  (septiembre 2026)                        —  mongosh / Studio 3T (IntelliShell)
 * =============================================================================
 *  Desde el deploy del 2026-09-01 la API tenia una guarda que impide cargar A MANO un
 *  cobro con un medio integrado (Mercado Pago / MODO): con la integracion activa el
 *  cobro se hace generando el QR. La guarda corria tambien para los PEDIDOS DE CANAL,
 *  y una orden de Mercado Libre pagada con Mercado Pago trae ese pago adentro. Resultado:
 *  toda venta de ML pagada con MP, en una empresa con la integracion de MP activa, se
 *  rechazaba con "Mercado Pago tiene la integracion activa: el cobro se hace generando
 *  el QR..." y la notificacion quedaba DESCARTADA tras 5 intentos. La venta no llego al
 *  ERP, pero la notificacion sigue guardada y es reprocesable.
 *
 *  Este script vuelve a poner en cola esas notificaciones para que el proceso
 *  "Recepcion de Novedades" (syncIntegrations) las tome en su proximo tick y registre
 *  los pedidos con la API ya corregida.
 *
 *  CORRERLO SOLO DESPUES DE DEPLOYAR EL FIX (api >= commit "fix(canales): el pago que
 *  cobro el canal no es una carga manual"). Si se corre antes, se rechazan otra vez y
 *  vuelven a descartarse tras 5 intentos.
 *
 *  ES IDEMPOTENTE: la segunda corrida informa que no hay nada que hacer.
 *  NO BORRA NADA. Solo cambia banderas: process=false, reprocess=true, attempts=0.
 *
 *  USO
 *    1. Conectate a la base correcta (ojo con prod).
 *    2. Corre con DRY_RUN = true -> lista las notificaciones que se reencolarian.
 *    3. Si esta bien, pone DRY_RUN = false y volve a correr.
 *    4. Espera un tick del proceso (o dispara "Recepcion de Novedades" desde Procesos
 *       en el ERP) y verifica que los pedidos aparezcan en Ventas.
 *
 *  UNDO: al final se imprimen los _id tocados; para volver atras:
 *    db.getCollection('integrationnotifies').updateMany({_id:{$in:[...]}},
 *        {$set:{process:true, reprocess:false}})
 * ========================================================================== */

// ----------------------------------------------------------------- PARÁMETROS
const DRY_RUN = true;   // true = solo informa, no escribe
// -----------------------------------------------------------------------------

const NOTIFIES = db.getCollection('integrationnotifies');
const MOTIVO   = /integraci[oó]n activa/i;

// Ordenes de ML descartadas por la guarda: process=true (ya nadie las mira) + el mensaje.
const filtroOrdenes = { type: 'mlibre', topic: 'orders_v2', process: true, error: true, message: MOTIVO };

// Pagos de esas mismas ordenes que reventaron con el CastError (external_reference = nro de
// orden de ML, no un ObjectId). Con el fix el webhook de pagos los ignora limpio: NO hace
// falta reencolarlos, el pago viene dentro de la orden. Se cuentan solo para informar.
const filtroPagos = { type: 'mlibre', topic: 'payments', process: true, error: true, message: /Cast to ObjectId/ };

const ordenes = NOTIFIES.find(filtroOrdenes, { notify_id: 1, resource: 1, user_id: 1, attempts: 1, received: 1 })
                        .sort({ received: 1 }).toArray();
const pagos   = NOTIFIES.countDocuments(filtroPagos);

print(`\n=== Pedidos de ML rechazados por la guarda: ${ordenes.length} ===`);
ordenes.forEach(n => print(`  ${n.received ? n.received.toISOString().slice(0, 16) : '-'}  seller=${n.user_id}  ${n.resource}  intentos=${n.attempts}`));
print(`\n(Notificaciones de PAGO con el CastError: ${pagos}. No se tocan: el fix las ignora limpio.)`);

if (ordenes.length === 0) {
    print('\nNada que reencolar. Listo.');
} else if (DRY_RUN) {
    print(`\nDRY_RUN = true: no se escribio nada. Pone DRY_RUN = false para reencolar ${ordenes.length} notificacion(es).`);
} else {
    const ids = ordenes.map(n => n._id);
    const r = NOTIFIES.updateMany(
        { _id: { $in: ids } },
        { $set: { process: false, reprocess: true, attempts: 0, error: false, message: '' } }
    );
    print(`\nReencoladas: ${r.modifiedCount} de ${ids.length}.`);
    print('El proceso "Recepcion de Novedades" las toma en su proximo tick.');
    print('\nUNDO (si hiciera falta):');
    print(`db.getCollection('integrationnotifies').updateMany({_id:{$in:[${ids.map(i => `ObjectId('${i.toString()}')`).join(',')}]}},{$set:{process:true,reprocess:false}})`);
}
