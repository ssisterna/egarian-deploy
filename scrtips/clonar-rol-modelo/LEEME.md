# Clonar un rol modelo a las demás empresas

Copia `permissions` y `elevatedPermissions` de un **rol modelo** (por ejemplo el del plan, armado
en la compañía del sistema) a los roles de las demás empresas, para dejarlos a todos en el mismo
estado sin abrirlos uno por uno en el ERP.

## ⚠️ Es destructivo: leé esto antes

**Pisa la lista de permisos de cada rol alcanzado.** Dos consecuencias:

1. **Si una empresa tiene varios roles con alcances distintos** (Cajero, Vendedor, Encargado),
   al pisarlos a todos quedan **idénticos** y esa distinción se pierde. El modo seco marca esas
   empresas con `<-- OJO` y muestra cuántos usuarios tiene cada rol: mirá esa lista antes de
   aplicar, y si hace falta acotá con `--code`.
2. **Los permisos viajan en el token de sesión**: quien esté conectado sigue con los viejos
   hasta que vuelva a entrar.

## Uso

**Para pegar en Studio 3T / mongosh** — no hay nada que copiar al servidor.

1. Conectate a la base correcta en 3T (**ojo con prod**).
2. Pegá `clonar-rol-modelo.js` en la IntelliShell y ajustá los parámetros de arriba:

```js
const MODELO_ID = '6a47c3c7451964c77c37297f';   // rol de referencia (plan básico en system)
const EXCLUIR   = ['system', 'dcom'];           // empresas que NO se tocan
const SOLO_CODE = '';                           // '' = todos los roles; o p.ej. 'basico'
const DRY_RUN   = true;                         // ponelo en false cuando estés de acuerdo
```

3. Corré primero con `DRY_RUN = true`: lista empresa por empresa qué roles alcanza, con sus
   permisos y cuántos usuarios tiene cada uno.
4. Revisá esa lista y volvé a correr con `DRY_RUN = false`.

## Volver atrás

Antes de escribir, guarda los permisos anteriores de cada rol tocado en la colección
`_backup_roles_permisos`, y al terminar imprime el snippet de reversión con el id de la corrida
— copiar, pegar y listo:

```js
db.getCollection('_backup_roles_permisos').find({ corrida: '2026-09-03T...' }).forEach(b =>
  db.roles.updateOne({ _id: b.roleId }, { $set: { permissions: b.permissions, elevatedPermissions: b.elevatedPermissions } }));
```

## Qué copia y qué no

| Copia | No toca |
|---|---|
| `permissions` (la lista mixta: IDs de menú + claves del catálogo) | `code`, `name`, `active`, `companyCode`, `_id` |
| `elevatedPermissions` (acciones "Con autorización") | `isTemplate` — es marca de plataforma, no se hereda |

Tampoco toca las empresas excluidas, los roles borrados ni el rol modelo. Es idempotente: la
segunda corrida informa "ya están igual al modelo" y no escribe.

## Después de correrlo

Pedile a los usuarios de esas empresas que **vuelvan a entrar** (o esperá al vencimiento del
token) para que tomen los permisos nuevos.
