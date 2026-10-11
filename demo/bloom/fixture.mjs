import { deflateSync } from 'node:zlib';
function crc(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;}
function chunk(type,data){const label=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);label.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([label,data])),out.length-4);return out;}
// Valid 16×16 PNG, padded with a valid metadata chunk to exercise byte limits.
export function photo(bytes){
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(16,0);ihdr.writeUInt32BE(16,4);ihdr[8]=8;ihdr[9]=2;
  const pixels=Buffer.alloc(16*(1+16*3),140);for(let y=0;y<16;y++)pixels[y*49]=0;
  const parts=[Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))];
  const basic=Buffer.concat(parts),padding=bytes-basic.length-12;if(padding<5)throw new Error('Fixture too small');
  const text=Buffer.alloc(padding,32);Buffer.from('demo\0').copy(text);
  return Buffer.concat([parts[0],parts[1],chunk('tEXt',text),parts[2],parts[3]]);
}
