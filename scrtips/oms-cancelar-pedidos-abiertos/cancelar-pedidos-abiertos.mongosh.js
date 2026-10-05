/* =============================================================================
 *  LIMPIEZA INICIAL DEL OMS: CANCELAR TODOS LOS PEDIDOS ABIERTOS   (2026-10-05)
 *                                         --  mongosh, para pegar en Studio 3T
 * =============================================================================
 *  Decision del usuario (05/10): nadie opera el OMS en produccion todavia; se cancelan los
 *  pedidos (PED) abiertos de todas las empresas para empezar de cero. Presupuestos fuera.
 *
 *  Es la version de ESCRITURA DIRECTA del script node `cancelar-pedidos-abiertos.js` (que va por
 *  los servicios de la API). Reproduce lo que hace "Anular pedido" del ERP, o sea
 *  `trxService.setState(id, 'cancelled', motivo)` (egarian-api 1.0.0.83, commit 0c976de):
 *
 *   1. Reserva de stock (transactionStockService.reserveRelease): por cada renglon devuelve
 *      qty - qtyRef - qtyCancelled del deposito reservado (trx.depositCode) al vendible
 *      (trx.reserveSourceDepositCode); explota los combos por componentes; mueve las series;
 *      el registro de stock que queda en 0 sin series se borra (persistStock). Al final deja
 *      reserveSourceDepositCode = '' y reserveExpiresAt = null (es lo que lo hace idempotente).
 *   2. El pedido: state = 'cancelled', reason = { code, name }, updatedAt. Para un PED el
 *      WorkflowUpdate no hace nada y no se avisa a ningun marketplace.
 *   3. El resumen del pedido (orderSummaryService.refreshFor): oms.stage = 'cancelled' (etiqueta
 *      "Cancelado", tono muted). OJO: la reconciliacion horaria NO recalcula los cancelados, asi
 *      que lo escribe este script.
 *   4. Cobros abiertos (chargeCancelService.cancelOpenChargesBestEffort): las paymentrequests en
 *      created/pending/error pasan a cancelled con `closing` y un evento. El ERP ademas pide la
 *      baja al proveedor (vence el link de Mercado Pago, cierra la orden del QR); ACA NO.
 *   5. Envios (shippingService.CancelShipmentsForTransaction): los envios vivos del pedido y de
 *      sus derivados en pending/created/error, de operadores que permiten anular (own, oca,
 *      correoargentino), pasan a cancelled con evento ANULADO, extOrderId con sufijo ~<_id>;
 *      sus paquetes quedan libres; la proyeccion delivery.* del comprobante del envio se suelta;
 *      se liberan las asignaciones de preparacion. El ERP ademas llama al operador; ACA NO.
 *      Los que ya salieron (dispatched, in_transit, ...) y los de Mercado Libre / Andreani NO se
 *      tocan, igual que en el ERP.
 *
 *  Nunca borra transacciones. Remitos y facturas no cambian de estado. No avisa a Mercado Libre,
 *  Woo ni la tienda. No invalida la cache Redis. Idempotente: solo toma pedidos abiertos, y cada
 *  paso tiene su guarda (reserva ya liberada, envio ya anulado, cobro ya cerrado).
 *
 *  USO: pegar entero en la consola IntelliShell de Studio 3T (conexion EGARIAN-PRD, base egarian)
 *  o correr `mongosh "<MONGO_URL>" --quiet --file cancelar-pedidos-abiertos.mongosh.js`.
 *  Con DRY_RUN = true (default) lista y no escribe nada. Con DRY_RUN = false ejecuta.
 * ========================================================================== */

const DRY_RUN = true;                                   // <- false para ejecutar
const MOTIVO = 'Limpieza inicial OMS 05/10/2026';
const MOTIVO_CODE = 'limpieza-oms';
const COMPANIES = [];                                   // [] = todas; p.ej. ['dcom', 'ladny']

const CERRADOS = ['delivered', 'invoiced', 'cancelled', 'closed', 'returned', 'applied'];
const ENVIO_ANULABLE = ['pending', 'created', 'error'];             // SHIPMENT_CANCELLABLE_STATES
const ENVIO_TERMINADO = ['cancelled', 'returned'];                   // ENTREGA_TERMINADA (shippingService)
const CARRIER_ANULA_POR_API = { own: true, oca: true, correoargentino: true, mercadolibre: false, andreani: false };
const CARRIER_AVISO_MANUAL = ['oca', 'correoargentino'];            // el ERP los llama; aca queda pendiente
const COBRO_ABIERTO = ['created', 'pending', 'error'];

