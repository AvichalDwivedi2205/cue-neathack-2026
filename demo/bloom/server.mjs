import http from 'node:http';
import { MAX_UPLOAD_BYTES } from './limits.mjs';
const server=http.createServer(async(req,res)=>{
  const json=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
  if(req.url==='/health')return json(200,{app:'Bloom',maxUploadBytes:MAX_UPLOAD_BYTES,build:process.env.BLOOM_BUILD||'original'});
  if(req.url!=='/upload'||req.method!=='POST')return json(404,{error:'Not found'});
  const parts=[];let size=0;
  for await(const part of req){size+=part.length;if(size>8*1024*1024)return json(413,{error:'File too large'});parts.push(part);}
  if(size>MAX_UPLOAD_BYTES)return json(413,{error:'File too large',size});
  const body=Buffer.concat(parts),type=req.headers['content-type'];
  const valid=type==='image/png'?body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):type==='image/jpeg'?body[0]===255&&body[1]===216:type==='image/webp'?body.subarray(0,4).toString()==='RIFF'&&body.subarray(8,12).toString()==='WEBP':false;
  if(!valid)return json(415,{error:'Unsupported or invalid image'});
  return json(201,{photo:{id:crypto.randomUUID(),size,uploadedAt:Date.now()}});
});
server.listen(Number(process.env.PORT||0),'127.0.0.1',()=>console.log('BLOOM_URL=http://127.0.0.1:'+server.address().port));
