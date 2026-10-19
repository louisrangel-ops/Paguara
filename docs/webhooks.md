# Webhooks

Código: `src/webhooks/webhooks.service.ts`. Esquema: `webhooks.*` (migración 007).

## Outbox transaccional

`enqueueEvent(client, …)` se llama **dentro de la transacción** que produjo el cambio: inserta el evento en
`webhooks.events` y una fila en `webhooks.deliveries` por cada endpoint `enabled` del comercio suscrito a ese tipo
(o a `*`). Si la transacción se deshace, el evento también: nunca se avisa algo que no pasó ni se pierde algo que sí pasó.

## Tipos de evento (`EVENT_TYPES`)

`payment_intent.created`, `payment_intent.requires_action`, `payment_intent.succeeded`,
`payment_intent.payment_failed`, `payment_intent.canceled`, `payment_intent.settled`, `payout.created`.

Cuándo se emite cada uno: [payment-intents.md](payment-intents.md#webhooks-que-emite); `payout.created` en cada
liquidación del corte de lote.

Cuerpo:
```json
{ "id": "evt_…", "object": "event", "type": "payment_intent.succeeded", "livemode": false,
  "created": 1760900000, "data": { "object": { …PaymentIntent sin client_secret… } } }
```

## Entrega

El worker corre dentro de la API (`onModuleInit`) cada `WEBHOOK_POLL_MS` (2000 ms). `WEBHOOK_WORKER=false` lo apaga.

- Toma hasta 20 entregas vencidas con `FOR UPDATE SKIP LOCKED` y un lease de 60 s: varias réplicas no repiten la misma entrega.
- `POST` con `Content-Type: application/json`, `User-Agent: PasarelaWebhooks/1.0`, `Webhook-Id: <evt_id>` y `Webhook-Signature`.
- Timeout de 10 s. Éxito = HTTP 2xx. La respuesta del comercio no se lee ni se guarda.
- Hasta 8 intentos con espera `30 s × 2^(n−1)`: 30 s, 1, 2, 4, 8, 16, 32 min. Después queda `failed`.

## Firma

```
Webhook-Signature: t=<unix>,v1=<hex>
v1 = HMAC_SHA256(secret, "<t>.<cuerpo crudo>")
```
`secret` es el `whsec_…` del endpoint (`signPayload`). El comercio debe verificar la firma sobre el cuerpo crudo y rechazar `t` muy antiguos.

## Protección SSRF

- `validateEndpointUrl`: solo `https://` (salvo `WEBHOOK_ALLOW_HTTP=true`), sin usuario/clave en la URL, y no `localhost` ni IPs privadas (salvo `WEBHOOK_ALLOW_PRIVATE=true`).
- `guardedLookup` valida **la IP con la que realmente se conecta** en cada entrega, así un dominio que luego apunte a la red interna queda bloqueado.
- Rangos bloqueados (`isPrivateAddress`): 10/8, 127/8, 0/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10, ≥224; IPv6 `::1`, `::`, `fc`/`fd`, `fe80`, y IPv4 mapeadas.

## Gestión desde el dashboard

Crear (devuelve el secreto), revelar secreto, activar/desactivar, enviar evento de prueba (`pi_prueba`, solo a ese
endpoint), listar eventos con sus entregas y reenviar un evento (reinicia los intentos en todos sus endpoints).
Rutas en [dashboard-api.md](dashboard-api.md#desarrolladores).

Rotar el secreto: crear un endpoint nuevo con la misma URL y desactivar el anterior. No existe ruta para borrar un
endpoint ni para rotar su secreto en sitio (**pendiente**).

Nota: las columnas `merchants.merchants.webhook_url`/`webhook_secret` (migración 005) se llenan al crear un comercio
por `/internal/merchants`, pero el worker solo entrega a `webhooks.endpoints`.
