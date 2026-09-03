# Normalizar permisos de roles (septiembre 2026)

Verifica —y si hace falta corrige— que los roles hayan pasado al vocabulario nuevo de permisos:
listas de precio y condiciones **por contexto** (venta / compra) y Centro de Análisis **por módulo**.

## Cuándo usarlo

- Después de un deploy, para confirmar que las migraciones `1.0.44`, `1.0.45` y `1.0.46` corrieron.
- Si en la matriz de Roles del ERP aparecen permisos que deberían estar separados, **y ya
  confirmaste que el ERP desplegado es el nuevo** (ver más abajo: la matriz NO se arma con los
  roles, así que este script no cambia lo que se ve en pantalla).
- Si el API no pudo migrar (la instancia con rol `scheduler`/`standalone` no arrancó, o el
  arranque quedó esperando el lock `boot:migrations`).

## Uso

```bash
# en el servidor, con el entorno del API cargado
export MONGO_URL="mongodb://..."       # /usr/local/etc/egarian_api/.env.production

node normalizar-permisos-roles.js              # DRY RUN: diagnóstico, no escribe
node normalizar-permisos-roles.js --aplicar    # escribe
```

Usa `mongoose`, que no está en esta carpeta: copiá el script al directorio del API (donde está
su `node_modules`) o apuntá `NODE_PATH` a él:

```bash
NODE_PATH=/var/www/egarian-api/node_modules MONGO_URL="..." node normalizar-permisos-roles.js
```

Primero informa el estado de las tres migraciones y después lista, rol por rol, qué claves
viejas quita y qué variantes nuevas suma. Sin `--aplicar` no toca nada.

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

- **DRY RUN por defecto**, **idempotente** (`$addToSet` / `$pull`) y no inventa permisos: cada
  clave nueva sale de una vieja que el rol ya tenía.
- **No toca los roles puro-legacy** (los que sólo tienen IDs de menú). Agregarles claves los haría
  evaluar "tal cual" y perderían todo lo que el mapa de compatibilidad les expande — misma regla
  que las migraciones.

## Ojo: esto no arregla la pantalla

La matriz de Roles arma sus filas con el **menú del ERP** y el **catálogo del API**, no con los
permisos guardados. Si ves permisos de compras dentro de Ventas, lo que está viejo es el **ERP
desplegado**, y se arregla desplegando el ERP nuevo y reiniciando su proceso — no con este script.
Un ERP viejo declara una sola vista de Listas con la clave genérica `listprice.` y la matriz, al
derivar por prefijo, engancha las seis variantes y las muestra juntas.

Señales de que el ERP desplegado es viejo, en esa misma pantalla:
- sigue apareciendo el selector **"Perfil típico"** con el botón *Aplicar plantilla* (se quitó);
- **no** aparece la leyenda de *sensible* / *compartido* arriba de la matriz;
- **no** aparece al final la sección **"Aplicaciones"** con *Punto de Venta* y *Aplicación móvil*.
