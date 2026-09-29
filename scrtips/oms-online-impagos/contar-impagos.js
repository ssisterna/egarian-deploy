/**
 * PEDIDOS ONLINE IMPAGOS — CONTEO ANTES DEL DEPLOY (X18, 2026-09-29). SOLO LECTURA: no escribe nada.
 *
 * Con X18, un pedido con pago online (link o QR) que no recibe NINGÚN pago en el plazo de la empresa
 * (24 h por defecto, desde el último cobro generado) se cancela solo con "Pago online no realizado".
 * La migración 1.0.76 fija la FECHA DE CORTE en el deploy: lo que ya había vencido antes NO se
 * cancela solo, queda "Esperando el pago online" para cancelarlo a mano. Este script dice, por
 * empresa, cuántos pedidos están en esa situación hoy y desde cuándo, para decidir qué hacer con ellos.
 *
 * Cuenta pedidos (PED) abiertos, con forma de pago online, sin ningún pago y que no sean de cuenta
 * corriente. Es una aproximación: no descuenta los que ya arrancaron (separados, remitidos,
 * facturados o con envío); esos el proceso tampoco los cancela.
 *
 * Uso: pegarlo en 3T (IntelliShell) sobre la base de producción, o
 *   mongosh <uri> deploy/scrtips/oms-online-impagos/contar-impagos.js
 */
const db2 = (typeof process !== 'undefined' && process.env && process.env.DB_NAME) ? db.getSiblingDB(process.env.DB_NAME) : db;
const HORAS = 24;
const ahora = new Date();
const limite = new Date(ahora.getTime() - HORAS * 3600 * 1000);

const filas = db2.transactions.aggregate([
  { $match: { type: 'PED', paymentMode: 'online', state: { $in: ['pending', 'processing', 'processed'] },
              'payments.0': { $exists: false }, 'condition.days': { $not: { $gt: 0 } }, deleted: { $ne: true } } },
  { $lookup: { from: 'paymentrequests', let: { id: '$_id' }, as: 'cobros', pipeline: [
      { $match: { $expr: { $eq: ['$transactionId', '$$id'] }, channel: { $ne: 'refund' } } },
      { $group: { _id: null, ultimo: { $max: '$createdAt' } } } ] } },
  { $addFields: { desde: { $max: [{ $ifNull: [{ $arrayElemAt: ['$cobros.ultimo', 0] }, null] }, '$createdAt', '$date'] } } },
  { $group: {
      _id: '$companyCode',
      pedidos: { $sum: 1 },
      vencidos: { $sum: { $cond: [{ $lt: ['$desde', limite] }, 1, 0] } },
      masViejo: { $min: '$desde' },
      masNuevo: { $max: '$desde' },
      total: { $sum: '$total' },
  } },
  { $sort: { vencidos: -1, _id: 1 } },
]).toArray();

print('Pedidos online sin ningún pago, por empresa (al ' + ahora.toISOString() + '; "vencidos" = más de ' + HORAS + ' h desde el último cobro):');
let tp = 0, tv = 0;
filas.forEach(f => {
  tp += f.pedidos; tv += f.vencidos;
  print(`  ${String(f._id).padEnd(10)} ${String(f.pedidos).padStart(5)} pedido(s) · ${String(f.vencidos).padStart(5)} vencido(s) · desde ${f.masViejo ? f.masViejo.toISOString().slice(0, 10) : '-'} hasta ${f.masNuevo ? f.masNuevo.toISOString().slice(0, 10) : '-'} · $ ${Number(f.total || 0).toFixed(2)}`);
});
print(`TOTAL: ${tp} pedido(s), ${tv} vencido(s). Los vencidos antes del deploy NO se cancelan solos: quedan para cancelar a mano.`);
