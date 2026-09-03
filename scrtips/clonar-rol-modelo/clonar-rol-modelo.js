/**
 * COPIA LOS PERMISOS DE UN ROL MODELO A LOS ROLES DE LAS DEMAS EMPRESAS.
 *
 * Se armo un rol de referencia (el del plan) con el vocabulario nuevo de permisos, y los roles
 * que ya existian en las empresas quedaron con listas viejas o incompletas. Esto los pone a
 * todos en el mismo estado, sin tener que abrir rol por rol en el ERP.
 *
 * ⚠️ ES DESTRUCTIVO: PISA la lista de permisos de cada rol alcanzado. Dos consecuencias que
 * conviene tener claras ANTES de correrlo con --aplicar:
 *
 *   1. Si una empresa tiene varios roles con alcances distintos (Cajero, Vendedor, Encargado),
 *      todos quedan IGUALES: la distincion se pierde. Por eso el DRY RUN lista los roles de
 *      cada empresa — miralos y, si hace falta, acota con --code.
 *   2. Los permisos viajan en el token de sesion: quien este conectado sigue con los viejos
 *      hasta que vuelva a entrar.
 *
 * QUE COPIA: `permissions` y `elevatedPermissions` del modelo, tal cual (la lista mixta de IDs
 * de menu + claves del catalogo es lo que hace funcionar menu y matriz juntos).
 * QUE NO TOCA: code, name, active, companyCode, _id — cada rol conserva su identidad — ni
 * `isTemplate`, que es marca de plataforma y no se hereda.
 *
 * SEGURO POR DISEÑO:
 *  - DRY RUN por defecto: sin --aplicar no escribe nada.
 *  - BACKUP obligatorio: antes de escribir guarda `backup-roles-<fecha>.json` con los permisos
 *    anteriores de cada rol tocado. Para revertir: node clonar-rol-modelo.js --revertir=<archivo>
 *  - IDEMPOTENTE: la segunda corrida no cambia nada (compara antes de escribir).
 *  - Nunca toca las empresas excluidas (por defecto system y dcom) ni los roles borrados.
 *  - Nunca toca el rol modelo.
 *
 * USO:
 *   node clonar-rol-modelo.js                          # DRY RUN: que empresas y roles alcanza
 *   node clonar-rol-modelo.js --aplicar                # escribe (deja backup)
 *   node clonar-rol-modelo.js --code=basico            # solo los roles con ese codigo
 *   node clonar-rol-modelo.js --revertir=backup-roles-2026-09-03T18-00-00.json
 *
 *   MODELO_ID=6a47c3c7451964c77c37297f   (o MODELO_COMPANY=system MODELO_CODE=basico)
 *   EXCLUIR=system,dcom                  empresas que no se tocan
 *   MONGO_URL=...                        en produccion, /usr/local/etc/egarian_api/.env.production
 */
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

const APLICAR   = process.argv.includes("--aplicar");
const REVERTIR  = (process.argv.find((a) => a.startsWith("--revertir=")) || "").split("=")[1];
const SOLO_CODE = (process.argv.find((a) => a.startsWith("--code=")) || "").split("=")[1];

const MODELO_ID      = process.env.MODELO_ID || "6a47c3c7451964c77c37297f";
const MODELO_COMPANY = process.env.MODELO_COMPANY || "";
const MODELO_CODE    = process.env.MODELO_CODE || "";
const EXCLUIR = (process.env.EXCLUIR || "system,dcom").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const mismaLista = (a, b) =>
  JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());

