# Cambios

Cada cambio de código, esquema, API o configuración se anota aquí en el mismo PR, con enlace a su documentación técnica.

## 2026-10-20

### Cambiado
- **Rediseño de la web** con la misma paleta y logo: landing, documentación, panel, checkout y panel interno. Animaciones ligeras sin librerías que respetan `prefers-reduced-motion`. Ver [docs/web.md](docs/web.md) y [DESIGN.md](DESIGN.md).

## 2026-10-19

### Agregado
- **Módulos de liquidación** `settlement_usdt` y `settlement_usd` (migración 009): convertir liquidaciones a USDT o USD se puede negar o bloquear por comercio. Con el módulo apagado no se guarda la regla y el corte espera (`settlement_module_disabled`). Ver [docs/modulos-por-comercio.md](docs/modulos-por-comercio.md).
- **Panel interno** en `/admin`: bandeja de solicitudes, interruptores globales y ficha por comercio con precio y límites. Nuevos `GET /internal/capabilities` y `GET /internal/capability_requests`.
- **Checkout** con los diez métodos: se suman débito inmediato, tarjeta nacional, Banesco Panamá (`next_action` `bank_transfer`) y USDT en Polygon. El sandbox devuelve instrucciones de transferencia para Banesco Panamá.
- **Interruptores por comercio** (PR #4, migración 008): métodos de pago y módulos `payment_links` y `webhooks`, `payment_method_types` en pagos y links, precio y límites negociados, auditoría, webhook `account.capability.updated`, página **Métodos de pago** del panel y `/v1/account/capabilities`. Ver [docs/modulos-por-comercio.md](docs/modulos-por-comercio.md).

### Decidido
- No se cachea en Redis el estado de las capacidades (razones en [docs/modulos-por-comercio.md](docs/modulos-por-comercio.md#decisiones)).