const ahora = () => new Date();
const idStr = (x) => (x && x.toString) ? x.toString() : String(x || '');
const toOid = (x) => (x instanceof ObjectId) ? x : new ObjectId(idStr(x));
const fecha = (d) => d ? new Date(d).toISOString().slice(0, 10) : '-';
const numeroDe = (t) => `${t.receiptCode || ''} ${t.numberLegal || t.number || ''}`.trim();

const out = [];
const log = (s = '') => { out.push(s); print(s); };

/* ----------------------------------------------------------------------------
 *  SELECCION
 * ------------------------------------------------------------------------- */
function pedidosAbiertos() {
    const fe = COMPANIES.length ? { companyCode: { $in: COMPANIES.map(c => c.toLowerCase()) } } : {};
    const quotes = db.receipts.find({ ...fe, isQuote: true }, { companyCode: 1, code: 1 }).toArray();
    const esQuote = new Set(quotes.map(q => `${q.companyCode}|${q.code}`));
    return db.transactions.find({ ...fe, type: 'PED', deleted: { $ne: true }, state: { $nin: CERRADOS } })
        .sort({ companyCode: 1, date: 1, number: 1 }).toArray()
        .filter(t => !esQuote.has(`${t.companyCode}|${t.receiptCode}`));
}

/** Derivados hacia abajo (destiny, 3 niveles) como orderDeliveryService.downstreamIds. */
function downstreamIds(cc, trx, depth = 3) {
    const seen = new Set();
    let frontier = (trx.destiny || []).map(d => idStr(d.relatedId)).filter(Boolean);
    for (let i = 0; i < depth && frontier.length; i++) {
        const docs = db.transactions.find({ _id: { $in: frontier.map(toOid) }, companyCode: cc }, { destiny: 1 }).toArray();
        frontier.forEach(id => seen.add(id));
        const next = [];
        for (const d of docs) for (const rel of (d.destiny || [])) {
            const id = idStr(rel.relatedId);
            if (id && !seen.has(id)) next.push(id);
        }
        frontier = next;
    }
    return Array.from(seen);
}

/** Origenes hacia arriba (origin, 3 niveles) como orderDeliveryService.upstreamIds. */
function upstreamIds(cc, trxId, depth = 3) {
    const seen = new Set();
    let frontier = [idStr(trxId)];
    for (let i = 0; i < depth && frontier.length; i++) {
        const docs = db.transactions.find({ _id: { $in: frontier.map(toOid) }, companyCode: cc }, { origin: 1 }).toArray();
        const next = [];
        for (const d of docs) for (const rel of (d.origin || [])) {
            const id = idStr(rel.relatedId);
            if (id && !seen.has(id) && id !== idStr(trxId)) { seen.add(id); next.push(id); }
        }
        frontier = next;
    }
    return Array.from(seen);
}

/** Envios vivos del pedido y sus derivados (orderDeliveryService.liveShipmentsFor). */
function enviosVivos(cc, ids) {
    if (!ids.length) return [];
    const oids = ids.map(toOid);
    return db.shipments.find({
        companyCode: cc, $or: [{ transactionId: { $in: oids } }, { 'documents.transactionId': { $in: oids } }],
        state: { $ne: 'cancelled' }, deleted: { $ne: true },
    }).sort({ createdAt: 1 }).toArray();
}

