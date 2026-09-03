/**
 * DIAGNOSTICA (y opcionalmente NORMALIZA) LOS PERMISOS DE LOS ROLES.
 *
 * Los permisos de septiembre 2026 partieron tres claves genericas en variantes por contexto o
 * por modulo. Las migraciones del API (1.0.44, 1.0.45 y 1.0.46) hacen esa conversion sola en el
 * boot; este script existe para VERIFICAR que haya pasado en produccion y, si no paso (el API
 * no se reinicio, el lock de migraciones quedo tomado, la instancia scheduler no arranco),
 * dejar la base al dia sin esperar otro deploy.
 *
 *   listprice.view|edit|delete        -> listprice.sale.*   y/o listprice.purchase.*
 *   admin.condition.edit|delete       -> admin.conditionSale.*   y/o admin.conditionPurchase.*
 *   reports.view                      -> reports.sales|funds|purchases|inventory|accounting.view
 *   reports.profitability.view        -> reports.sales.profitability.view y/o reports.inventory.valuation.view
 *
 * QUE VARIANTE RECIBE CADA ROL: la de las VISTAS que ya tenia, que es como decidieron las
 * migraciones. Un rol con la vista Listas de Ventas ('102'/'103') recibe las de venta; con la
 * de Compras ('302'/'303'), las de compra; si no tiene ninguna de las dos, recibe AMBAS — la
 * traduccion es generosa a proposito: nadie pierde lo que hoy puede hacer.
 *
 * SEGURO POR DISEÑO:
 *  - DRY_RUN por defecto: sin --aplicar no escribe nada, solo informa.
 *  - IDEMPOTENTE: la segunda corrida no cambia nada (agrega con $addToSet, quita con $pull).
 *  - Solo toca roles con vocabulario NUEVO (los que ya tienen alguna clave `dominio.recurso`).
 *    A un rol puro-legacy (solo IDs de menu) agregarle claves lo haria evaluar "tal cual" y
 *    perderia todo lo que el mapa de compatibilidad le expande: esos NO se tocan, igual que
 *    en las migraciones.
 *  - No inventa permisos: cada clave nueva sale de una vieja que el rol ya tenia.
 *
 * TAMBIEN INFORMA el estado de las migraciones del API (coleccion dbmigrations): si 1.0.44/45/46
 * no figuran, el API de ese servidor no llego a correrlas y eso es lo primero a resolver.
 *
 * USO:
 *   node normalizar-permisos-roles.js                 # DRY RUN: diagnostico completo
 *   node normalizar-permisos-roles.js --aplicar       # escribe
 *   MONGO_URL=... node normalizar-permisos-roles.js
 *
 * MONGO_URL sale del entorno (en produccion, /usr/local/etc/egarian_api/.env.production).
 */
const mongoose = require("mongoose");

const APLICAR = process.argv.includes("--aplicar");

/** [clave vieja, [ {viewIds, key} ... ] ] — que variante da cada vista que el rol ya tenia. */
const SPLITS = [
  ["listprice.view", [
    { views: ["102", "103"], key: "listprice.sale.view" },
    { views: ["302", "303"], key: "listprice.purchase.view" },
  ]],
  ["listprice.edit", [
    { views: ["102", "103"], key: "listprice.sale.edit" },
    { views: ["302", "303"], key: "listprice.purchase.edit" },
  ]],
  ["listprice.delete", [
    { views: ["102"], key: "listprice.sale.delete" },
    { views: ["302"], key: "listprice.purchase.delete" },
  ]],
  ["admin.condition.edit", [
    { views: ["100", "101"], key: "admin.conditionSale.edit" },
    { views: ["300", "301"], key: "admin.conditionPurchase.edit" },
  ]],
  ["admin.condition.delete", [
    { views: ["100"], key: "admin.conditionSale.delete" },
    { views: ["300"], key: "admin.conditionPurchase.delete" },
  ]],
  ["reports.view", [
    { views: ["120"], key: "reports.sales.view" },
    { views: ["220"], key: "reports.funds.view" },
    { views: ["320"], key: "reports.purchases.view" },
    { views: ["450"], key: "reports.inventory.view" },
    { views: ["530"], key: "reports.accounting.view" },
  ]],
  ["reports.profitability.view", [
    { views: ["120"], key: "reports.sales.profitability.view" },
    { views: ["450"], key: "reports.inventory.valuation.view" },
  ]],
];

