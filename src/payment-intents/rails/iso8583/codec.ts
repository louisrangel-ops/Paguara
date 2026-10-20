/**
 * ISO 8583 ASCII test-profile codec. NOT a network/acquirer-certified packager.
 * Strictly supports fixed ASCII fields and LLVAR ASCII fields from the declared profile.
 * Never log raw buffers containing PAN or authentication data.
 */
export type IsoFields = Record<number, string>;
export interface FieldSpec { length: number; variable?: boolean; numeric?: boolean }
export type IsoProfile = Record<number, FieldSpec>;
export const TEST_PROFILE: IsoProfile = {
  2: {length:19,variable:true,numeric:true}, 3:{length:6,numeric:true},
  4:{length:12,numeric:true},7:{length:10,numeric:true},
  11:{length:6,numeric:true},12:{length:6,numeric:true},
  13:{length:4,numeric:true},14:{length:4,numeric:true},
  18:{length:4,numeric:true},22:{length:3,numeric:true},
  25:{length:2,numeric:true},32:{length:11,variable:true,numeric:true},
  37:{length:12},38:{length:6},39:{length:2},41:{length:8},
  42:{length:15},49:{length:3,numeric:true}
};
export function encodeIso(mti:string, fields:IsoFields, profile:IsoProfile=TEST_PROFILE):Buffer {
  if(!/^\d{4}$/.test(mti)) throw new Error('invalid MTI');
  const keys=Object.keys(fields).map(Number).sort((a,b)=>a-b);
  if(keys.some(k=>!Number.isInteger(k)||k<2||k>128||!profile[k])) throw new Error('unsupported field');
  const bits=Buffer.alloc(keys.some(k=>k>64)?16:8);
  if(bits.length===16) bits[0]|=0x80;
  const parts:string[]=[];
  for(const k of keys){
    const spec=profile[k], value=fields[k];
    if(!/^[\x20-\x7e]*$/.test(value)||value.length>(spec.length)||(!spec.variable&&value.length!==spec.length)) throw new Error('invalid field length or encoding: '+k);
    if(spec.numeric&&!/^\d+$/.test(value)) throw new Error('invalid numeric field: '+k);
    const index=k-1;bits[Math.floor(index/8)]|=1<<(7-index%8);
    parts.push((spec.variable?String(value.length).padStart(2,'0'):'')+value);
  }
  return Buffer.concat([Buffer.from(mti,'ascii'),bits,Buffer.from(parts.join(''),'ascii')]);
}
export function decodeIso(data:Buffer,profile:IsoProfile=TEST_PROFILE):{mti:string;fields:IsoFields}{
  if(data.length<12) throw new Error('short ISO message');
  const mti=data.subarray(0,4).toString('ascii');
  if(!/^\d{4}$/.test(mti)) throw new Error('invalid MTI');
  const secondary=(data[4]&0x80)!==0, bitmapSize=secondary?16:8;
  if(data.length<4+bitmapSize) throw new Error('short bitmap');
  const bitmap=data.subarray(4,4+bitmapSize);let offset=4+bitmapSize;
  const fields:IsoFields={};
  for(let k=2;k<=bitmapSize*8;k++){
    const index=k-1;if(!(bitmap[Math.floor(index/8)]&(1<<(7-index%8)))) continue;
    const spec=profile[k];if(!spec) throw new Error('unsupported field: '+k);
    let len=spec.length;
    if(spec.variable){
      if(offset+2>data.length) throw new Error('truncated LLVAR');
      const prefix=data.subarray(offset,offset+2).toString('ascii');
      if(!/^\d{2}$/.test(prefix)) throw new Error('invalid LLVAR prefix');
      len=Number(prefix);offset+=2;if(len>spec.length) throw new Error('LLVAR too long');
    }
    if(offset+len>data.length) throw new Error('truncated field: '+k);
    const value=data.subarray(offset,offset+len).toString('ascii');offset+=len;
    if(!/^[\x20-\x7e]*$/.test(value)||spec.numeric&&!/^\d+$/.test(value)) throw new Error('invalid field: '+k);
    fields[k]=value;
  }
  if(offset!==data.length) throw new Error('unexpected trailing bytes');
  return {mti,fields};
}
