# egarian-deploy

Script de despliegue de Egarian en el VPS de producción. Un solo archivo: `deploy.sh`.

Vive en el servidor en `/usr/local/etc/deploy/`, al lado de los directorios de los proyectos
(`/usr/local/etc/egarian-api`, `egarian-erp`, `egarian-store`).

## Uso

```sh
# 1. En cada repo, generar el zip
npm run build all

# 2. Subir los .zip a /usr/local/etc/deploy/ en el servidor

# 3. Desplegar (todos, o solo los que se indiquen)
./deploy.sh
./deploy.sh egarian-api egarian-erp
```

El script, por cada proyecto: valida el zip, borra las carpetas que el zip reemplaza (conservando
`assets`), descomprime, instala dependencias **solo si cambiaron**, borra el zip y reinicia el
servicio con pm2. Al final imprime una tabla con la versión que quedó desplegada en cada repo.

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

**El `package-lock.json` NO viaja a producción.** Se intentó (para que prod corriera el mismo árbol
que se prueba en desarrollo) y tumbó al ERP: los locks de los repos describen árboles que no
existen — el `jsonwebtoken@9.0.1` del `node_modules` local declara las deps de la 8.x, y el lock se
generó desde ese árbol corrupto, sin las `lodash.*` que el paquete real del registry necesita. El
servidor instaló ese árbol incompleto y el arranque murió con `MODULE_NOT_FOUND`. Sin lock, npm
resuelve contra el registry y arma un árbol sano. Para volver a mandarlo hay que regenerar los
locks desde cero (`rm -rf node_modules package-lock.json && npm install`) y verificar el resultado.

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
pm2 ls                                   # los tres online
pm2 logs <proyecto> --lines 20           # arranque limpio, sin MODULE_NOT_FOUND
```

Los `logger.info` de la API no siempre llegan a `logs/`: el logger corre en modo NORMAL, que
acumula el info en un buffer y solo lo vuelca a disco cuando ocurre un error. Para verificar que
una migración corrió, preguntarle a la base (`db.dbmigrations.find()`), no al log.
