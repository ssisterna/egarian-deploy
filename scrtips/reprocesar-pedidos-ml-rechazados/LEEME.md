# Reprocesar pedidos de Mercado Libre rechazados por la guarda de medios digitales

Vuelve a poner en cola las notificaciones de órdenes de Mercado Libre que la API descartó
por confundir el pago del canal con un cobro cargado a mano.

## Por qué existe

Desde el deploy del **2026-09-01** la API tiene una guarda que impide cargar a mano un cobro
con un medio integrado (Mercado Pago o MODO): con la integración activa, el cobro se hace
generando el QR. Es la protección contra el "cobro fantasma" (comprobante emitido y dado por
cobrado sin que entre un peso).

Esa guarda corría también para los **pedidos de canal**. Una orden de Mercado Libre pagada
con Mercado Pago trae el pago adentro, ya cobrado por el canal. La API lo tomaba por una
carga manual y rechazaba la orden con:

> Mercado Pago tiene la integración activa: el cobro se hace generando el QR, no cargándolo
> como pago ya realizado.

Tras cinco intentos la notificación quedaba descartada. **La venta no llegó al ERP, pero la
notificación sigue guardada** y se puede reprocesar.

Afecta solo a empresas que tienen la integración de Mercado Pago activa **y** venden por
Mercado Libre con pagos de Mercado Pago. Encontrado el 2026-09-05 en una prueba local.

## Qué hace y qué no

- Busca notificaciones `mlibre` / `orders_v2` descartadas con ese mensaje y les pone
  `process=false`, `reprocess=true`, `attempts=0`. El proceso *Recepción de Novedades* las
  toma en su próximo tick.
- **No borra nada** y es idempotente: la segunda corrida informa que no hay nada que hacer.
- Las notificaciones de **pago** de esas órdenes, que reventaban con un error de conversión
  (`Cast to ObjectId`), se cuentan pero **no se tocan**: con el fix el webhook de pagos las
  ignora limpio, porque ese pago ya viene dentro de la orden.
- Las notificaciones con error se purgan a los **120 días**. Si una venta falta
  y no aparece en el listado del script, hay que buscarla por la API de Mercado Libre.

## Cuándo correrlo

**Solo después de deployar el fix** de la API (commit *fix(canales): el pago que cobró el
canal no es una carga manual*). Si se corre antes, las órdenes se rechazan otra vez y se
descartan de nuevo tras cinco intentos.

## Uso (Studio 3T / mongosh)

1. Conectate a la base correcta. Ojo con producción.
2. Abrí `reprocesar-pedidos-ml-rechazados.js` en IntelliShell.
3. Corré con `DRY_RUN = true`: lista las notificaciones que se reencolarían, con fecha,
   seller y orden.
4. Si está bien, poné `DRY_RUN = false` y volvé a correr.
5. Esperá un tick del proceso, o disparalo desde *Procesos* en el ERP, y verificá que los
   pedidos aparezcan en Ventas. Cada uno genera la alerta de "Nuevo Pedido" como siempre.

## Deshacer

Al final de la corrida real se imprime el `updateMany` con los `_id` tocados para volver a
marcarlas como procesadas.
