/* =============================================================================
 *  NORMALIZAR LOS PERMISOS DE LOS ROLES (septiembre 2026)
 *                                       —  mongosh / Studio 3T (IntelliShell)
 * =============================================================================
 *  Los permisos de septiembre 2026 partieron tres claves genéricas en variantes
 *  por contexto o por módulo. Las migraciones del API (1.0.44, 1.0.45 y 1.0.46)
 *  hacen esa conversión solas en el boot; esto sirve para VERIFICAR que haya
 *  pasado y, si no pasó (el API no se reinició, el lock de migraciones quedó
 *  tomado, la instancia scheduler no arrancó), dejar la base al día.
 *
 *    listprice.view|edit|delete    -> listprice.sale.*  y/o  listprice.purchase.*
 *    admin.condition.edit|delete   -> admin.conditionSale.*  y/o  admin.conditionPurchase.*
 *    reports.view                  -> reports.sales|funds|purchases|inventory|accounting.view
 *    reports.profitability.view    -> reports.sales.profitability.view  y/o
 *                                     reports.inventory.valuation.view
 *
 *  QUÉ VARIANTE RECIBE CADA ROL: la de las VISTAS que ya tenía, igual que las
 *  migraciones. Un rol con la vista Listas de Ventas ('102'/'103') recibe las de
 *  venta; con la de Compras ('302'/'303'), las de compra; si no tiene ninguna de
 *  las dos, recibe AMBAS — la traducción es generosa a propósito: nadie pierde
 *  lo que hoy puede hacer.
 *
 *  NO TOCA los roles puro-legacy (solo IDs de menú): agregarles claves los haría
 *  evaluar "tal cual" y perderían todo lo que el mapa de compatibilidad les
 *  expande. Mismo criterio que las migraciones.
 *
 *  ES IDEMPOTENTE: la segunda corrida informa que no hay nada que hacer.
 *
 *  USO
 *    1. Conectate a la base correcta (ojo con prod).
 *    2. Corré con DRY_RUN = true -> informa migraciones y roles pendientes.
 *    3. Si hay pendientes, poné DRY_RUN = false y volvé a correr.
 *
 *  HAY UNDO: antes de escribir guarda los permisos anteriores en la colección
 *  `_backup_roles_permisos`. Al final se imprime el snippet para revertir.
 * ========================================================================== */

// ----------------------------------------------------------------- PARÁMETROS
const DRY_RUN = true;                  // true = solo informa, no escribe
// -----------------------------------------------------------------------------

/** [clave vieja, [ {vistas, clave nueva} ... ] ] */
const SPLITS = [
    ['listprice.view',   [{ v: ['102','103'], k: 'listprice.sale.view' },   { v: ['302','303'], k: 'listprice.purchase.view' }]],
    ['listprice.edit',   [{ v: ['102','103'], k: 'listprice.sale.edit' },   { v: ['302','303'], k: 'listprice.purchase.edit' }]],
    ['listprice.delete', [{ v: ['102'],       k: 'listprice.sale.delete' }, { v: ['302'],       k: 'listprice.purchase.delete' }]],
    ['admin.condition.edit',   [{ v: ['100','101'], k: 'admin.conditionSale.edit' },   { v: ['300','301'], k: 'admin.conditionPurchase.edit' }]],
    ['admin.condition.delete', [{ v: ['100'],       k: 'admin.conditionSale.delete' }, { v: ['300'],       k: 'admin.conditionPurchase.delete' }]],
    ['reports.view', [
        { v: ['120'], k: 'reports.sales.view' },
        { v: ['220'], k: 'reports.funds.view' },
        { v: ['320'], k: 'reports.purchases.view' },
        { v: ['450'], k: 'reports.inventory.view' },
        { v: ['530'], k: 'reports.accounting.view' }
    ]],
    ['reports.profitability.view', [
        { v: ['120'], k: 'reports.sales.profitability.view' },
        { v: ['450'], k: 'reports.inventory.valuation.view' }
    ]]
];

const MIGRACIONES = ['1.0.44', '1.0.45', '1.0.46'];