/** Lo que hay que saber de un pedido antes de tocarlo (y lo que lista el ensayo). */
function relevar(p) {
    const cc = p.companyCode;
    const abajo = downstreamIds(cc, p);
    const derivados = abajo.length
        ? db.transactions.find({ _id: { $in: abajo.map(toOid) }, companyCode: cc, deleted: { $ne: true }, state: { $ne: 'cancelled' } },
                               { type: 1, receiptCode: 1, numberLegal: 1 }).toArray()
        : [];
    const envios = enviosVivos(cc, [idStr(p._id), ...abajo]);
    const clasif = { anulables: [], enCurso: [], noAnulables: [] };
    for (const e of envios) {
        if (ENVIO_TERMINADO.includes(e.state) || e.state === 'delivered') continue;
        if (!ENVIO_ANULABLE.includes(e.state)) { clasif.enCurso.push(e); continue; }
        if (CARRIER_ANULA_POR_API[e.carrier] === false) { clasif.noAnulables.push(e); continue; }
        clasif.anulables.push(e);
    }
    const cobros = db.paymentrequests.find({ transactionId: p._id, status: { $in: COBRO_ABIERTO } },
                                           { provider: 1, channel: 1, externalId: 1, amount: 1, expiresAt: 1 }).toArray();
    const remanente = (p.items || []).filter(it => it.useStock !== false).reduce((a, it) => a + Math.max(0, Number(it.qty || 0) - Number(it.qtyRef || 0) - Number(it.qtyCancelled || 0)), 0);
    const conReserva = !!(p.reserveSourceDepositCode && p.depositCode && p.reserveSourceDepositCode !== p.depositCode);
    return {
        remitos: derivados.filter(d => d.type === 'REM'), facturas: derivados.filter(d => d.type === 'FAC'),
        envios: clasif, cobros, remanente, conReserva,
    };
}

/* ----------------------------------------------------------------------------
 *  RESERVA DE STOCK  (transactionStockService.reserveRelease / reserveReleaseLines /
 *  resolveStockLinesForItem / moveStockBetweenDeposits / persistStock)
 * ------------------------------------------------------------------------- */
const PROD_PROJ = { _id: 1, code: 1, name: 1, useStock: 1, isCombo: 1, comboStockMode: 1, comboComponents: 1 };

function lineasDeStock(cc, item, qty) {
    const code = String(item.code || '').toLowerCase();
    const product = db.products.findOne({ companyCode: cc, code }, PROD_PROJ);
    if (!product) throw new Error(`No se encontro el producto ${item.name || item.code} en la transacción`);
    if (!product.useStock) return [];
    const esComboPorComponentes = product.isCombo === true && product.comboStockMode === 'components';
    if (!esComboPorComponentes) return [{ line: Object.assign({}, item, { code, qty }), product }];

    const components = Array.isArray(product.comboComponents) ? product.comboComponents : [];
    if (!components.length) throw new Error(`El combo ${product.name || item.name} no tiene componentes configurados`);
    const codes = components.map(c => String(c.productCode || '').trim().toLowerCase()).filter(Boolean);
    const comps = db.products.find({ companyCode: cc, code: { $in: codes }, deleted: { $ne: true }, active: { $ne: false } },
                                   { _id: 1, code: 1, name: 1, useStock: 1, useVariant: 1, useSeries: 1, parent: 1, dimensionsValues: 1 }).toArray();
    const byCode = new Map(comps.map(c => [String(c.code).toLowerCase(), c]));
    const parentIds = Array.from(new Set(comps.map(c => c.parent).filter(Boolean).map(idStr)));
    const baseCode = new Map();
    if (parentIds.length)
        for (const b of db.products.find({ companyCode: cc, _id: { $in: parentIds.map(toOid) } }, { _id: 1, code: 1 }).toArray())
            baseCode.set(idStr(b._id), String(b.code || ''));
    const lines = [];
    for (const c of components) {
        const ccode = String(c.productCode || '').trim().toLowerCase();
        const cp = byCode.get(ccode);
        if (!cp) throw new Error(`No se encontro el componente ${ccode} del combo ${product.name || item.name}`);
        if (!cp.useStock) continue;
        if (cp.useSeries) throw new Error(`El componente ${cp.name || ccode} usa series y no puede descontarse automaticamente desde un combo`);
        const cq = Number(c.qty || 0);
        if (!Number.isFinite(cq) || cq <= 0) throw new Error(`Cantidad invalida para el componente ${cp.name || ccode}`);
        const isVariant = !!cp.parent;
        lines.push({ product: cp, line: Object.assign({}, item, {
            code: String(cp.code).toLowerCase(), name: cp.name, qty: qty * cq, useStock: cp.useStock,
            useVariant: Boolean(isVariant || cp.useVariant), useSeries: false, series: [],
            parentCode: isVariant ? (baseCode.get(idStr(cp.parent)) || '') : '',
            dimensions: Array.isArray(cp.dimensionsValues) ? cp.dimensionsValues : [],
        }) });
    }
    return lines;
}

