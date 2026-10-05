# Limpieza inicial del OMS: cancelar todos los pedidos abiertos (05/10/2026)

Decisión del usuario: nadie opera el OMS en producción todavía; se cancelan los pedidos (PED)
abiertos de todas las empresas para empezar de cero. Presupuestos (`Receipt.isQuote`) fuera.
Nunca se borra nada. Remitos y facturas no se tocan. No se avisa a Mercado Libre, Woo ni la tienda.

## `cancelar-pedidos-abiertos.mongosh.js` — para pegar en Studio 3T

Escrituras directas que reproducen `trxService.setState(id, 'cancelled')` de la API 1.0.0.83:
estado + motivo + resumen `oms`, reserva devuelta al vendible (combos por componentes incluidos),
cobros abiertos cerrados, envíos anulables anulados (paquetes libres, proyección `delivery.*`,
asignaciones de preparación). El detalle de cada paso está en la cabecera del script.

1. Abrir IntelliShell en la conexión **EGARIAN-PRD**, base `egarian`.
2. Pegar el script entero con `DRY_RUN = true` (default): lista por empresa número, fecha, canal,
   remito/factura, envíos vivos, cobros abiertos, reserva y qué haría. No escribe.
3. Revisar el bloque final **"LO QUE ESTE SCRIPT NO HACE"**: envíos en curso y de Mercado Libre.
4. Cambiar a `DRY_RUN = false` y volver a pegar. Resumen final: cancelados / ya cerrados / con error,
   y la lista de lo que queda a mano (links de Mercado Pago a vencer, envíos OCA / Correo Argentino a
   anular en el operador).
5. Volver a pegar es seguro: sólo toma pedidos abiertos, cada paso tiene su guarda.

Lo que la pantalla hace y este script NO:
- no pide la baja al proveedor del cobro (vencer el link en Mercado Pago, cerrar la orden del QR);
  los cobros quedan `cancelled` con `closing.providerClosed = false` y `aliveUntil`;
- no llama a OCA / Correo Argentino para anular el envío: queda anulado acá y listado para avisar;
- no invalida la caché Redis (la API no cachea transacciones).

Prueba: `egarian-api/src/__tests__/integration/oms-limpieza-pedidos-abiertos-mongosh.integration.test.ts`
corre el script real con `mongosh` contra un replica set en memoria (ensayo, ejecución, idempotencia).
