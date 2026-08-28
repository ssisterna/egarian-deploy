# egarian-deploy

Despliegue de Egarian en el VPS de producción. Dos archivos: `deploy.sh` (deploys diarios)
y `ecosystem.config.js` (topología PM2 completa del VPS, fuente de verdad única).

En el servidor: `deploy.sh` vive en `/usr/local/etc/deploy/`, y `ecosystem.config.js` se copia
a su ubicación de siempre, `/usr/local/etc/ecosystem.config.js` — la raíz donde viven los
proyectos (`/usr/local/etc/egarian-api`, `egarian-erp`, `egarian-store`). No hay ecosystems por
repo: la topología completa se versiona acá y se lee en un solo lugar.

## Topología PM2

| Proceso | Instancias | Puerto | Qué hace |
|---|---|---|---|
| `egarian-api` | 1 (cluster, escalable con `pm2 scale`) | :4000 | HTTP puro (ERP, store, POS, portales). Sin crons ni migraciones. |
| `egarian-api-scheduler` | 1 (fork) | :4001 | Migraciones, crons, colas del asistente. Su HTTP es solo ops local. |
| `egarian-erp` | 1 | — | Admin BFF/UI |
| `egarian-store` | 1 | — | Storefront público |

Apache proxya SOLO a :4000; ni :4000 ni :4001 pueden estar abiertos en el firewall.

**Orden de reinicio del api** (lo hace `deploy.sh` solo): scheduler PRIMERO (aplica las
migraciones nuevas), después `pm2 reload` rolling de las web (arrancan con el esquema al día,
cero caída). Si el proceso `egarian-api-scheduler` no existe todavía, `deploy.sh` avisa y cae
al reinicio simple de siempre.

**Instalación inicial de la topología** (una vez, corte breve — horario tranquilo). Antes de
pisar el `ecosystem.config.js` actual del server, compararlo con el de este repo y trasladar
cualquier ajuste que tenga de más (env, `max_memory_restart`, etc.):

```sh
pm2 delete egarian-api
pm2 start /usr/local/etc/ecosystem.config.js
pm2 save
```

## Uso

```sh
# 1. Generar los zips. Desde egarian-api, los cuatro de una:
npm run build all

# ...o el de un repo solo, parado en ese repo (mismo comando en los cuatro):
npm run build zip

# 2. Subir los .zip a /usr/local/etc/deploy/ en el servidor

# 3. Desplegar (todos, o solo los que se indiquen)
./deploy.sh
./deploy.sh egarian-api egarian-erp
```

El script, por cada proyecto: valida el zip, borra las carpetas que el zip reemplaza (conservando
`assets`), descomprime, instala dependencias **solo si cambiaron**, borra el zip y reinicia el
servicio con pm2. Al final imprime una tabla con la versión que quedó desplegada en cada repo.

### Dependencias: no hay que decidir nada

No hace falta acordarse de ninguna variable de entorno. El script decide con lo que tiene:

| Situación | Qué hace |
|---|---|
| La huella de `package.json` + `package-lock.json` no cambió | No instala nada |
| Cambió y el zip **trae** `package-lock.json` | Instala solo: con lock aplica el árbol exacto validado en dev, no re-resuelve nada |
| Cambió y el zip **no trae** lock | Avisa y deja el comando; sin lock el install re-resolvería contra el registry |
| No hay `node_modules` | Instala siempre (si no, el servicio no arranca) |

Si las dependencias quedan pendientes, **el zip NO se borra**: se puede reintentar con
`./deploy.sh <repo>` sin volver a subirlo.

Salidas de emergencia: `DEPLOY_SKIP_DEPS=1` para deployar sin tocar dependencias aunque hayan
cambiado, y `DEPLOY_INSTALL_DEPS=1` para forzar el install aunque el zip no traiga lock.

## Decisiones que no son obvias

**El `npm install` se decide por un marcador, no por el archivo en disco.** Antes se comparaba el
`package.json` en disco antes vs. después de descomprimir. Eso es frágil: cualquier cosa que
reescriba ese archivo en el servidor (un `npm install` manual, un `audit fix`, una normalización)
lo deja distinto al del zip **para siempre**, y el script entra en un loop de `npm install` en cada
deploy. Ahora se compara la huella del `package.json`/`package-lock.json` **que viene en el zip**
contra `.deploy-deps.hash`, que se escribe solo cuando el install terminó bien (si falla, el
próximo deploy lo reintenta).

**Se instala con `--omit=dev`.** Producción no compila ni testea: recibe el `dist/` ya compilado y
arranca con `node dist/index.js`. Las devDependencies son `@types` (solo para compilar),
`typescript`, `vitest`, `nodemon`, `husky`, y pesos muertos como `mongodb-memory-server` (que se
baja un binario de Mongo entero en su postinstall). Verificado que ningún archivo de `dist/`
requiere una devDependency: el único `require('ts-node')` (en el `worker.entry` del API) está
detrás de un guard que solo aplica corriendo desde `src/`.

**El `package-lock.json` SÍ viaja a producción (desde 2026-08-06).** Historia: se deshabilitó el
2026-07-13 porque los locks describían árboles corruptos (el `jsonwebtoken@9.0.1` local declaraba
deps de la 8.x) y el ERP murió con `MODULE_NOT_FOUND`. La condición para rehabilitarlo era
regenerar los locks desde cero (`rm -rf node_modules package-lock.json && npm install`) con la
suite completa corriendo sobre ese árbol — hecho en la fase 1 de la actualización de dependencias.
Con lock, el install del servidor es determinista: aplica el árbol exacto validado en desarrollo
en vez de acumular uno propio y divergente (el deploy del 2026-08-06 sin lock dejó prod con 23
vulnerabilidades mientras dev tenía 3).

**Un `pm2 restart` fallido no pasa desapercibido.** `deploy_project` se invoca dentro de un
`if ! deploy_project`, así que `set -e` no aborta adentro de la función: si `pm2 restart` falla hay
que capturarlo a mano o el resumen mentiría diciendo que el servicio se reinició.

## Antes de desplegar una migración de base de datos

El runner de migraciones del API considera aplicada una migración por su **string de versión** en
la colección `dbmigrations`. Después del squash de migraciones (baseline v1.0.0) la numeración
volvió a arrancar en `1.0.1`, que es un número que el historial viejo ya había usado: si esa
colección todavía tiene los registros viejos, el runner saltea la migración nueva **en silencio**.

Purgar antes de desplegar:

```js
db.dbmigrations.deleteMany({})
```

## Verificar después de desplegar

```sh
pm2 ls                                   # los CUATRO online: egarian-api ×2 (cluster),
                                         # egarian-api-scheduler, egarian-erp, egarian-store
pm2 logs <proyecto> --lines 20           # arranque limpio, sin MODULE_NOT_FOUND
```

Para el api, además: el scheduler tiene que loguear las migraciones aplicadas (verificar en la
base con `db.dbmigrations.find()`), y las web tienen que haber pasado por "Esquema al día, la
instancia puede servir" en su arranque.

Los `logger.info` de la API no siempre llegan a `logs/`: el logger corre en modo NORMAL, que
acumula el info en un buffer y solo lo vuelca a disco cuando ocurre un error. Para verificar que
una migración corrió, preguntarle a la base (`db.dbmigrations.find()`), no al log.