function persistStock(sdb, stock, existia) {
    const qty = Number(stock.quantity || 0);
    const hasSeries = Array.isArray(stock.series) && stock.series.length > 0;
    if (qty === 0 && !hasSeries) {
        if (existia) sdb.stocks.deleteOne({ _id: stock._id });     // igual que persistStock del motor
        return;
    }
    if (existia) sdb.stocks.updateOne({ _id: stock._id }, { $set: { quantity: qty, series: stock.series || [], updatedAt: ahora() } });
    else sdb.stocks.insertOne(stock);
}

function moverStock(sdb, trx, fromCode, toCode, line, product, qty, pasos) {
    if (!Number.isFinite(qty) || qty <= 0) return;
    const cc = trx.companyCode, storeCode = trx.storeCode || '';
    const fromDepo = db.deposits.findOne({ companyCode: cc, storeCode, code: String(fromCode).toLowerCase() }, { _id: 1 });
    if (!fromDepo) throw new Error(`No se encontró el depósito ${fromCode}.`);
    const toDepo = db.deposits.findOne({ companyCode: cc, storeCode, code: String(toCode).toLowerCase() }, { _id: 1 });
    if (!toDepo) throw new Error(`No se encontró el depósito ${toCode}.`);

    const fromStock = sdb.stocks.findOne({ companyCode: cc, storeCode, deposit: fromDepo._id, productCode: line.code });
    if (!fromStock) { pasos.push(`sin stock en ${fromCode} para ${line.code}: nada que mover`); return; }

    let toStock = sdb.stocks.findOne({ companyCode: cc, storeCode, deposit: toDepo._id, productCode: line.code });
    const existiaTo = !!toStock;
    if (!toStock) {
        toStock = { _id: new ObjectId(), companyCode: cc, storeCode, depositCode: toCode, deposit: toDepo._id,
                    productCode: line.code, product: product._id, series: [], dimensions: [], quantity: 0,
                    deleted: false, createdAt: ahora(), updatedAt: ahora(), __v: 0 };
        if (line.useVariant) { toStock.dimensions = Array.isArray(line.dimensions) ? line.dimensions : []; toStock.parentCode = line.parentCode || ''; }
    }
    fromStock.quantity = Number(fromStock.quantity || 0) - qty;
    toStock.quantity = Number(toStock.quantity || 0) + qty;
    if (line.useSeries && Array.isArray(line.series) && line.series.length) {
        const moving = new Set(line.series);
        fromStock.series = (fromStock.series || []).filter(s => !moving.has(s));
        toStock.series = (toStock.series || []).concat(line.series);
    }
    persistStock(sdb, fromStock, true);
    persistStock(sdb, toStock, existiaTo);
    pasos.push(`${line.code} ${qty} u. ${fromCode}→${toCode}`);
}

/** Devuelve cuántas unidades liberó. Idempotente por reserveSourceDepositCode (lo limpia el llamador). */
function liberarReserva(sdb, trx, pasos) {
    const reservedCode = String(trx.depositCode || '').trim(), sourceCode = String(trx.reserveSourceDepositCode || '').trim();
    if (!reservedCode || !sourceCode || reservedCode === sourceCode) return 0;
    let total = 0;
    for (const it of (trx.items || [])) {
        const qty = Number(it.qty || 0) - Number(it.qtyRef || 0) - Number(it.qtyCancelled || 0);
        if (!(qty > 0)) continue;
        for (const { line, product } of lineasDeStock(trx.companyCode, it, qty))
            moverStock(sdb, trx, reservedCode, sourceCode, line, product, line.qty, pasos);
        if (it.useStock !== false) total += qty;
    }
    return total;
}

/* ----------------------------------------------------------------------------
 *  EL PEDIDO  (setState: state, reason, reserva) + RESUMEN (orderSummaryService)
 * ------------------------------------------------------------------------- */
function resumenCancelado(trx, at) {
    const prev = trx.oms || null;
    let units = prev && prev.units, mix = prev && prev.mix, isOpen = prev ? !!prev.isOpen : true;
    if (!units) {
        const total = (trx.items || []).filter(i => i.useStock !== false).reduce((a, i) => a + Number(i.qty || 0), 0);
        units = { total, pendingDispatch: total, inTransit: 0, delivered: 0, returned: 0 };
        mix = total > 0 ? [{ code: 'pending', sub: null, qty: total }] : [];
    }
    return { stage: 'cancelled', sub: null, partial: false, label: 'Cancelado', tone: 'muted', units, mix: mix || [], isOpen, updatedAt: at };
}

