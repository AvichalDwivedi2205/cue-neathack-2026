import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {photo} from './fixture.mjs';
const child=spawn(process.execPath,[new URL('./server.mjs',import.meta.url).pathname],{env:{PATH:process.env.PATH,PORT:'0'},stdio:['ignore','pipe','pipe']});
let failed=false;
try{
  const url=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Server startup timeout')),10000);child.stdout.on('data',d=>{const m=String(d).match(/BLOOM_URL=(\S+)/);if(m){clearTimeout(timeout);resolve(m[1]);}});child.on('error',reject);child.on('exit',code=>{if(code)reject(new Error('Server exited '+code));});});
  for(const [bytes,expected,name] of [[1024*1024,201,'1 MB photo'],[2*1024*1024,201,'2 MB photo'],[2*1024*1024+1,201,'Above old boundary'],[3*1024*1024,201,'3 MB photo'],[5*1024*1024,201,'5 MB boundary'],[5*1024*1024+1,413,'Above 5 MB boundary'],[6*1024*1024,413,'6 MB control']]){
    const r=await fetch(url+'/upload',{method:'POST',headers:{'content-type':'image/png'},body:photo(bytes)});console.log(`${name}: HTTP ${r.status} (expected ${expected})`);if(r.status!==expected)failed=true;
  }
  const invalid=await fetch(url+'/upload',{method:'POST',headers:{'content-type':'image/png'},body:Buffer.from('not a photo')});console.log(`Invalid photo: HTTP ${invalid.status} (expected 415)`);if(invalid.status!==415)failed=true;
  assert.equal(failed,false,'One or more independent upload checks failed');console.log('PASS — all 8 independent HTTP regression checks passed');
}finally{child.kill('SIGTERM');}
