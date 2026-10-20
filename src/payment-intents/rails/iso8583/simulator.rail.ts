import { createHash } from 'node:crypto';
import { RailAdapter, RailChargeRequest, RailResult } from '../rail-adapter';
import { encodeIso, decodeIso } from './codec';
import { Iso8583AcquirerSimulator, SIMULATOR_PROFILE, SimulatorProfile } from './simulator';

export type SimulatorScenario = 'approve' | 'decline' | 'timeout_after_approval';

/**
 * Test-only RailAdapter that exercises Paguara's real PaymentIntent orchestration
 * through ISO 8583 messages and an in-memory acquirer/issuer simulator.
 * It is intentionally NOT registered by AppModule.
 */
export class Iso8583SimulatorRail implements RailAdapter {
  readonly rail = 'ves_card_switch';
  private readonly attempts = new Map<string, { stan: string; rrn: string }>();
  private simulator: Iso8583AcquirerSimulator;

  constructor(
    private readonly scenario: SimulatorScenario = 'approve',
    profile: Partial<SimulatorProfile> = {},
  ) {
    this.simulator = new Iso8583AcquirerSimulator({
      ...SIMULATOR_PROFILE,
      currency: '928',
      ...profile,
    });
  }

  private ids(attemptKey: string) {
    const digits = createHash('sha256').update(attemptKey).digest('hex')
      .split('').map((c) => (parseInt(c, 16) % 10).toString()).join('');
    return { stan: digits.slice(0, 6), rrn: digits.slice(6, 18) };
  }

  async charge(req: RailChargeRequest): Promise<RailResult> {
    if (req.method !== 'card_national' || req.currency !== 'VES') {
      return { status: 'failed', code: 'processing_error', message: 'Método o moneda no soportados por el simulador ISO 8583' };
    }
    if (req.amount < 0n || req.amount > 999_999_999_999n) {
      return { status: 'failed', code: 'processing_error', message: 'Monto fuera del rango ISO 8583 DE4' };
    }

    const { stan, rrn } = this.ids(req.attemptKey);
    this.attempts.set(req.attemptKey, { stan, rrn });

    const baseProfile = this.simulator.profile;
    this.simulator = new Iso8583AcquirerSimulator({
      ...baseProfile,
      declineStan: this.scenario === 'decline' ? stan : undefined,
      timeoutAfterApprovalStan: this.scenario === 'timeout_after_approval' ? stan : undefined,
    });

    const now = new Date();
    const mmddhhmmss =
      String(now.getUTCMonth() + 1).padStart(2, '0') +
      String(now.getUTCDate()).padStart(2, '0') +
      String(now.getUTCHours()).padStart(2, '0') +
      String(now.getUTCMinutes()).padStart(2, '0') +
      String(now.getUTCSeconds()).padStart(2, '0');

    const raw = encodeIso('0100', {
      3: '000000',
      4: req.amount.toString().padStart(12, '0'),
      7: mmddhhmmss,
      11: stan,
      22: '090',
      25: '59',
      37: rrn,
      41: this.simulator.profile.terminalId,
      42: this.simulator.profile.merchantId,
      49: this.simulator.profile.currency,
    }, this.simulator.profile.fields);

    const { mti, fields } = decodeIso(this.simulator.exchange(raw), this.simulator.profile.fields);
    if (mti !== '0110') throw new Error('unexpected ISO 8583 response MTI');
    const code = fields[39];
    if (code === '00') return { status: 'succeeded', reference: fields[37] };
    if (code === '51') return { status: 'failed', code: 'insufficient_funds', message: 'Fondos insuficientes', reference: fields[37] };
    if (code === '05') return { status: 'failed', code: 'do_not_honor', message: 'Transacción no autorizada', reference: fields[37] };
    return { status: 'failed', code: 'card_declined', message: 'Transacción rechazada por el emisor', reference: fields[37] };
  }

  /** Test-only status lookup used to model reconciliation after an unknown timeout. */
  reconcileAttempt(attemptKey: string): RailResult {
    const id = this.attempts.get(attemptKey);
    if (!id) return { status: 'failed', code: 'processing_error', message: 'Intento ISO 8583 no encontrado' };
    const record = this.simulator.reconcile().records.find((r) => r.stan === id.stan && r.rrn === id.rrn);
    if (!record) return { status: 'pending', reference: id.rrn };
    if (record.status === 'approved') return { status: 'succeeded', reference: record.rrn };
    if (record.status === 'declined') return { status: 'failed', code: 'card_declined', message: 'Transacción rechazada', reference: record.rrn };
    return { status: 'failed', code: 'processing_error', message: 'Transacción revertida', reference: record.rrn };
  }

  reconciliationSnapshot() { return this.simulator.reconcile(); }
}