function cancelarPedido(sdb, trx, pasos) {
    const at = ahora();
    const liberadas = liberarReserva(sdb, trx, pasos);
    const set = {
        state: 'cancelled', reason: { code: MOTIVO_CODE, name: MOTIVO }, updatedAt: at,
        oms: resumenCancelado(trx, at),
    };
    if (trx.reserveSourceDepositCode) { set.reserveSourceDepositCode = ''; set.reserveExpiresAt = null; }
    const r = sdb.transactions.updateOne({ _id: trx._id, state: { $nin: CERRADOS } }, { $set: set });
    if (!r.matchedCount) throw new Error('el pedido cambió de estado mientras corría el script');
    pasos.push(liberadas ? `reserva liberada (${liberadas} u.)` : 'sin reserva');
    pasos.push('pedido anulado');
}

/* ----------------------------------------------------------------------------
 *  COBROS ABIERTOS  (chargeCancelService.closeOpenCharges, sin la baja en el proveedor)
 * ------------------------------------------------------------------------- */
function cerrarCobros(trx, cobros, pasos, pendientes) {
    for (const pr of cobros) {
        const at = ahora();
        const vivo = pr.expiresAt && new Date(pr.expiresAt).getTime() > Date.now() ? new Date(pr.expiresAt) : null;
        const detail = `Cerrado por limpieza inicial del OMS sin aviso al proveedor (${pr.provider}/${pr.channel}): puede seguir activo hasta vencer.`;
        const closing = { at, reason: 'transaction_cancelled', providerClosed: false, detail };
        if (vivo) closing.aliveUntil = vivo;
        const w = db.paymentrequests.updateOne({ _id: pr._id, status: { $in: COBRO_ABIERTO } }, {
            $set: { status: 'cancelled', closing, updatedAt: at },
            $push: { events: { ts: at, status: 'cancelled', rawData: JSON.stringify({ reason: 'transaction_cancelled', providerClosed: false }) } },
        });
        if (!w.modifiedCount) continue;
        pasos.push(`cobro ${pr.provider}/${pr.channel} cerrado acá`);
        pendientes.cobros.push({ company: trx.companyCode, pedido: numeroDe(trx), provider: pr.provider, channel: pr.channel,
                                 externalId: pr.externalId || '', amount: pr.amount || 0, vence: vivo ? vivo.toISOString() : 'vencido' });
    }
}

/* ----------------------------------------------------------------------------
 *  ENVIOS  (shippingService.CancelShipment sin el llamado al operador + UpdateTransactionDelivery
 *  + Package libres + orderPreparationService.releaseAllocations)
 * ------------------------------------------------------------------------- */
function liberarAsignaciones(cc, shipmentId, trxIds) {
    let released = 0;
    for (const id of Array.from(new Set(trxIds.filter(Boolean).map(idStr)))) {
        const t = db.transactions.findOne({ _id: toOid(id), companyCode: cc }, { preparation: 1 });
        const lines = (t && t.preparation && t.preparation.lines) ? t.preparation.lines.map(l => Object.assign({}, l)) : [];
        if (!lines.length) continue;
        let toco = false;
        for (const l of lines) {
            const antes = (l.allocations || []).length;
            if (!antes) continue;
            const quedan = l.allocations.filter(a => idStr(a.shipmentId) !== idStr(shipmentId));
            if (quedan.length === antes) continue;
            released += l.allocations.filter(a => idStr(a.shipmentId) === idStr(shipmentId)).reduce((acc, a) => acc + Number(a.qty || 0), 0);
            if (quedan.length) l.allocations = quedan; else delete l.allocations;
            toco = true;
        }
        if (toco) db.transactions.updateOne({ _id: toOid(id), companyCode: cc }, { $set: { 'preparation.lines': lines }, $inc: { 'preparation.rev': 1 } });
    }
    return released;
}

