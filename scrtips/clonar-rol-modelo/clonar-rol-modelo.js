/* =============================================================================
 *  CLONAR LOS PERMISOS DE UN ROL MODELO A LAS DEMÁS EMPRESAS
 *                                       —  mongosh / Studio 3T (IntelliShell)
 * =============================================================================
 *  Copia `permissions` y `elevatedPermissions` de un rol de referencia (el del
 *  plan, armado en la compañía del sistema) a los roles de las demás empresas,
 *  para dejarlos a todos en el mismo estado sin abrirlos uno por uno en el ERP.
 *
 *  PISA la lista de permisos de cada rol alcanzado. Dos consecuencias:
 *    · Si una empresa tiene VARIOS roles con alcances distintos (Cajero,
 *      Vendedor, Encargado), al pisarlos quedan IDÉNTICOS y esa distinción se
 *      pierde. El DRY RUN marca esas empresas con "OJO": miralas antes.
 *    · Los permisos viajan en el token de sesión: quien esté conectado sigue
 *      con los viejos hasta que vuelva a entrar.
 *
 *  QUÉ COPIA: permissions (la lista mixta de IDs de menú + claves del catálogo,
 *  que es lo que hace funcionar menú y matriz juntos) y elevatedPermissions.
 *  QUÉ NO TOCA: code, name, active, companyCode, _id — cada rol conserva su
 *  identidad — ni isTemplate, que es marca de plataforma y no se hereda.
 *  Tampoco toca las empresas excluidas, los roles borrados ni el rol modelo.
 *
 *  ES IDEMPOTENTE: la segunda corrida informa "ya está igual" y no escribe.
 *
 *  USO
 *    1. Conectate a la base correcta (ojo con prod).
 *    2. Poné MODELO_ID (y, si querés, SOLO_CODE).
 *    3. Corré con DRY_RUN = true -> lista qué tocaría, sin escribir nada.
 *    4. Revisá la lista, poné DRY_RUN = false y volvé a correr.
 *
 *  HAY UNDO: antes de escribir guarda los permisos anteriores en la colección
 *  `_backup_roles_permisos`. Al final se imprime el snippet para revertir.
 * ========================================================================== */

// ----------------------------------------------------------------- PARÁMETROS
const MODELO_ID = '6a47c3c7451964c77c37297f';   // rol de referencia (plan básico en system)
const EXCLUIR   = ['system', 'dcom'];           // empresas que NO se tocan
const SOLO_CODE = '';                           // '' = todos los roles; o p.ej. 'basico'
const DRY_RUN   = true;                         // true = solo informa, no escribe
// -----------------------------------------------------------------------------

const modelo = db.roles.findOne({ _id: ObjectId(MODELO_ID) });
if (!modelo) throw new Error('No se encontró el rol modelo ' + MODELO_ID);

const permisos = modelo.permissions || [];
const elevados = modelo.elevatedPermissions || [];

print('MODELO: [' + modelo.companyCode + '] ' + modelo.code + ' — ' + (modelo.name || ''));
print('        ' + permisos.length + ' permiso(s), ' + elevados.length + ' con autorización');
print('EXCLUIDAS: ' + EXCLUIR.join(', ') + (SOLO_CODE ? '   |   solo rol: ' + SOLO_CODE : ''));
print(DRY_RUN ? '\n*** DRY RUN — no escribe nada ***\n' : '\n*** APLICANDO ***\n');

const filtro = {
    companyCode: { $nin: EXCLUIR },
    deleted: { $ne: true },
    _id: { $ne: modelo._id }
};
if (SOLO_CODE) filtro.code = SOLO_CODE;

const roles = db.roles.find(filtro).sort({ companyCode: 1, code: 1 }).toArray();

// Igual al modelo = mismas dos listas, sin importar el orden.
const misma = (a, b) => JSON.stringify((a || []).slice().sort()) === JSON.stringify((b || []).slice().sort());

const pendientes = [];
let empresaActual = '';
roles.forEach(r => {
    if (r.companyCode !== empresaActual) {
        empresaActual = r.companyCode;
        const cuantos = roles.filter(x => x.companyCode === empresaActual).length;
        print('  ' + empresaActual + (cuantos > 1 ? '   <-- OJO: ' + cuantos + ' roles, van a quedar IGUALES' : ''));
    }
    const igual = misma(r.permissions, permisos) && misma(r.elevatedPermissions, elevados);
    const usuarios = db.users.countDocuments({ companyCode: r.companyCode, role: r.code, deleted: { $ne: true } });
    print('      ' + (r.code + '                ').slice(0, 16) +
          ((r.name || '') + '                      ').slice(0, 22) +
          ('   ' + (r.permissions || []).length).slice(-4) + ' permisos, ' +
          usuarios + ' usuario(s)' + (igual ? '   (ya igual al modelo)' : ''));
    if (!igual) pendientes.push(r);
});

print('\n' + pendientes.length + ' rol(es) cambiarían; ' + (roles.length - pendientes.length) + ' ya están igual al modelo.');

if (DRY_RUN) {
    print('\nDRY RUN: no se escribió nada. Revisá la lista — sobre todo las empresas con OJO —');
    print('y volvé a correr con DRY_RUN = false cuando estés de acuerdo.');
} else if (pendientes.length) {
    const corrida = new Date().toISOString();

    // BACKUP en la propia base: los permisos anteriores de cada rol tocado.
    // getCollection y no db._backup...: mongosh no resuelve por punto los nombres con guion bajo.
    db.getCollection('_backup_roles_permisos').insertMany(pendientes.map(r => ({
        corrida: corrida,
        roleId: r._id,
        companyCode: r.companyCode,
        code: r.code,
        permissions: r.permissions || [],
        elevatedPermissions: r.elevatedPermissions || []
    })));

    pendientes.forEach(r => {
        db.roles.updateOne(
            { _id: r._id },
            { $set: { permissions: permisos.slice(), elevatedPermissions: elevados.slice() } }
        );
    });

    print('\nListo: ' + pendientes.length + ' rol(es) actualizados.');
    print('Backup guardado en _backup_roles_permisos (corrida: ' + corrida + ').');
    print('Los usuarios conectados conservan sus permisos viejos hasta el próximo login.');
    print('\nPARA REVERTIR, pegá esto:');
    print("  db.getCollection('_backup_roles_permisos').find({ corrida: '" + corrida + "' }).forEach(b =>");
    print("    db.roles.updateOne({ _id: b.roleId }, { $set: { permissions: b.permissions, elevatedPermissions: b.elevatedPermissions } }));");
}
