# Red de seguridad de memoria del server

Pone dos protecciones que hoy no existen. **No reinicia ningún servicio** y las dos son
reversibles con `--revertir`.

## Por qué

Medido en producción el 2026-08-08:

| | |
|---|---|
| RAM | 3911 MB — en uso 1242, disponible 2444 |
| swap | **no hay** |
| a quién mataría el kernel | **`mongod`** (oom_score 781, contra 731 de la api) |
| disco, lectura aleatoria 4k | **4 MB/s** (secuencial 95–198 MB/s) |
| base de datos | 271 MB |

Sin swap el kernel **no tiene margen**: cuando la memoria aprieta, mata directo. Y el que
mataría es `mongod`, que es lo peor que puede pasar — una base cortada a mitad de una
escritura es mucho más grave que una app que pm2 levanta sola en dos segundos.

## Qué hace

1. **Swapfile de 2 GB con `swappiness=10`.** El swap vive en **disco**, no consume RAM.
   El `10` importa: por defecto está en `60`, que hace que el kernel swapee de forma
   proactiva — y con 4 MB/s de lectura aleatoria eso se notaría como lentitud sin ningún
   beneficio. Con `10` lo usa **solo bajo presión real**.
   Y son 2 GB, no más, a propósito: es un **colchón para un pico**, no un lugar donde el
   sistema pueda vivir. Con este disco, un sistema profundamente swapeado se arrastra
   igual; se busca un respiro corto, no una agonía larga.
2. **`OOMScoreAdjust=-500` en `mongod`**, vía drop-in de systemd (persistente) y también
   en caliente sobre el proceso vivo. Si el kernel alguna vez tiene que matar a alguien,
   que sea la api — que **pm2 reinicia sola**— y no la base.

## Uso

```sh
cd /usr/local/etc/deploy/scritps/memoria-red-de-seguridad
./aplicar.sh              # simula, no toca nada
./aplicar.sh --aplicar    # aplica
./aplicar.sh --revertir   # deshace todo
```

Es idempotente: se puede correr las veces que haga falta.

## Qué NO hace, y por qué

- **No configura `max_memory_restart` en pm2.** Un reinicio automático corta los requests
  en vuelo, y eso puede ser una factura a mitad de camino contra ARCA. Con el swap y la
  protección de Mongo, el reinicio automático deja de ser necesario. Si algún día se
  quiere, conviene ponerlo **alto** (1,5 GB cuando la api usa 375 MB) para que solo
  dispare ante una fuga real.
- **No toca la caché de WiredTiger.** Está en el default (1443 MB) y usa 440 MB, con una
  base de 271 MB — o sea que el techo sobra, pero bajarlo exige **reiniciar mongod** y hoy
  no hace falta: Mongo no es el que se desmadra.

## Contexto

El consumidor de memoria sin límite que teníamos —la generación de PDFs— ya quedó acotado
el 2026-08-07 con un semáforo (api `1f4ce1f`). Esto **no es apagar un incendio**: el server
nunca tuvo un OOM kill. Es poner la red por si aparece una fuga que hoy no conocemos.
