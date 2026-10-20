import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeIso, decodeIso } from '../../src/payment-intents/rails/iso8583/codec';
import { Iso8583AcquirerSimulator, SIMULATOR_PROFILE, SimulatedTimeout } from '../../src/payment-intents/rails/iso8583/simulator';
const fields=(stan='123456',amount='000000015000')=>({
  3:'000000',4:amount,7:'1020163000',11:stan,37:'629312'+stan,
  41:'ECOM0001',42:'MERCHANT0000001',49:'840'
});
const send=(sim:Iso8583AcquirerSimulator,mti:string,f=fields())=>decodeIso(sim.exchange(encodeIso(mti,f)));
test('authorization and duplicate request are idempotent',()=>{
  const sim=new Iso8583AcquirerSimulator();
  assert.equal(send(sim,'0100').fields[39],'00');
  assert.equal(send(sim,'0100').fields[38],'A12345');
  assert.equal(sim.reconcile().approved,1);
  assert.equal(sim.reconcile().netApprovedMinor,15000n);
});
test('issuer decline',()=>{
  const sim=new Iso8583AcquirerSimulator({...SIMULATOR_PROFILE,declineStan:'123456'});
  assert.equal(send(sim,'0100').fields[39],'05');
  assert.equal(sim.reconcile().declined,1);
});
test('timeout leaves unknown and no ledger entry',()=>{
  const sim=new Iso8583AcquirerSimulator({...SIMULATOR_PROFILE,timeoutStan:'123456'});
  assert.throws(()=>send(sim,'0100'),SimulatedTimeout);
  assert.equal(sim.reconcile().records.length,0);
});
test('reversal and duplicate reversal do not double subtract',()=>{
  const sim=new Iso8583AcquirerSimulator();
  send(sim,'0100');
  assert.equal(send(sim,'0400').fields[39],'00');
  assert.equal(send(sim,'0400').fields[39],'00');
  assert.equal(sim.reconcile().reversed,1);
  assert.equal(sim.reconcile().netApprovedMinor,0n);
});
test('reversal advice response and unmatched reversal',()=>{
  const sim=new Iso8583AcquirerSimulator();
  assert.equal(send(sim,'0420').mti,'0430');
  assert.equal(send(sim,'0420').fields[39],'25');
});
test('reject conflicting duplicate and reversal amount',()=>{
  const sim=new Iso8583AcquirerSimulator();send(sim,'0100');
  assert.throws(()=>send(sim,'0100',fields('123456','000000020000')),/reused/);
  assert.throws(()=>send(sim,'0400',fields('123456','000000020000')),/amount mismatch/);
});
test('custom profile changes default decision',()=>{
  const sim=new Iso8583AcquirerSimulator({...SIMULATOR_PROFILE,name:'acquirer-test',defaultDecision:'decline',declineCode:'51'});
  assert.equal(send(sim,'0100').fields[39],'51');
});
