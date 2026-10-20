/**
 * Versión vigente de los documentos legales publicados en la web (`#/legal/...`).
 * Debe coincidir con `version` en public/assets/legal.js (lo verifica test/unit/legal.test.ts).
 * Al cambiar el texto de un documento que se acepta, sube la fecha: las cuentas
 * nuevas quedan registradas con la versión nueva en dashboard.legal_acceptances.
 */
export const LEGAL_VERSION = '2026-10-20';

/** Documentos que una persona acepta al crear la cuenta (los demás son informativos). */
export const ACCEPTED_AT_SIGNUP = ['terminos', 'comercios', 'privacidad', 'uso-aceptable'] as const;
