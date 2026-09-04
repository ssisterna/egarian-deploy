# Alinear el rol de una compañía con la plantilla de su plan

Compara el rol real de una compañía contra el rol plantilla que declara su plan
(`billing_plans.templateRoleCode`) y le agrega las claves de permiso que le falten.

## Por qué existe

Los roles de los clientes nacieron de la migración generosa de julio, que tradujo lo
que cada uno tenía en el menú viejo. Esa traducción no sabía nada de planes, así que
una compañía puede estar pagando un plan superior y tener los permisos de uno inferior.

El caso que lo motivó: **ladny** está en *Plan Crecimiento (Bonificado)* y su rol era el
de *Básico* — le faltaban promociones, vouchers, listas y condiciones de compra y el
asistente IA. Funciones de un plan que ya tenía asignado.

## Qué hace y qué no

- **Solo agrega, nunca quita.** Sacarle permisos a un rol es otra decisión (puede haber
  concesiones deliberadas a un cliente) y se mira caso por caso.
- Alinea **todos los roles en uso** por usuarios activos de la compañía, no solo uno.
- **No toca roles puro-legacy** (los que solo tienen IDs de menú): agregarles claves los
  haría evaluar "tal cual" y perderían lo que el mapa de compatibilidad les expande hoy.
  Mismo criterio que las migraciones del API.
- Es **idempotente**: la segunda corrida informa que no hay nada que hacer.

## Uso (Studio 3T / mongosh)

1. Conectate a la base correcta — ojo con producción.
2. Abrí `alinear-rol-al-plan.js` en IntelliShell.
3. Ajustá `EMPRESAS` (por defecto `['ladny']`; `[]` = todas las activas menos `system`).
4. Corré con `DRY_RUN = true` y leé qué claves faltan.
5. Si está bien, poné `DRY_RUN = false` y volvé a correr.

## Undo

Antes de escribir guarda los permisos anteriores en `_backup_roles_permisos`. Al terminar
imprime el snippet exacto para revertir esa corrida.

## Después de correrlo

Los permisos viajan en el JWT: **quien tenga la sesión abierta no ve el cambio hasta
volver a entrar**. Es el pendiente `permVersion` del backlog.