async function revertir(db, archivo) {
  const backup = JSON.parse(fs.readFileSync(archivo, "utf8"));
  console.log(`Revirtiendo ${backup.roles.length} rol(es) desde ${path.basename(archivo)} (tomado ${backup.fecha})\n`);
  if (!APLICAR) {
    for (const r of backup.roles) console.log(`  [${r.companyCode}] ${r.code} — volveria a ${r.permissions.length} permiso(s)`);
    console.log("\nDRY RUN: no se escribio nada. Agrega --aplicar para revertir de verdad.");
    return;
  }
  for (const r of backup.roles) {
    await db.collection("roles").updateOne(
      { _id: new mongoose.Types.ObjectId(r._id) },
      { $set: { permissions: r.permissions, elevatedPermissions: r.elevatedPermissions || [] } },
    );
  }
  console.log(`Listo: ${backup.roles.length} rol(es) revertidos.`);
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

  if (REVERTIR) {
    await revertir(db, REVERTIR);
    await mongoose.disconnect();
    return;
  }

  // ── Rol modelo ──────────────────────────────────────────────────────────────
  const filtroModelo = MODELO_COMPANY && MODELO_CODE
    ? { companyCode: MODELO_COMPANY, code: MODELO_CODE }
    : { _id: new mongoose.Types.ObjectId(MODELO_ID) };
  const modelo = await db.collection("roles").findOne(filtroModelo);
  if (!modelo) {
    console.error(`No se encontro el rol modelo (${JSON.stringify(filtroModelo)}).`);
    process.exit(1);
  }
  const permisos  = modelo.permissions || [];
  const elevados  = modelo.elevatedPermissions || [];
  console.log(`MODELO: [${modelo.companyCode}] ${modelo.code} — ${modelo.name || ""}`);
  console.log(`        ${permisos.length} permiso(s), ${elevados.length} con autorizacion\n`);

  // ── Alcance ─────────────────────────────────────────────────────────────────
  const filtro = {
    companyCode: { $nin: EXCLUIR },
    deleted: { $ne: true },
    _id: { $ne: modelo._id },
    ...(SOLO_CODE ? { code: SOLO_CODE.toLowerCase() } : {}),
  };
  const roles = await db.collection("roles").find(filtro).sort({ companyCode: 1, code: 1 }).toArray();

  console.log(`EMPRESAS EXCLUIDAS: ${EXCLUIR.join(", ")}`);
  if (SOLO_CODE) console.log(`ACOTADO al codigo de rol: ${SOLO_CODE}`);
  console.log(`ALCANCE: ${roles.length} rol(es)\n`);

  if (!roles.length) {
    console.log("No hay roles para tocar.");
    await mongoose.disconnect();
    return;
  }

  // Agrupado por empresa: si una empresa tiene VARIOS roles, pisarlos a todos los deja iguales.
  const porEmpresa = new Map();
  for (const r of roles) {
    if (!porEmpresa.has(r.companyCode)) porEmpresa.set(r.companyCode, []);
    porEmpresa.get(r.companyCode).push(r);
  }

  const pendientes = [];
  for (const [empresa, lista] of porEmpresa) {
    const aviso = lista.length > 1 ? "   <-- OJO: mas de un rol, van a quedar IGUALES" : "";
    console.log(`  ${empresa}${aviso}`);
    for (const r of lista) {
      const igual = mismaLista(r.permissions, permisos) && mismaLista(r.elevatedPermissions, elevados);
      const usuarios = await db.collection("users").countDocuments({ companyCode: empresa, role: r.code, deleted: { $ne: true } });
      console.log(`      ${r.code.padEnd(14)} ${String(r.name || "").padEnd(22)} ${String((r.permissions || []).length).padStart(3)} permisos, ${usuarios} usuario(s)${igual ? "   (ya igual al modelo)" : ""}`);
      if (!igual) pendientes.push(r);
    }
  }

  console.log(`\n${pendientes.length} rol(es) cambiarian; ${roles.length - pendientes.length} ya estan igual al modelo.`);

  if (!pendientes.length) {
    console.log("Nada que hacer.");
    await mongoose.disconnect();
    return;
  }

  if (!APLICAR) {
    console.log("\nDRY RUN: no se escribio nada.");
    console.log("Revisa la lista de arriba — sobre todo las empresas marcadas con OJO — y volve a");
    console.log("correrlo con --aplicar (o acotado con --code=<codigo>) cuando estes de acuerdo.");
    await mongoose.disconnect();
    return;
  }

  // ── Backup y escritura ──────────────────────────────────────────────────────
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archivo = path.join(__dirname, `backup-roles-${stamp}.json`);
  fs.writeFileSync(archivo, JSON.stringify({
    fecha: new Date().toISOString(),
    modelo: { _id: String(modelo._id), companyCode: modelo.companyCode, code: modelo.code },
    roles: pendientes.map((r) => ({
      _id: String(r._id), companyCode: r.companyCode, code: r.code,
      permissions: r.permissions || [], elevatedPermissions: r.elevatedPermissions || [],
    })),
  }, null, 2));
  console.log(`\nBackup: ${archivo}`);

  for (const r of pendientes) {
    await db.collection("roles").updateOne(
      { _id: r._id },
      { $set: { permissions: [...permisos], elevatedPermissions: [...elevados] } },
    );
  }
  console.log(`Listo: ${pendientes.length} rol(es) actualizados con los permisos del modelo.`);
  console.log("Los usuarios conectados conservan sus permisos viejos hasta el proximo login.");
  console.log(`Para revertir:  node clonar-rol-modelo.js --revertir=${path.basename(archivo)} --aplicar`);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
