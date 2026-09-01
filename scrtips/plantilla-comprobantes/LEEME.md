# Poner al día los comprobantes de la compañía plantilla

De la compañía **plantilla** (`system`, la de `SERVER_COMPANY_MASTER`) salen los comprobantes de
toda compañía nueva: `companyService.CreateDefaults` los clona al dar de alta. Cuando la
configuración se mejora en una compañía real, la plantilla queda vieja y **cada cliente nuevo nace
atrasado**. Este script la actualiza desde una compañía modelo (`dcom` por defecto).

No reinicia nada, no toca compañías existentes, y es reversible con el backup que se saca antes.

## Uso

```bash
# En producción, desde el directorio de la app (necesita su node_modules):
cd /var/www/egarian-api
set -a; . /usr/local/etc/egarian_api/.env.production; set +a

node /ruta/plantilla-comprobantes.js              # DRY RUN: muestra el diff, NO escribe
node /ruta/plantilla-comprobantes.js --aplicar    # escribe

# Otra pareja origen/destino:
ORIGEN=dcom DESTINO=system node /ruta/plantilla-comprobantes.js
```

En local, `NODE_PATH=<repo>/egarian-api/node_modules` alcanza para resolver `mongoose`.

**Sacá el backup antes de `--aplicar`:**

```bash
mongosh "$MONGO_URL" --quiet --eval 'print(JSON.stringify(db.receipts.find({companyCode:"system"}).toArray()))' > backup-system-receipts.json
```

## Qué hace y qué no

| | |
|---|---|
| Actualiza | los comprobantes cuyo `code` ya existe en la plantilla |
| **No crea** | un código que está en el modelo y no en la plantilla — sólo lo informa |
| **No borra** | un código que está en la plantilla y no en el modelo — sólo lo informa |
| Preserva | el `_id` y el `createdAt` de la plantilla: no rompe referencias |
| Idempotente | correrlo dos veces deja el mismo resultado; la segunda no cambia nada |

Un alta o una baja en la plantilla cambia lo que recibe cada cliente nuevo. Esa decisión no la
toma un script: se informa para que la resuelva una persona.

## Tres campos que NO se copian

**`reserveStock` se fuerza en `false`.** Es el único que puede romper de verdad. La reserva
resuelve su depósito destino por el flag `reserved`, **por tienda**, y una compañía recién creada
sólo recibe el depósito `1001`. Con la reserva activada de fábrica, el cliente nuevo se crea bien
y **revienta al confirmar su primer pedido**, con el cliente en el mostrador:

> No hay un depósito de reserva configurado en la tienda.

Que la active quien tenga los depósitos armados. Desde 2026-09-01 el ERP lo valida al guardar el
comprobante y dice qué tienda falta y dónde crear el depósito.

**`reserveDepositCode` se borra.** Campo fantasma: estuvo en el schema y se sacó cuando la reserva
pasó a resolverse por el flag del depósito. Hoy no aparece en ningún repo, pero sobrevive en los
documentos viejos — en producción, en los 121 comprobantes. Nadie lo lee y aparenta configurar la
reserva, que es lo peor de los dos mundos.

**`updatedBy` / `createdBy` no viajan.** Son la auditoría de la compañía modelo. Sin esto, los
comprobantes de un cliente nuevo nacen "modificados por dcom".

## Antes de correrlo en producción

Mirá el DRY RUN completo. Los campos que pasan de ausente a un valor **igual al default del
schema** (`false`, `null`) son inocuos: sólo materializan lo que ya se aplicaba. Los que cambian un
valor real son los que hay que leer de verdad.

Medido el 2026-09-01 contra producción: 20 comprobantes de cada lado, los mismos códigos, y sólo
**17 diferencias** en 4 comprobantes (`FACB`, `FACV`, `NCV`, `PDV`) — de las cuales sólo dos son un
valor distinto: `FACB.editPrice` y `PDV.allowDeposit`.
