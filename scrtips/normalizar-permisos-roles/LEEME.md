# Normalizar permisos de roles (septiembre 2026)

**Para pegar en Studio 3T / mongosh.** Verifica —y si hace falta corrige— que los roles hayan
pasado al vocabulario nuevo de permisos: listas de precio y condiciones **por contexto**
(venta / compra) y Centro de Análisis **por módulo**.

## Cuándo usarlo

- Después de un deploy, para confirmar que las migraciones `1.0.44`, `1.0.45` y `1.0.46` corrieron.
- Si el API no pudo migrar (la instancia con rol `scheduler`/`standalone` no arrancó, o el
  arranque quedó esperando el lock `boot:migrations`).

## Uso

1. Conectate a la base correcta en 3T (**ojo con prod**).
2. Pegá `normalizar-permisos-roles.js` en la IntelliShell y corrélo con `DRY_RUN = true`:
   informa el estado de las tres migraciones y lista rol por rol qué claves viejas quedaron.
3. Si hay pendientes, poné `DRY_RUN = false` y volvé a correr.

## Qué convierte

| Clave vieja | Variantes nuevas |
|---|---|
| `listprice.view/edit/delete` | `listprice.sale.*` y/o `listprice.purchase.*` |
| `admin.condition.edit/delete` | `admin.conditionSale.*` y/o `admin.conditionPurchase.*` |
| `reports.view` | `reports.sales/funds/purchases/inventory/accounting.view` |
| `reports.profitability.view` | `reports.sales.profitability.view` y/o `reports.inventory.valuation.view` |

**Qué variante recibe cada rol**: la de las vistas que ya tenía (Listas de Ventas → las de venta;
de Compras → las de compra). Si no tiene ninguna de esas vistas recibe **todas** las variantes:
la traducción es generosa a propósito, nadie pierde lo que hoy puede hacer.

## Garantías

- `DRY_RUN` arranca en `true`; es **idempotente** y no inventa permisos: cada clave nueva sale de
  una vieja que el rol ya tenía.
- **No toca los roles puro-legacy** (los que sólo tienen IDs de menú). Agregarles claves los haría
  evaluar "tal cual" y perderían todo lo que el mapa de compatibilidad les expande.
- **Undo**: antes de escribir guarda los permisos anteriores en la colección
  `_backup_roles_permisos` y al terminar imprime el snippet de reversión con el id de la corrida.

## Ojo: esto no cambia lo que se ve en la matriz de Roles

La matriz arma sus filas con el **menú del ERP** y el **catálogo del API**, no con los permisos
guardados. Si ves permisos de un módulo dentro de otro, lo que está viejo es el **ERP desplegado**:
se arregla regenerando su zip (`npm run build zip`) y desplegándolo.
