/**
 * PISA LOS COMPROBANTES DE LA COMPAÑIA PLANTILLA CON LOS DE UNA COMPAÑIA MODELO.
 *
 * De la plantilla (`system`, SERVER_COMPANY_MASTER) salen los comprobantes de TODA compañia
 * nueva: companyService.CreateDefaults los clona al dar de alta. Cuando la configuracion se
 * mejora en una compañia real, la plantilla queda vieja y los clientes nuevos nacen atrasados.
 * Esto la pone al dia.
 *
 * SEGURO POR DISEÑO:
 *  - DRY_RUN por defecto: sin --aplicar no escribe nada, solo muestra el diff.
 *  - IDEMPOTENTE: correrlo dos veces deja el mismo resultado (la segunda no cambia nada).
 *  - Solo ACTUALIZA los codigos que ya existen en la plantilla. No crea ni borra comprobantes:
 *    un alta o una baja en la plantilla cambia lo que recibe cada cliente nuevo y esa decision
 *    no la toma un script. Lo que sobra o falta se informa para que lo resuelva una persona.
 *  - Preserva el _id y el createdAt de la plantilla: no rompe ninguna referencia.
 *
 * QUE NO SE COPIA, Y POR QUE:
 *  - `reserveStock` se fuerza en FALSE. La reserva necesita un deposito marcado como "Deposito
 *    de reserva" en CADA tienda, y una compañia recien creada solo recibe el deposito 1001.
 *    Con la reserva activada de fabrica, el cliente nuevo revienta al confirmar su primer
 *    pedido. Que lo active el que tenga los depositos armados (el ERP ya lo valida).
 *  - Los CAMPOS FANTASMA se BORRAN (ver la lista de abajo): estan en los documentos y no en el
 *    schema, asi que nadie los lee — pero aparentan configurar algo.
 *  - `updatedBy` / `createdBy`: metadatos de auditoria de la compañia modelo. Sin ellos, los
 *    comprobantes del cliente nuevo no nacen "modificados por dcom".
 *
 * USO:
 *   node plantilla-comprobantes.js                 # DRY RUN: muestra que cambiaria
 *   node plantilla-comprobantes.js --aplicar       # escribe
 *   ORIGEN=dcom DESTINO=system node plantilla-comprobantes.js --aplicar
 *
 * MONGO_URL sale del entorno (en produccion, /usr/local/etc/egarian_api/.env.production).
 */
const mongoose = require("mongoose");

const ORIGEN  = process.env.ORIGEN  || "dcom";
const DESTINO = process.env.DESTINO || "system";
const APLICAR = process.argv.includes("--aplicar");

/**
 * CAMPOS FANTASMA: estan en los documentos y NO en el schema. Nadie los lee — Mongoose los
 * ignora al leer y al escribir — pero aparentan configurar algo, que es lo peor de los dos
 * mundos. Se borran de la plantilla para que ninguna compañia nueva los herede.
 *
 *   reserveDepositCode  el deposito de reserva se resuelve por el flag `reserved`, no por aca
 *   pendingOrigin       residuo del refacturable, previo a la migracion 1.0.32
 *   externalPayment     residuo
 *   enableSeries        residuo
 *   destiny             NO es residuo de schema: se DERIVA en cada lectura (receiptService lo
 *                       calcula desde los origin.code de los demas). Persistido no cambia nada
 *                       —la lectura lo pisa— pero confunde a quien mire la base.
 */
const FANTASMAS = [
  "reserveDepositCode", "pendingOrigin", "externalPayment", "enableSeries", "destiny",
];

/** No viajan: identidad del documento, metadatos y los campos fantasma. */
const NO_COPIAR = new Set([
  "_id", "companyCode", "createdAt", "updatedAt", "__v",
  "updatedBy", "createdBy", ...FANTASMAS,
]);

const norm = (v) => JSON.stringify(v === undefined ? null : v);

async function main() {
  if (!process.env.MONGO_URL) throw new Error("Falta MONGO_URL en el entorno.");

  await mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 10000 });
  try {
    const receipts = mongoose.connection.db.collection("receipts");

    const origen  = await receipts.find({ companyCode: ORIGEN  }).toArray();
    const destino = await receipts.find({ companyCode: DESTINO }).toArray();

    if (!origen.length)  throw new Error(`La compañia modelo '${ORIGEN}' no tiene comprobantes.`);
    if (!destino.length) throw new Error(`La plantilla '${DESTINO}' no tiene comprobantes: revisar antes de seguir.`);

    console.log(`${APLICAR ? "APLICANDO" : "DRY RUN (no escribe nada)"} — ${ORIGEN} -> ${DESTINO}`);
    console.log(`${ORIGEN}: ${origen.length} comprobantes · ${DESTINO}: ${destino.length}\n`);

    const porCodigo = new Map(destino.map((r) => [r.code, r]));

    // Altas y bajas: se informan, NO se ejecutan.
    const soloOrigen  = origen.filter((r) => !porCodigo.has(r.code)).map((r) => r.code);
    const soloDestino = destino.filter((r) => !origen.some((o) => o.code === r.code)).map((r) => r.code);
    if (soloOrigen.length)
      console.log(`AVISO — en ${ORIGEN} y no en la plantilla (NO se crean): ${soloOrigen.join(", ")}\n`);
    if (soloDestino.length)
      console.log(`AVISO — en la plantilla y no en ${ORIGEN} (NO se borran): ${soloDestino.join(", ")}\n`);

    let tocados = 0, campos = 0;

    for (const src of origen) {
      const dst = porCodigo.get(src.code);
      if (!dst) continue;

      const set = {};
      for (const [k, v] of Object.entries(src)) {
        if (NO_COPIAR.has(k)) continue;
        const valor = k === "reserveStock" ? false : v;      // la reserva NUNCA viaja encendida
        if (norm(dst[k]) !== norm(valor)) set[k] = valor;
      }
      const sobran = FANTASMAS.filter((f) => dst[f] !== undefined);
      const unset = sobran.length ? Object.fromEntries(sobran.map((f) => [f, ""])) : null;

      if (!Object.keys(set).length && !unset) continue;

      tocados++;
      campos += Object.keys(set).length;
      console.log(`### ${src.code} — ${src.name}`);
      for (const [k, v] of Object.entries(set))
        console.log(`   ${k}: ${norm(dst[k])} -> ${norm(v)}`);
      if (unset) console.log(`   se BORRAN (campos fantasma): ${sobran.join(", ")}`);

      if (APLICAR) {
        const op = {};
        if (Object.keys(set).length) op.$set = set;
        if (unset) op.$unset = unset;
        await receipts.updateOne({ _id: dst._id }, op);
      }
    }

    console.log(`\n===== ${tocados} comprobante(s), ${campos} campo(s) =====`);
    if (!APLICAR && tocados) console.log("Nada escrito. Volve a correrlo con --aplicar.");
    if (!tocados) console.log("La plantilla ya estaba al dia: no habia nada que cambiar.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
