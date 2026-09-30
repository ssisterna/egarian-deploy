/**
 * CIERRE DE RESERVAS VENCIDAS: DE UNA VEZ AL DÍA A CADA HORA (2026-09-21).
 *
 * El proceso `reserveExpiry` corría a las 4 de la mañana: una reserva vencida a medianoche
 * recién devolvía el stock cuatro horas después. Pasa a correr cada hora (minuto 20, para no
 * pisarse con la reconciliación del resumen a los :15 ni con los procesos de :00 y :30). El
 * arranque del servidor NO actualiza el cron de un proceso que ya existe en la base (solo nombre,
 * grupo y descripción), por eso hace falta tocarlo a mano: la migración 1.0.65 lo hace sola en
 * el deploy; este script es la alternativa para correrlo antes, o desde 3T.
 *
 * Uso (mongosh, misma máquina que el server o con la URI):
 *   DRY_RUN=1 mongosh <uri> deploy/scrtips/reservas-vencidas-cron/update-cron.js   # solo informa
 *   DRY_RUN=0 mongosh <uri> deploy/scrtips/reservas-vencidas-cron/update-cron.js   # aplica
 * Idempotente: solo toca el proceso si todavía tiene el cron diario.
 */
const DRY_RUN = String(process.env.DRY_RUN || '1') === '1';
const db2 = db.getSiblingDB(process.env.DB_NAME || 'egarian');

const NUEVO = '20 * * * *';
const proc = db2.processes.findOne({ code: 'reserveExpiry' });
print(DRY_RUN ? '=== DRY RUN (no escribe) ===' : '=== APLICANDO ===');
if (!proc) {
  print('no existe el proceso reserveExpiry en la base: lo crea el arranque del servidor con el cron nuevo.');
} else {
  print('cron actual: ' + proc.cronTime + ' | último run: ' + (proc.lastRun || '-') + ' | estado: ' + proc.status);
  if (proc.cronTime === NUEVO) {
    print('ya está en ' + NUEVO + ': nada que hacer.');
  } else if (!DRY_RUN) {
    const r = db2.processes.updateOne({ code: 'reserveExpiry' }, { $set: {
      cronTime: NUEVO,
      description: 'Cada hora: cancela los pedidos con reserva de stock vencida (o libera lo que no está en curso si ya salió en parte) y devuelve al depósito vendible las reservas huérfanas de pedidos cancelados, devueltos o cerrados.',
    } });
    print('actualizado: ' + r.modifiedCount + ' -> ' + NUEVO + ' (el server lo toma al reiniciar o al recargar Procesos)');
  } else {
    print('se cambiaría a ' + NUEVO);
  }
}
