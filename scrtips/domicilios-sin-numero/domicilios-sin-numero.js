/* =============================================================================
 *  DOMICILIOS SIN NUMERO: PASAR EL "SN" DEL TEXTO AL CAMPO ALTURA (septiembre 2026)
 *                                       —  mongosh / Studio 3T (IntelliShell)
 * =============================================================================
 *  La migracion 1.0.47 separo calle y altura de todos los domicilios. Los que NO se
 *  pudieron separar quedaron con `addressNeedsReview: true` y la altura vacia. De esos,
 *  una buena parte son domicilios que REALMENTE no tienen numero: el texto ya lo dice
 *  ("MONTE VERA SN", "AMERICO CARCEGLIA S/N", "... SIN NUMERO").
 *
 *  Este script les pasa esa marca al campo `streetNumber` con el valor "S/N", se la saca
 *  al nombre de la calle y apaga `addressNeedsReview`. El domicilio queda:
 *
 *      street = "MONTE VERA"   streetNumber = "S/N"   address = "MONTE VERA S/N"
 *
 *  DECISION DEL USUARIO (2026-09-07), con su consecuencia declarada:
 *  el freno previo al despacho solo comprueba que la altura NO este vacia, asi que con
 *  "S/N" cargado los envios de estos clientes van a PASAR ese control y el rechazo, si
 *  el operador no acepta un domicilio sin numero, va a llegar de OCA / Andreani / Correo
 *  Argentino a mitad del despacho. El reparto propio y Mercado Libre no lo exigen.
 *
 *  QUE NO TOCA (a proposito):
 *   - Los domicilios que dicen SIN NUMERO **y ademas terminan en un numero**
 *     ("26 DE MARZO SIN NUMERO 3142"): no se sabe si ese numero es la altura o basura
 *     del import. Se listan aparte para mirarlos a mano.
 *   - Los que no mencionan SN: calles numeradas, barrios, manzanas. Otro problema.
 *   - Empresas (`companies`) y sucursales (`stores`): al 2026-09-07 no hay ninguna marcada.
 *
 *  ES IDEMPOTENTE: la segunda corrida informa que no hay nada que hacer.
 *
 *  USO
 *    1. Conectate a la base correcta (ojo con prod).
 *    2. Corre con DRY_RUN = true -> informa cuantos y muestra ejemplos del antes/despues.
 *    3. Si esta bien, pone DRY_RUN = false y volve a correr.
 *
 *  HAY UNDO: antes de escribir guarda los valores anteriores en `_backup_domicilios_sn`.
 *  Al final se imprime el snippet para revertir.
 * ========================================================================== */

// ----------------------------------------------------------------- PARÁMETROS
const DRY_RUN  = true;        // true = solo informa, no escribe
const EMPRESAS = [];          // companyCode(s) a procesar. [] = TODAS
const VALOR    = 'S/N';       // lo que se carga en el campo Altura
// -----------------------------------------------------------------------------

const ENTITIES = db.getCollection('entities');
const BACKUP   = db.getCollection('_backup_domicilios_sn');
const MARCA    = new Date().toISOString();

// "SN", "S/N", "S.N.", "SIN NUMERO", "SIN NÚMERO" como palabra suelta. El texto de estos
// domicilios viene en mayusculas del import de ML, pero se compara sin distinguir.
const TOKEN_SN = /\b(?:SIN\s+N[UÚ]MEROS?|S\s*[\/.]\s*N\.?|SN)\b/gi;

const limpiar = (texto) => String(texto || '')
    .replace(TOKEN_SN, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,.-]+$/, '')
    .trim();

const filtro = { addressNeedsReview: true, $or: [{ street: TOKEN_SN }, { address: TOKEN_SN }] };
if (EMPRESAS.length) filtro.companyCode = { $in: EMPRESAS };

const candidatos = ENTITIES.find(filtro,
    { companyCode: 1, code: 1, name: 1, address: 1, street: 1, streetNumber: 1, addressNeedsReview: 1 }).toArray();

const aplicar = [];
const ambiguos = [];
const yaHechos = [];

candidatos.forEach(e => {
    if (String(e.streetNumber || '').trim()) { yaHechos.push(e); return; }
    const base  = String(e.street || e.address || '');
    const calle = limpiar(base);
    if (!calle)              { ambiguos.push({ e, motivo: 'sin calle despues de sacar el SN' }); return; }
    // Termina en numero: no se sabe si es la altura real o basura del import.
    if (/\d\s*$/.test(calle)) { ambiguos.push({ e, motivo: 'queda un numero al final: ' + calle }); return; }
    aplicar.push({ e, calle, address: calle + ' ' + VALOR });
});

print('');
print('=== DOMICILIOS SIN NUMERO ===');
print('marcados que mencionan SN : ' + candidatos.length);
print('  -> se les carga "' + VALOR + '" : ' + aplicar.length);
print('  -> ambiguos, se dejan     : ' + ambiguos.length);
print('  -> ya tenian altura       : ' + yaHechos.length);

const porEmpresa = {};
aplicar.forEach(a => { porEmpresa[a.e.companyCode] = (porEmpresa[a.e.companyCode] || 0) + 1; });
print('\npor empresa: ' + JSON.stringify(porEmpresa));

print('\nejemplos de lo que se va a escribir:');
aplicar.slice(0, 8).forEach(a => print('  [' + a.e.companyCode + '] ' + JSON.stringify(a.e.address) +
    '\n        -> calle=' + JSON.stringify(a.calle) + ' altura=' + JSON.stringify(VALOR) + ' address=' + JSON.stringify(a.address)));

if (ambiguos.length) {
    print('\nambiguos (NO se tocan, revisar a mano):');
    ambiguos.slice(0, 10).forEach(x => print('  [' + x.e.companyCode + '] ' + JSON.stringify(x.e.address) + '   (' + x.motivo + ')'));
    if (ambiguos.length > 10) print('  ... y ' + (ambiguos.length - 10) + ' mas');
}

if (aplicar.length === 0) {
    print('\nNada que hacer. Listo.');
} else if (DRY_RUN) {
    print('\nDRY_RUN = true: no se escribio nada. Pone DRY_RUN = false y volve a correr.');
} else {
    const ids = aplicar.map(a => a.e._id);
    BACKUP.insertOne({
        marca: MARCA,
        tarea: 'domicilios-sin-numero',
        docs: aplicar.map(a => ({
            _id: a.e._id, companyCode: a.e.companyCode, code: a.e.code,
            address: a.e.address, street: a.e.street,
            streetNumber: a.e.streetNumber, addressNeedsReview: a.e.addressNeedsReview,
        })),
    });
    let escritos = 0;
    aplicar.forEach(a => {
        const r = ENTITIES.updateOne({ _id: a.e._id }, { $set: {
            street: a.calle, streetNumber: VALOR, address: a.address, addressNeedsReview: false,
        } });
        escritos += r.modifiedCount;
    });
    print('\nActualizados: ' + escritos + ' de ' + aplicar.length + '.');
    print('Backup en _backup_domicilios_sn (marca ' + MARCA + ').');
    print('\nUNDO:');
    print("const b = db.getCollection('_backup_domicilios_sn').findOne({ marca: '" + MARCA + "' });");
    print("b.docs.forEach(d => db.getCollection('entities').updateOne({_id: d._id}, {$set: {address: d.address, street: d.street, streetNumber: d.streetNumber || '', addressNeedsReview: d.addressNeedsReview}}));");
    print('\nQuedan marcados: ' + ENTITIES.countDocuments({ addressNeedsReview: true }));
}