print(DRY_RUN ? '*** DRY RUN — no escribe nada ***\n' : '*** APLICANDO ***\n');

// ── 1. Estado de las migraciones del API ─────────────────────────────────────
print('MIGRACIONES DEL API');
const faltan = [];
MIGRACIONES.forEach(v => {
    const m = db.dbmigrations.findOne({ version: v });
    print('  ' + v + '  ' + (m ? 'OK  ' + (m.appliedAt || m.createdAt || '') : 'NO APLICADA'));
    if (!m) faltan.push(v);
});
if (faltan.length) {
    print('  >> El API de este servidor no corrió ' + faltan.join(', ') + '. Revisá que la instancia');
    print('     con rol scheduler/standalone haya arrancado (el lock boot:migrations se libera en 30s).');
}

// ── 2. Roles con claves viejas ───────────────────────────────────────────────
/** true si la lista ya habla el vocabulario nuevo (misma regla que hasCatalogKeys del core). */
const tieneClavesNuevas = (p) => (p || []).some(x => !!x && x.indexOf('.') >= 0 && x !== 'store.switch');

const roles = db.roles.find({}).toArray();
const pendientes = [];

roles.forEach(rol => {
    const permisos = rol.permissions || [];
    if (!tieneClavesNuevas(permisos)) return;   // puro-legacy: no se toca

    const add = [];
    const pull = [];
    SPLITS.forEach(par => {
        const vieja = par[0], destinos = par[1];
        if (permisos.indexOf(vieja) < 0) return;
        pull.push(vieja);
        // Las variantes de las vistas que el rol ya tiene; si no tiene ninguna, todas.
        const propias = destinos.filter(d => d.v.some(vista => permisos.indexOf(vista) >= 0));
        (propias.length ? propias : destinos).forEach(d => {
            if (add.indexOf(d.k) < 0 && permisos.indexOf(d.k) < 0) add.push(d.k);
        });
    });

    if (add.length || pull.length) pendientes.push({ rol: rol, add: add, pull: pull });
});

print('\nROLES: ' + roles.length + ' en total, ' + pendientes.length + ' con claves viejas para normalizar\n');

pendientes.forEach(p => {
    print('  [' + p.rol.companyCode + '] ' + p.rol.code + (p.rol.name ? ' — ' + p.rol.name : ''));
    if (p.pull.length) print('      quita:  ' + p.pull.join(', '));
    if (p.add.length)  print('      suma:   ' + p.add.join(', '));
});

if (!pendientes.length) {
    print('Nada que hacer: los roles ya están al día.');
} else if (DRY_RUN) {
    print('\nDRY RUN: no se escribió nada. Volvé a correr con DRY_RUN = false para aplicarlo.');
} else {
    const corrida = new Date().toISOString();

    // BACKUP en la propia base, antes de tocar nada.
    // getCollection y no db._backup...: mongosh no resuelve por punto los nombres con guion bajo.
    db.getCollection('_backup_roles_permisos').insertMany(pendientes.map(p => ({
        corrida: corrida,
        roleId: p.rol._id,
        companyCode: p.rol.companyCode,
        code: p.rol.code,
        permissions: p.rol.permissions || [],
        elevatedPermissions: p.rol.elevatedPermissions || []
    })));

    pendientes.forEach(p => {
        if (p.add.length)  db.roles.updateOne({ _id: p.rol._id }, { $addToSet: { permissions: { $each: p.add } } });
        if (p.pull.length) db.roles.updateOne({ _id: p.rol._id }, { $pull: { permissions: { $in: p.pull } } });
    });

    print('\nListo: ' + pendientes.length + ' rol(es) normalizados.');
    print('Backup guardado en _backup_roles_permisos (corrida: ' + corrida + ').');
    print('Los usuarios conectados conservan sus permisos viejos hasta el próximo login.');
    print('\nPARA REVERTIR, pegá esto:');
    print("  db.getCollection('_backup_roles_permisos').find({ corrida: '" + corrida + "' }).forEach(b =>");
    print("    db.roles.updateOne({ _id: b.roleId }, { $set: { permissions: b.permissions, elevatedPermissions: b.elevatedPermissions } }));");
}
