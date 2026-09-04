/* =============================================================================
 *  ALINEAR EL ROL DE UNA COMPAÑIA CON LA PLANTILLA DE SU PLAN (septiembre 2026)
 *                                       —  mongosh / Studio 3T (IntelliShell)
 * =============================================================================
 *  Cada plan de facturacion declara su rol plantilla en `templateRoleCode`
 *  (billing_plans). Este script compara el rol REAL de una compañia contra esa
 *  plantilla y le agrega las claves de permiso que le falten.
 *
 *  POR QUE HACE FALTA: los roles de los clientes nacieron de la migracion
 *  generosa de julio, que tradujo lo que cada uno tenia en el menu viejo. Esa
 *  traduccion no sabia nada de planes, asi que una compañia puede estar pagando
 *  un plan superior y tener los permisos de uno inferior. Caso real que lo
 *  motivo: `ladny` esta en "Plan Crecimiento (Bonificado)" y su rol era el de
 *  Basico — le faltaban promociones, vouchers, listas y condiciones de compra y
 *  el asistente IA, o sea funciones de un plan que ya tenia asignado.
 *
 *  SOLO AGREGA, NUNCA QUITA. Sacarle permisos a un rol es otra decision (puede
 *  haber concesiones deliberadas a un cliente) y se hace mirando caso por caso.
 *
 *  ES IDEMPOTENTE: la segunda corrida informa que no hay nada que hacer.
 *
 *  USO
 *    1. Conectate a la base correcta (ojo con prod).
 *    2. Corré con DRY_RUN = true -> informa que claves faltan y a que rol.
 *    3. Si esta bien, poné DRY_RUN = false y volvé a correr.
 *
 *  HAY UNDO: antes de escribir guarda los permisos anteriores en la coleccion
 *  `_backup_roles_permisos`. Al final se imprime el snippet para revertir.
 * ========================================================================== */

// ----------------------------------------------------------------- PARÁMETROS
const DRY_RUN  = true;        // true = solo informa, no escribe
const EMPRESAS = ['ladny'];   // companyCode(s) a alinear. [] = TODAS las activas
// -----------------------------------------------------------------------------

const BACKUP  = db.getCollection('_backup_roles_permisos');
const esClave = p => typeof p === 'string' && p.includes('.');
const MARCA   = new Date().toISOString();
let escritos  = 0, revisados = 0;

const companias = EMPRESAS.length
    ? db.companies.find({ code: { $in: EMPRESAS }, deleted: { $ne: true } }).toArray()
    : db.companies.find({ deleted: { $ne: true }, code: { $ne: 'system' } }).toArray();

if (!companias.length) { print('No se encontro ninguna compañia con ese codigo.'); }

companias.forEach(c => {
    const planCode = c.planCode || (c.plan && c.plan.code);
    if (!planCode) { print(`⚠ ${c.code}: sin plan asignado — se saltea.`); return; }

    const plan = db.billing_plans.findOne({ code: planCode });
    if (!plan)                  { print(`⚠ ${c.code}: el plan ${planCode} no existe — se saltea.`); return; }
    if (!plan.templateRoleCode) { print(`⚠ ${c.code}: el plan ${planCode} no declara templateRoleCode — se saltea.`); return; }

    const plantilla = db.roles.findOne({ companyCode: 'system', code: plan.templateRoleCode }, { permissions: 1, name: 1 });
    if (!plantilla) { print(`⚠ ${c.code}: no existe la plantilla system/${plan.templateRoleCode} — se saltea.`); return; }

    // Los usuarios de la compañia pueden usar roles distintos: se alinean todos los que esten en uso.
    const rolesEnUso = [...new Set(db.users.find({ companyCode: c.code, deleted: { $ne: true }, isAdmin: { $ne: true } })
                                     .toArray().map(u => u.role).filter(Boolean))];
    if (!rolesEnUso.length) { print(`· ${c.code}: sin usuarios activos — nada que alinear.`); return; }

    const claveesPlantilla = plantilla.permissions.filter(esClave);

    rolesEnUso.forEach(codigoRol => {
        const rol = db.roles.findOne({ companyCode: c.code, code: codigoRol }, { permissions: 1, name: 1 });
        if (!rol) { print(`⚠ ${c.code}/${codigoRol}: el rol no existe — se saltea.`); return; }
        revisados++;

        // Un rol puro-legacy (solo IDs de menu) NO se toca: agregarle claves lo haria evaluar
        // "tal cual" y perderia todo lo que el mapa de compatibilidad le expande hoy.
        const tieneClaves = rol.permissions.some(esClave);
        if (!tieneClaves) { print(`⚠ ${c.code}/${codigoRol}: rol puro-legacy — se saltea (mismo criterio que las migraciones).`); return; }

        const actuales = new Set(rol.permissions.filter(esClave));
        const faltan   = claveesPlantilla.filter(k => !actuales.has(k)).sort();

        print(`\n${c.code}/${codigoRol} "${rol.name}"  ·  plan ${planCode} → plantilla ${plan.templateRoleCode} ("${plantilla.name}")`);
        if (!faltan.length) { print('   ✓ ya esta al dia, no falta ninguna clave.'); return; }
        print(`   faltan ${faltan.length} claves:`);
        faltan.forEach(k => print('     + ' + k));

        if (DRY_RUN) { print('   (DRY_RUN: no se escribio nada)'); return; }

        // getCollection() y NO db._backup_...: en mongosh una coleccion cuyo nombre empieza
        // con "_" NO se alcanza con notacion de punto (da undefined y explota con TypeError).
        BACKUP.insertOne({
            marca: MARCA, motivo: 'alinear-rol-al-plan',
            companyCode: c.code, roleCode: codigoRol, permissions: rol.permissions
        });
        const r = db.roles.updateOne({ _id: rol._id }, { $addToSet: { permissions: { $each: faltan } } });
        print(`   ✔ agregadas (modificados: ${r.modifiedCount})`);
        escritos++;
    });
});

print(`\n=================================================================`);
print(`Roles revisados: ${revisados} | modificados: ${escritos} | DRY_RUN=${DRY_RUN}`);
if (!DRY_RUN && escritos) {
    print(`\nPARA REVERTIR esta corrida, pegá esto:`);
    print(`db.getCollection('_backup_roles_permisos').find({marca:"${MARCA}"}).forEach(b => db.roles.updateOne({companyCode:b.companyCode, code:b.roleCode}, {$set:{permissions:b.permissions}}));`);
}
if (DRY_RUN) print(`\nSi lo de arriba esta bien: poné DRY_RUN = false y volvé a correr.`);
if (!DRY_RUN && !escritos && revisados) print(`
No se escribio NADA: o ya estaba al dia, o algun rol se salteo (mira los avisos de arriba).`);
print(`\nOJO: los permisos viajan en el JWT. Quien tenga la sesion abierta no ve el cambio`);
print(`hasta volver a entrar (ver "permVersion" en el backlog).`);
