import { encodeIso, decodeIso, TEST_PROFILE, type IsoFields, type IsoProfile } from './codec';

/** In-memory certification simulator only. No sockets, PAN, HSM, or live adapter registration. */
export type SimulatorDecision = 'approve' | 'decline' | 'timeout';
export interface SimulatorProfile {
  name: string;
  fields: IsoProfile;
  currency: string;
  terminalId: string;
  merchantId: string;
  defaultDecision: SimulatorDecision;
  declineCode: string;
  timeoutStan?: string;
  timeoutAfterApprovalStan?: string;
  declineStan?: string;
}
export const SIMULATOR_PROFILE: SimulatorProfile = {
  name: 'paguara-test-ascii-v1',
  fields: TEST_PROFILE,
  currency: '840',
  terminalId: 'ECOM0001',
  merchantId: 'MERCHANT0000001',
  defaultDecision: 'approve',
  declineCode: '05',
};
export interface JournalRecord {
  stan: string;
  rrn: string;
  amount: string;
  currency: string;
  status: 'approved' | 'declined' | 'reversed';
  authorization?: string;
}
export class SimulatedTimeout extends Error {
  constructor() { super('simulated issuer timeout: outcome unknown'); this.name = 'SimulatedTimeout'; }
}
export class Iso8583AcquirerSimulator {
  private journal = new Map<string, JournalRecord>();
  private requestFingerprints = new Map<string, string>();
  constructor(readonly profile: SimulatorProfile = SIMULATOR_PROFILE) {
    if (!/^\d{3}$/.test(profile.currency) || profile.terminalId.length !== 8 || profile.merchantId.length !== 15)
      throw new Error('invalid simulator profile');
  }
  private key(stan: string, rrn: string) { return stan + ':' + rrn; }
  /** Test-only: responses are encoded ISO frames with no transport header. */
  exchange(raw: Buffer): Buffer {
    const { mti, fields: f } = decodeIso(raw, this.profile.fields);
    if (mti !== '0100' && mti !== '0400' && mti !== '0420') throw new Error('unsupported MTI in simulator');
    for (const k of [3, 4, 7, 11, 37, 41, 42, 49]) if (!f[k]) throw new Error('missing DE ' + k);
    if (f[41] !== this.profile.terminalId || f[42] !== this.profile.merchantId || f[49] !== this.profile.currency)
      throw new Error('terminal, merchant or currency mismatch');
    const key = this.key(f[11], f[37]);
    if (mti === '0100') {
      const fingerprint = [f[3],f[4],f[41],f[42],f[49]].join(':');
      const previous = this.requestFingerprints.get(key);
      if (previous && previous !== fingerprint) throw new Error('STAN/RRN reused with different transaction');
      if (this.profile.timeoutStan === f[11]) throw new SimulatedTimeout();
      let existing = this.journal.get(key);
      if (!existing) {
        const decline = this.profile.declineStan === f[11] || this.profile.defaultDecision === 'decline';
        if (this.profile.defaultDecision === 'timeout') throw new SimulatedTimeout();
        existing = { stan:f[11], rrn:f[37], amount:f[4], currency:f[49], status:decline?'declined':'approved',
          ...(decline ? {} : {authorization:'A12345'}) };
        this.journal.set(key,existing);
        this.requestFingerprints.set(key,fingerprint);
      }
      if (this.profile.timeoutAfterApprovalStan === f[11] && existing.status === 'approved') throw new SimulatedTimeout();
      const response:IsoFields = {3:f[3],4:f[4],7:f[7],11:f[11],37:f[37],39:existing.status==='approved'?'00':existing.status==='reversed'?'94':this.profile.declineCode,
        41:f[41],42:f[42],49:f[49]};
      if (existing.status==='approved') response[38]=existing.authorization!;
      return encodeIso('0110',response,this.profile.fields);
    }
    const existing=this.journal.get(key);
    if (existing && existing.amount!==f[4]) throw new Error('reversal amount mismatch');
    if (existing?.status==='approved') existing.status='reversed';
    const response:IsoFields={3:f[3],4:f[4],7:f[7],11:f[11],37:f[37],39:existing?'00':'25',41:f[41],42:f[42],49:f[49]};
    return encodeIso(mti==='0400'?'0410':'0430',response,this.profile.fields);
  }
  /** Simulates reconciliation snapshot; not a bank settlement confirmation. */
  reconcile(): { approved: number; declined: number; reversed: number; netApprovedMinor: bigint; records: JournalRecord[] } {
    const records=[...this.journal.values()].map(r=>({...r}));
    return {
      approved:records.filter(r=>r.status==='approved').length,
      declined:records.filter(r=>r.status==='declined').length,
      reversed:records.filter(r=>r.status==='reversed').length,
      netApprovedMinor:records.filter(r=>r.status==='approved').reduce((sum,r)=>sum+BigInt(r.amount),0n),
      records,
    };
  }
}
