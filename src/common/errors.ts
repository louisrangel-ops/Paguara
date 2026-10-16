/** Error de API con forma Stripe: { error: { type, code, message } }. */
export class ApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
    readonly type: 'invalid_request_error' | 'payment_error' | 'idempotency_error' | 'api_error' = 'invalid_request_error',
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const notFound = (what: string, id: string) => new ApiError(404, 'resource_missing', `No existe ${what} ${id}`);
