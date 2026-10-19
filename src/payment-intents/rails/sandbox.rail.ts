import { RailAdapter, RailChargeRequest, RailResult } from './rail-adapter';

/**
 * Riel de pruebas con resultados deterministas, al estilo de las tarjetas de
 * prueba de Stripe:
 *   teléfono termina en 0002 → insufficient_funds
 *   teléfono termina en 0003 → invalid_c2p_token
 *   métodos "push" (P2P, Zelle, Banesco Panamá, USDT, efectivo) → requires_action con instrucciones
 *   token de tarjeta "tok_3ds" → requires_action (3DS)
 *   resto → succeeded
 */
export class SandboxRail implements RailAdapter {
  constructor(readonly rail: string) {}

  async charge(req: RailChargeRequest): Promise<RailResult> {
    const ref = `sbx_${req.attemptKey}`;
    const phone = String(req.details.phone ?? '');
    if (phone.endsWith('0002')) return { status: 'failed', code: 'insufficient_funds', message: 'Fondos insuficientes', reference: ref };
    if (phone.endsWith('0003')) return { status: 'failed', code: 'invalid_c2p_token', message: 'Clave de pago C2P inválida', reference: ref };

    switch (req.method) {
      case 'pago_movil_p2p':
        return { status: 'requires_action', reference: ref, nextAction: {
          type: 'pago_movil_transfer', bank: '0102', phone: '04140000000', rif: 'J-00000000-0',
          amount: req.amount.toString(), currency: req.currency, reference_hint: req.paymentIntentId.slice(-6) } };
      case 'zelle':
        return { status: 'requires_action', reference: ref, nextAction: {
          type: 'zelle_transfer', email: 'pagos@example.com', memo: req.paymentIntentId.slice(-8),
          amount: req.amount.toString(), currency: req.currency } };
      case 'banesco_panama':
        return { status: 'requires_action', reference: ref, nextAction: {
          type: 'bank_transfer', bank: 'Banesco (Panamá), S.A.', account: '201800000000', account_type: 'Corriente',
          holder: 'Paguara Panamá, S.A.', memo: req.paymentIntentId.slice(-8), amount: req.amount.toString(), currency: req.currency } };
      case 'usdt_trc20':
      case 'usdt_polygon':
        return { status: 'requires_action', reference: ref, nextAction: {
          type: 'crypto_transfer', network: req.method === 'usdt_trc20' ? 'TRON' : 'POLYGON',
          address: `sandbox_${req.paymentIntentId}`, amount: req.amount.toString(), currency: req.currency } };
      case 'cash':
        return { status: 'requires_action', reference: ref, nextAction: { type: 'cash_voucher', code: ref } };
      case 'card_international':
        if (req.details.token === 'tok_3ds') {
          return { status: 'requires_action', reference: ref, nextAction: { type: 'three_d_secure', url: `https://sandbox.invalid/3ds/${ref}` } };
        }
        return { status: 'succeeded', reference: ref };
      default:
        return { status: 'succeeded', reference: ref };
    }
  }
}