function anularEnvio(trx, envio, pasos, pendientes) {
    const cc = trx.companyCode, at = ahora();
    const w = db.shipments.updateOne({ _id: envio._id, state: { $in: ENVIO_ANULABLE } }, {
        $set: { state: 'cancelled', extOrderId: `${envio.extOrderId}~${idStr(envio._id)}`, updatedAt: at },
        $push: { events: { date: at, state: 'cancelled', rawStatus: 'ANULADO', source: 'desk' } },
    });
    if (!w.modifiedCount) { pasos.push(`envío ${idStr(envio._id)} ya no estaba anulable`); return; }

    if (envio.transactionId) {
        const setDeliv = { 'delivery.shippingId': '', 'delivery.shipmentState': 'cancelled', 'delivery.labelAt': null, 'delivery.assignedToName': '' };
        if (envio.carrier === 'own') setDeliv['delivery.carrierOwn'] = true;
        db.transactions.updateOne({ _id: envio.transactionId }, { $set: setDeliv });
    }
    db.packages.updateMany({ companyCode: cc, shipmentId: envio._id }, {
        $unset: { shipmentId: 1 },
        $push: { history: { at, user: '', what: `El envío ${envio.trackingNumber || idStr(envio._id)} se anuló: el paquete quedó libre.` } },
    });
    if (envio.transactionId) {
        const arriba = upstreamIds(cc, envio.transactionId);
        liberarAsignaciones(cc, envio._id, [idStr(envio.transactionId), ...arriba]);
    }
    pasos.push(`envío ${envio.carrier} ${envio.trackingNumber || idStr(envio._id)} anulado acá`);
    if (CARRIER_AVISO_MANUAL.includes(envio.carrier))
        pendientes.envios.push({ company: cc, pedido: numeroDe(trx), carrier: envio.carrier, tracking: envio.trackingNumber || '',
                                 extOrderId: envio.extOrderId || '', estado: envio.state });
}

/* ----------------------------------------------------------------------------
 *  UNO POR UNO
 * ------------------------------------------------------------------------- */
function planDe(p, info) {
    const partes = [];
    if (info.envios.anulables.length) partes.push(`anular ${info.envios.anulables.length} envío(s) anulable(s)`);
    partes.push(info.conReserva ? `liberar la reserva (${info.remanente} u.)` : 'sin reserva que liberar');
    if (info.cobros.length) partes.push(`cerrar ${info.cobros.length} cobro(s) abierto(s)`);
    partes.push('anular el pedido' + ((info.remitos.length || info.facturas.length) ? ' (remitos/facturas intactos)' : ''));
    return partes.join(' + ');
}

function ejecutarUno(p, info, pendientes) {
    const pasos = [];
    const session = db.getMongo().startSession();
    try {
        session.startTransaction();
        const sdb = session.getDatabase(db.getName());
        cancelarPedido(sdb, p, pasos);
        session.commitTransaction();
    }
    catch (e) { try { session.abortTransaction(); } catch (_) {} throw e; }
    finally { session.endSession(); }
    // Como en setState: DESPUÉS del commit y sin poder deshacer la anulación.
    try { cerrarCobros(p, info.cobros, pasos, pendientes); } catch (e) { pasos.push(`cobros: ${e.message}`); }
    for (const envio of info.envios.anulables) {
        try { anularEnvio(p, envio, pasos, pendientes); } catch (e) { pasos.push(`envío ${idStr(envio._id)}: ${e.message}`); }
    }
    return pasos;
}

