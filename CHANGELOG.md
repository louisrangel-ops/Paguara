# Cambios

Cada cambio de código, esquema, API o configuración se anota aquí en el mismo PR, con enlace a su documentación técnica.

## 2026-10-20

### Agregado
- **Doble factor (2FA)**: app autenticadora y códigos de respaldo, obligatorio en el panel interno y opcional para los comercios. Ver [docs/doble-factor.md](docs/doble-factor.md).
- **Gestor de secretos (KMS)**: las llaves y certificados de los bancos y los demás secretos se cifran con AWS KMS en producción. Ver [docs/gestor-de-secretos.md](docs/gestor-de-secretos.md).
- **Conciliación bancaria diaria** contra el ledger, con diferencias y alertas (migración 012). Ver [docs/conciliacion.md](docs/conciliacion.md).
- **Panel total de administración y RBAC**: roles master, cumplimiento, operaciones, tesorería, soporte, auditor y operador legado; directorio de comercios, KYC, perfiles ISO 8583 y reasignación de roles. Ver [docs/admin-panel-rbac.md](docs/admin-panel-rbac.md).
- **Documentación privada y onboarding ISO 8583**: la guía de integración `#/docs` requiere sesión; el onboarding recoge identidad, ubicación, contacto y contexto e-commerce, y la migración 012 separa MCC/MID/TID y parámetros del adquirente. Ver [docs/merchant-onboarding-iso8583.md](docs/merchant-onboarding-iso8583.md).

- **Plugin de WooCommerce** (borrador): el comercio instala un .zip y su tienda cobra con Paguara; el pagador vuelve a la tienda al pagar y el pedido se marca pagado cuando Paguara lo confirma por webhook firmado. La API acepta `return_url` (migración 012). Ver [docs/integraciones/woocommerce.md](docs/integraciones/woocommerce.md) y el orden recomendado de plataformas en [docs/integraciones/README.md](docs/integraciones/README.md).

- **Documentos legales (borradores)**: términos y condiciones, acuerdo de comercio, privacidad, cookies, uso aceptable, prevención de LC/FT y divulgación responsable, como páginas del sitio en `#/legal`. El registro exige aceptarlos y guarda la constancia (migración 011). Deben pasar por un abogado venezolano antes de publicarse. Ver [docs/legal.md](docs/legal.md).

### Cambiado
- **Liquidación solo en bolívares** (migración 010), como exige la ley: lo cobrado en USD o USDT se convierte a VES en el corte y se retiran los módulos `settlement_usdt` y `settlement_usd`. Ver [docs/liquidaciones.md](docs/liquidaciones.md).
- **Métodos por contrato**: solo el maestro de Paguara habilita un método a un comercio, con la referencia del contrato. Ver [docs/modulos-por-comercio.md](docs/modulos-por-comercio.md).

### Agregado
- **Sandbox para integraciones**: en una instancia de prueba cada comercio nuevo recibe todos los métodos. Ver [docs/despliegue.md](docs/despliegue.md#sandbox-para-integraciones-de-comercios).
- **Operadores y doble aprobación**: cada persona del panel interno tiene su token y rol; ninguna liquidación se paga sin dos aprobaciones. Ver [docs/seguridad.md](docs/seguridad.md).
- **Endurecimiento**: puerto interno, cabeceras de seguridad, límite de peticiones, secretos de webhooks cifrados y arranque live sin rieles de prueba. Ver [docs/seguridad.md](docs/seguridad.md).
- **Web en Vercel** en modo demostración: `vercel.json` y `scripts/build-web.mjs`. Ver [docs/despliegue.md](docs/despliegue.md#vercel-web-en-modo-demostración).

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
