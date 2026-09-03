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

```bash
export MONGO_URL="mongodb://..."          # /usr/local/etc/egarian_api/.env.production
export MODELO_ID="6a47c3c7451964c77c37297f"

# Necesita mongoose: copiá el script junto al API o apuntá NODE_PATH a su node_modules
export NODE_PATH=/var/www/egarian-api/node_modules

node clonar-rol-modelo.js                  # DRY RUN: qué empresas y roles alcanza
node clonar-rol-modelo.js --aplicar        # escribe (deja backup)
node clonar-rol-modelo.js --code=basico    # sólo los roles con ese código
```

Variables: `MODELO_ID` (o `MODELO_COMPANY` + `MODELO_CODE`), `EXCLUIR` (por defecto
`system,dcom`), `MONGO_URL`.

## Volver atrás

Cada corrida con `--aplicar` deja un `backup-roles-<fecha>.json` con los permisos anteriores de
cada rol tocado:

```bash
node clonar-rol-modelo.js --revertir=backup-roles-2026-09-03T18-35-13-020Z.json --aplicar
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
