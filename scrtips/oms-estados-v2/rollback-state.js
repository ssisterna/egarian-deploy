/**
 * ROLLBACK DEL ESTADO DEL PEDIDO (modelo de estados v2, fase D, 2026-09-20).
 *
 * La migración 1.0.64 pasó los estados Preparando/Preparado/Enviado/Entregado/Facturado a
 * `pending` (o `closed` si no quedaba nada por cumplir) y guardó el valor anterior en
 * `stateLegacy`. Este script lo restaura, por si el modelo no convence.
 *
 * Alcance: solo pedidos (type PED) con `stateLegacy`. Los pedidos creados o movidos DESPUÉS de la
 * fase D no tienen copia: quedan como están (pending/closed), que sigue siendo un estado válido.
 * El resumen `oms` no se toca (es reconstruible y no depende del estado).
 *
 * Volver atrás COMPLETO = este script + `git revert` del commit de la fase D en egarian-api y
 * egarian-erp (los lectores del estado legacy vuelven con el código).
 *
 * Uso (mongosh, misma máquina que el server o con la URI):
 *   DRY_RUN=1 mongosh <uri> deploy/scrtips/oms-estados-v2/rollback-state.js   # solo informa
 *   DRY_RUN=0 mongosh <uri> deploy/scrtips/oms-estados-v2/rollback-state.js   # aplica
 * Idempotente: al aplicar borra `stateLegacy`, así una segunda corrida no encuentra nada.
 */
const DRY_RUN = String(process.env.DRY_RUN || '1') === '1';
const db2 = db.getSiblingDB(process.env.DB_NAME || 'egarian');

const filtro = { type: 'PED', stateLegacy: { $exists: true, $ne: '' } };
const total = db2.transactions.countDocuments(filtro);
print(DRY_RUN ? '=== DRY RUN (no escribe) ===' : '=== APLICANDO ===');
print('pedidos con copia del estado anterior: ' + total);

const porEstado = db2.transactions.aggregate([
  { $match: filtro },
  { $group: { _id: { de: '$state', a: '$stateLegacy' }, n: { $sum: 1 } } },
  { $sort: { n: -1 } },
]).toArray();
porEstado.forEach(g => print('  ' + g._id.de + ' -> ' + g._id.a + ': ' + g.n));

if (!DRY_RUN && total > 0) {
  const r = db2.transactions.updateMany(filtro, [
    { $set: { state: '$stateLegacy' } },
    { $unset: 'stateLegacy' },
  ]);
  print('restaurados: ' + r.modifiedCount);
}
if (DRY_RUN) print('Para aplicar: DRY_RUN=0');
