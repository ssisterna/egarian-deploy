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

Necesita `mongoose`, que no está en esta carpeta. Lo más simple en el servidor es copiarlo al
directorio del API y correrlo ahí: encuentra el `node_modules` y el `.env` solo.

```bash
cp clonar-rol-modelo.js /usr/local/etc/egarian-api/
cd /usr/local/etc/egarian-api

MODELO_ID=6a47c3c7451964c77c37297f node clonar-rol-modelo.js              # DRY RUN
MODELO_ID=6a47c3c7451964c77c37297f node clonar-rol-modelo.js --aplicar    # escribe (deja backup)
MODELO_ID=6a47c3c7451964c77c37297f node clonar-rol-modelo.js --code=basico
```

**No hace falta exportar `MONGO_URL`**: si no está en el entorno, el script lo lee del `.env` del
API (o del que le pases con `--env=/ruta/.env.production`). Se toma la línea tal cual, así que la
contraseña con `&` no se corta como pasaría al exportarla desde el shell.

Variables: `MODELO_ID` (o `MODELO_COMPANY` + `MODELO_CODE`), `EXCLUIR` (por defecto
`system,dcom`), `MONGO_URL` si querés forzarla.

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
