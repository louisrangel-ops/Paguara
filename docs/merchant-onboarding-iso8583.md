# Onboarding del comercio y contexto ISO 8583

El onboarding de Paguara separa **datos declarados por el comercio**, **datos técnicos asignados por el adquirente**
y **datos dinámicos de cada transacción**. Esa separación evita que el comercio pueda inventar MID/TID/MCC y evita
usar el onboarding como almacenamiento de datos de tarjeta.

## 1. Datos que entrega el comercio

`POST /api/dashboard/account/kyc` guarda en `merchants.merchants.kyc_data`:

- Identidad: `legal_name`, `representative_name`, `representative_id`.
- Ubicación: `address_line1`, `address_line2?`, `city`, `state`, `country_code`, `postal_code?`.
- Contacto: `phone`, `support_email`.
- Negocio e-commerce: `business_activity`, `ecommerce_url`, `website?`, `statement_descriptor`.
- Liquidación: `bank_name`, `bank_account`.

El comercio **no** introduce PAN, fecha de expiración, CVV, PIN, track 1/2, criptogramas EMV ni credenciales 3DS.

## 2. Datos que asigna Paguara / el adquirente

La migración 012 crea `merchants.iso8583_profiles`. Solo la API interna puede provisionarla:

- `mcc`: categoría del comercio (4 dígitos), determinada/revisada por cumplimiento/adquirente.
- `acquirer_merchant_id`: Merchant ID (MID).
- `terminal_id`: Terminal ID (TID) lógico del canal e-commerce.
- `acquiring_institution_id`: identificador del adquirente.
- `currency_numeric`: por defecto `928` para VES.
- `pos_entry_mode`: por defecto `090` en el perfil de desarrollo.
- `pos_condition_code`: por defecto `59` en el perfil de desarrollo.
- `status`: `pending`, `provisioned` o `suspended`.

Estos valores dependen de la especificación del switch. Los defaults actuales son de desarrollo y **no sustituyen
la tabla de campos certificada por el adquirente**.

## 3. Relación con ISO 8583

La intención del modelo es alimentar el adaptador del adquirente así:

| Fuente | ISO 8583 típico | Observación |
|---|---|---|
| Actividad económica + revisión | DE18 MCC | El MCC final lo asigna/provisiona la plataforma/adquirente |
| `acquiring_institution_id` | DE32 | Longitud/codificación según perfil |
| `terminal_id` | DE41 | TID lógico e-commerce |
| `acquirer_merchant_id` | DE42 | MID |
| Nombre/ciudad/país del onboarding | DE43 | El empaquetado exacto depende del adquirente |
| `currency_numeric` | DE49 | Código numérico ISO 4217 |
| `pos_entry_mode` | DE22 | Debe ser el valor certificado para CNP/e-commerce |
| `pos_condition_code` | DE25 | Debe ser el valor certificado por el adquirente |

Los campos dinámicos no vienen del onboarding:

- DE3: processing code.
- DE4: monto.
- DE7: fecha/hora de transmisión.
- DE11: STAN.
- DE37: RRN.
- DE38: código de autorización (respuesta).
- DE39: response code.

PAN/expiry, datos 3DS (ECI/CAVV/AAV/DS Transaction ID), tokenización y campos privados de red se incorporarán
solo cuando el adquirente entregue la especificación, el flujo PCI/3DS y el proveedor de vault/tokenización estén
definidos. **CVV, PIN y track no se persisten.**

## 4. API interna de provisionamiento

- `GET /internal/merchants/:id`: KYC completo + perfil ISO 8583 para revisión.
- `POST /internal/merchants/:id/iso8583_profile`: provisiona MCC/MID/TID/adquirente y parámetros del perfil.
- `POST /internal/merchants/:id/status`: activa o restringe la cuenta después de KYC/homologación.

El endpoint de provisionamiento exige operador `master`; el comercio no puede modificar estos identificadores.

## 5. Documentación privada

La ruta web `#/docs` exige una sesión válida del dashboard. Un visitante sin sesión es redirigido a
`#/entrar?next=/docs`. Los enlaces a documentación se ocultan en navegación, pie, landing y pantalla de acceso
mientras no exista sesión.

Los archivos Markdown de `docs/` pertenecen al repositorio y no son una superficie HTTP de clientes; la regla
anterior se refiere a la documentación de integración que renderiza la aplicación web.