function main() {
    const res = { filas: [], cancelados: 0, yaCerrados: 0, errores: 0, simulados: 0 };
    const pendientes = { cobros: [], envios: [], enCurso: [], noAnulables: [] };
    log(`=== ${DRY_RUN ? 'ENSAYO (DRY_RUN = true, no escribe)' : 'EJECUCIÓN'} · ${ahora().toISOString()} · base ${db.getName()} · empresas: ${COMPANIES.join(',') || 'TODAS'} ===`);
    let empresa = '';
    for (const p of pedidosAbiertos()) {
        if (p.companyCode !== empresa) { empresa = p.companyCode; log(`\n--- ${empresa} ---`); }
        const f = { company: p.companyCode, numero: numeroDe(p), resultado: 'simulado', detalle: '' };
        try {
            const fresco = db.transactions.findOne({ _id: p._id });
            if (!fresco || fresco.deleted === true || CERRADOS.includes(String(fresco.state))) {
                f.resultado = 'ya_cerrado'; res.yaCerrados++;
                log(`  ${f.numero.padEnd(22)} ya cerrado (${fresco ? fresco.state : 'no existe'})`);
            }
            else {
                const info = relevar(fresco);
                for (const e of info.envios.enCurso) pendientes.enCurso.push({ company: p.companyCode, pedido: f.numero, carrier: e.carrier, tracking: e.trackingNumber || '', estado: e.state });
                for (const e of info.envios.noAnulables) pendientes.noAnulables.push({ company: p.companyCode, pedido: f.numero, carrier: e.carrier, tracking: e.trackingNumber || '', estado: e.state });
                log(`  ${f.numero.padEnd(22)} ${fecha(fresco.date)}  canal=${String((fresco.channel && fresco.channel.code) || '-').padEnd(10)} `
                    + `remito=${info.remitos.length ? 'SI' : 'no'} factura=${info.facturas.length ? 'SI' : 'no'}  `
                    + `envíos vivos=${info.envios.anulables.length + info.envios.enCurso.length + info.envios.noAnulables.length} `
                    + `(anulables ${info.envios.anulables.length}, en curso ${info.envios.enCurso.length}, ML/Andreani ${info.envios.noAnulables.length})  `
                    + `cobros abiertos=${info.cobros.length}  reserva=${info.conReserva ? `SI (${info.remanente} u.)` : 'no'}`);
                if (DRY_RUN) { res.simulados++; log(`      haría: ${planDe(fresco, info)}`); }
                else {
                    const pasos = ejecutarUno(fresco, info, pendientes);
                    const fin = db.transactions.findOne({ _id: p._id }, { state: 1 });
                    f.detalle = pasos.join('; ');
                    if (fin && fin.state === 'cancelled') { f.resultado = 'cancelado'; res.cancelados++; }
                    else { f.resultado = 'error'; f.detalle += `; quedó en ${fin && fin.state}`; res.errores++; }
                    log(`      ${f.resultado.toUpperCase()}: ${f.detalle}`);
                }
            }
        }
        catch (e) { f.resultado = 'error'; f.detalle = e.message; res.errores++; log(`      ERROR: ${e.message}`); }
        res.filas.push(f);
    }

    const porEmpresa = {};
    for (const f of res.filas) porEmpresa[f.company] = (porEmpresa[f.company] || 0) + 1;
    log('\n=== RESUMEN ===');
    log(`pedidos abiertos: ${res.filas.length}  (${Object.entries(porEmpresa).map(([k, v]) => `${k} ${v}`).join(', ') || '-'})`);
    if (DRY_RUN) log(`a cancelar: ${res.simulados} · ya cerrados: ${res.yaCerrados} · con error al evaluar: ${res.errores}`);
    else log(`cancelados: ${res.cancelados} · ya cerrados: ${res.yaCerrados} · con error: ${res.errores}`);
    for (const f of res.filas.filter(x => x.resultado === 'error')) log(`  ERROR ${f.company} ${f.numero}: ${f.detalle}`);

    log('\n=== LO QUE ESTE SCRIPT NO HACE (lo hace la pantalla y acá queda a mano) ===');
    if (!DRY_RUN) {
        log(`cobros cerrados acá SIN baja en el proveedor: ${pendientes.cobros.length}` + (pendientes.cobros.length ? ' (vencer el link en Mercado Pago / el QR de MODO vence solo):' : ''));
        for (const c of pendientes.cobros) log(`  ${c.company} ${c.pedido}: ${c.provider}/${c.channel} ${c.externalId} $${c.amount} vence ${c.vence}`);
        log(`envíos anulados acá SIN aviso a OCA / Correo Argentino: ${pendientes.envios.length}` + (pendientes.envios.length ? ' (anular en el sitio del operador):' : ''));
        for (const e of pendientes.envios) log(`  ${e.company} ${e.pedido}: ${e.carrier} ${e.tracking} (${e.extOrderId}, estaba ${e.estado})`);
    }
    log(`envíos EN CURSO que no se tocan (ya salieron; gestionarlos con el operador): ${pendientes.enCurso.length}`);
    for (const e of pendientes.enCurso) log(`  ${e.company} ${e.pedido}: ${e.carrier} ${e.tracking} (${e.estado})`);
    log(`envíos de Mercado Libre / Andreani que no se tocan (los anula el canal): ${pendientes.noAnulables.length}`);
    for (const e of pendientes.noAnulables) log(`  ${e.company} ${e.pedido}: ${e.carrier} ${e.tracking} (${e.estado})`);
    log('caché Redis: no se invalida (la API cachea config/company/store, no transacciones; si un listado quedara viejo, reiniciar la API).');
    if (DRY_RUN) log('\nPara ejecutar: DRY_RUN = false y volver a pegar.');
    return res;
}

main();
