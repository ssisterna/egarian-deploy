# Domicilios sin número: pasar el "SN" del texto al campo Altura

Los domicilios que realmente no tienen número quedan con `streetNumber = "S/N"` en vez de
la altura vacía, y dejan de aparecer en el filtro *Domicilio a revisar*.

## Por qué existe

La migración `1.0.47` separó calle y altura de todos los domicilios. Los que no se pudieron
separar quedaron marcados con la altura vacía. Una buena parte de esos no son un dato que
falte: son domicilios rurales o de pueblo que **no tienen número**, y el texto ya lo decía
(`MONTE VERA SN`, `AMERICO CARCEGLIA S/N`, `... SIN NUMERO`).

Sin este script esos clientes quedaban en la lista de trabajo para siempre, porque la marca
de revisión se vuelve a encender en cada guardado mientras la altura esté vacía.

## Qué hace

Para cada cliente marcado cuyo domicilio menciona *SN*, *S/N* o *SIN NUMERO*:

```
"MONTE VERA SN"  →  street "MONTE VERA"   streetNumber "S/N"   address "MONTE VERA S/N"
```

y apaga `addressNeedsReview`. Con la altura cargada, el modelo la deja apagada en los
guardados siguientes.

## Qué NO toca, a propósito

- Los domicilios que dicen *SIN NUMERO* **y además terminan en un número**, como
  `AVENIDA JUAN DOMINGO PERON 1690 SN` o `26 DE MARZO SIN NUMERO 3142`. No se sabe si ese
  número es la altura real o basura del importador, y escribir `S/N` encima la borraría.
  Se listan al final de la corrida para mirarlos a mano.
- Los marcados que no mencionan *SN*: calles numeradas (`CALLE 148 1264`), barrios y
  manzanas. Son otro problema.
- Empresas y sucursales: al 7 de septiembre de 2026 no había ninguna marcada.

## Consecuencia declarada, decidida por el usuario

El control previo al despacho solo comprueba que la altura **no esté vacía**. Con `S/N`
cargado, los envíos de estos clientes **pasan** ese control. Si el operador no acepta un
domicilio sin número, el rechazo va a llegar de OCA, Andreani o Correo Argentino en el
momento del despacho, en vez del aviso previo del sistema. El reparto propio y Mercado
Libre no exigen altura, así que por ahí salen igual.

## Uso (Studio 3T / mongosh)

1. Conectate a la base correcta. Ojo con producción.
2. Abrí `domicilios-sin-numero.js` en IntelliShell.
3. Corré con `DRY_RUN = true`: informa cuántos se tocarían, con ejemplos del antes y el
   después, y la lista de ambiguos.
4. Si está bien, poné `DRY_RUN = false` y volvé a correr.

Es idempotente: la segunda corrida informa que no hay nada que hacer.

## Deshacer

Antes de escribir guarda los valores anteriores en `_backup_domicilios_sn`, y al terminar
imprime el `updateMany` para revertir con la marca de tiempo de esa corrida.

## Corridas hechas

| Fecha | Base | Resultado |
|---|---|---|
| 2026-09-07 | producción | 168 actualizados (todos de ladny), 60 ambiguos sin tocar. Quedaron 398 marcados. |
