import { Currency, isCurrency } from '../common/money';

/**
 * Plan de cuentas. El código de cuenta es legible y determinista, así que las
 * cuentas se crean bajo demanda la primera vez que se usan.
 *
 *  platform:rail_clearing:<riel>:<MON>  activo   · lo que el banco/riel nos debe por cobros aprobados
 *  platform:cash:<MON>                  activo   · bancos propios / tesorería (VES, USD Panamá, wallet USDT)
 *  platform:fee_revenue:<MON>           ingreso  · comisiones (MDR)
 *  platform:fx_spread_revenue:<MON>     ingreso  · spread cambiario cobrado al convertir liquidaciones
 *  platform:tax_payable:<imp>:<MON>     pasivo   · IVA sobre comisión, retenciones (SENIAT)
 *  platform:fx_position:<MON>           patrimonio, puede ser negativo · posición cambiaria por conversiones
 *  merchant:<id>:pending:<MON>          pasivo   · cobrado, aún no recibido del riel
 *  merchant:<id>:available:<MON>        pasivo   · recibido, disponible para liquidar al comercio
 */
export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface AccountSpec {
  code: string;
  name: string;
  type: AccountType;
  currency: Currency;
  ownerType: 'platform' | 'merchant';
  ownerId: string | null;
  allowNegative: boolean;
}

const SEGMENT = /^[a-z0-9_]+$/i;
function seg(value: string, what: string): string {
  if (!SEGMENT.test(value)) throw new Error(`${what} inválido para código de cuenta: "${value}"`);
  return value;
}

export const Accounts = {
  railClearing: (rail: string, c: Currency) => `platform:rail_clearing:${seg(rail, 'riel')}:${c}`,
  cash: (c: Currency) => `platform:cash:${c}`,
  feeRevenue: (c: Currency) => `platform:fee_revenue:${c}`,
  fxSpreadRevenue: (c: Currency) => `platform:fx_spread_revenue:${c}`,
  taxPayable: (tax: string, c: Currency) => `platform:tax_payable:${seg(tax, 'impuesto')}:${c}`,
  fxPosition: (c: Currency) => `platform:fx_position:${c}`,
  merchantPending: (merchantId: string, c: Currency) => `merchant:${seg(merchantId, 'comercio')}:pending:${c}`,
  merchantAvailable: (merchantId: string, c: Currency) => `merchant:${seg(merchantId, 'comercio')}:available:${c}`,
};

export function accountSpec(code: string): AccountSpec {
  const parts = code.split(':');
  const currency = parts[parts.length - 1];
  if (!isCurrency(currency)) throw new Error(`Moneda desconocida en cuenta "${code}"`);
  const platform = (type: AccountType, name: string, allowNegative = false): AccountSpec => ({
    code, name, type, currency, ownerType: 'platform', ownerId: null, allowNegative,
  });

  if (parts[0] === 'platform') {
    switch (parts[1]) {
      case 'rail_clearing':
        if (parts.length === 4) return platform('asset', `Por cobrar a riel ${parts[2]} (${currency})`);
        break;
      case 'cash':
        if (parts.length === 3) return platform('asset', `Bancos/tesorería ${currency}`);
        break;
      case 'fee_revenue':
        if (parts.length === 3) return platform('revenue', `Ingresos por comisión ${currency}`);
        break;
      case 'fx_spread_revenue':
        if (parts.length === 3) return platform('revenue', `Ingresos por spread cambiario ${currency}`);
        break;
      case 'tax_payable':
        if (parts.length === 4) return platform('liability', `Impuesto por pagar ${parts[2]} (${currency})`);
        break;
      case 'fx_position':
        if (parts.length === 3) return platform('equity', `Posición cambiaria ${currency}`, true);
        break;
    }
  } else if (parts[0] === 'merchant' && parts.length === 4) {
    const [, merchantId, bucket] = parts;
    if (bucket === 'pending' || bucket === 'available') {
      return {
        code,
        name: `Comercio ${merchantId} · ${bucket === 'pending' ? 'por recibir' : 'disponible'} ${currency}`,
        type: 'liability',
        currency,
        ownerType: 'merchant',
        ownerId: merchantId,
        allowNegative: false,
      };
    }
  }
  throw new Error(`Código de cuenta no reconocido: "${code}"`);
}
