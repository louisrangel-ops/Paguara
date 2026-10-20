import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeIso,decodeIso } from '../../src/payment-intents/rails/iso8583/codec';
test('ISO 8583 ASCII test profile round trip',()=>{
 const fields={3:'000000',4:'000000015000',7:'1020163000',11:'123456',22:'090',37:'629312123456',41:'ECOM0001',42:'MERCHANT0000001',49:'840'};
 const raw=encodeIso('0100',fields);
 assert.deepEqual(decodeIso(raw),{mti:'0100',fields});
});
test('rejects unsupported fields',()=>assert.throws(()=>encodeIso('0100',{55:'DATA'})));
test('rejects malformed or truncated messages',()=>assert.throws(()=>decodeIso(Buffer.from('0100'))));
test('rejects invalid numeric field',()=>assert.throws(()=>encodeIso('0100',{4:'000000000ABC'})));