const MIGRACIONES = ["1.0.44", "1.0.45", "1.0.46"];

/** true si la lista ya habla el vocabulario nuevo (misma regla que hasCatalogKeys del core). */
const tieneClavesNuevas = (permissions) =>
  (permissions || []).some((p) => !!p && p.includes(".") && p !== "store.switch");

/** Que claves nuevas le corresponden a este rol por una clave vieja. */
function variantesPara(permisos, destinos) {
  const propias = destinos.filter((d) => d.views.some((v) => permisos.includes(v)));
  // Sin ninguna de las vistas: generoso — recibe todas las variantes.
  return (propias.length ? propias : destinos).map((d) => d.key);
}

async function main() {
  const url = process.env.MONGO_URL;
  if (!url) {
    console.error("Falta MONGO_URL en el entorno.");
    process.exit(1);
  }

  await mongoose.connect(url);
  const db = mongoose.connection.db;
  console.log(`Base: ${mongoose.connection.name}${APLICAR ? "  [APLICAR]" : "  [DRY RUN — no escribe nada]"}\n`);

  // ── 1. Estado de las migraciones del API ────────────────────────────────────
  const aplicadas = await db.collection("dbmigrations")
    .find({ version: { $in: MIGRACIONES } }).toArray();
  const faltan = MIGRACIONES.filter((v) => !aplicadas.some((m) => m.version === v));
  console.log("MIGRACIONES DEL API");
  for (const v of MIGRACIONES) {
    const m = aplicadas.find((x) => x.version === v);
    console.log(`  ${v}  ${m ? "OK  " + (m.appliedAt || m.createdAt || "") : "NO APLICADA"}`);
  }
  if (faltan.length)
    console.log(`  >> El API de este servidor no corrio ${faltan.join(", ")}. Revisa que la instancia\n     con rol scheduler/standalone haya arrancado (el lock boot:migrations se libera solo en 30s).`);
  console.log("");

  // ── 2. Roles con claves viejas ──────────────────────────────────────────────
  const roles = await db.collection("roles").find({}).toArray();
  const pendientes = [];

  for (const rol of roles) {
    const permisos = rol.permissions || [];
    if (!tieneClavesNuevas(permisos)) continue;   // puro-legacy: no se toca

    const add = new Set();
    const pull = new Set();
    for (const [vieja, destinos] of SPLITS) {
      if (!permisos.includes(vieja)) continue;
      pull.add(vieja);
      variantesPara(permisos, destinos).forEach((k) => add.add(k));
    }
    // Las variantes que el rol YA tiene no hacen falta agregarlas de nuevo.
    for (const k of [...add]) if (permisos.includes(k)) add.delete(k);

    if (add.size || pull.size) pendientes.push({ rol, add: [...add], pull: [...pull] });
  }

  console.log(`ROLES: ${roles.length} en total, ${pendientes.length} con claves viejas para normalizar\n`);
  if (!pendientes.length) {
    console.log("Nada que hacer: los roles ya estan al dia.");
    await mongoose.disconnect();
    return;
  }

  for (const p of pendientes) {
    console.log(`  [${p.rol.companyCode}] ${p.rol.code}${p.rol.name ? " — " + p.rol.name : ""}`);
    if (p.pull.length) console.log(`      quita:  ${p.pull.join(", ")}`);
    if (p.add.length)  console.log(`      suma:   ${p.add.join(", ")}`);
  }
  console.log("");

  if (!APLICAR) {
    console.log("DRY RUN: no se escribio nada. Volve a correrlo con --aplicar para hacerlo.");
    await mongoose.disconnect();
    return;
  }

  let escritos = 0;
  for (const p of pendientes) {
    if (p.add.length)
      await db.collection("roles").updateOne({ _id: p.rol._id }, { $addToSet: { permissions: { $each: p.add } } });
    if (p.pull.length)
      await db.collection("roles").updateOne({ _id: p.rol._id }, { $pull: { permissions: { $in: p.pull } } });
    escritos++;
  }
  console.log(`Listo: ${escritos} rol(es) normalizados.`);
  console.log("Los usuarios conectados conservan sus permisos viejos hasta el proximo login (viajan en el token).");

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
