'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
exports.start = async (out, env) => {
  const requests = [];
  const row = {id:'fixture-1',status:'success',name:'fixture',amount:1200,currency:'eur',description:'fixture',created:1800000000,to:['fixture@example.invalid'],subject:'fixture',created_at:'2026-10-20T09:00:00Z',last_event:'delivered',title:'fixture',start:new Date().toISOString().slice(0,10)+'T09:00:00Z',attendees:[{name:'Validador'}],description:'Consulta fixture'};
  const body = {data:[row],available:[{amount:1200,currency:'eur'}],total:1,
    workflowData:{name:'fixture'},deployments:[{uid:'fixture-1',name:'fixture',state:'READY',url:'fixture.vercel.app',createdAt:1800000000000}],
    results:[{object:'page',id:'fixture-1',last_edited_time:'2026-10-20T09:00:00Z',properties:{Name:{type:'title',title:[{plain_text:'fixture'}]}}}]};
  const server = http.createServer((req,res) => {
    requests.push(req.url);
    const error = /^\/(error|stale)\//.test(req.url);
    setTimeout(()=>{res.writeHead(error?503:200,{'Content-Type':'application/json'});res.end(JSON.stringify(error?{}:body));},250);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  env.ABITO_VALIDATE_INTEGRATIONS = `http://127.0.0.1:${server.address().port}`;
  const opener = path.join(out,'xdg-open');
  fs.writeFileSync(opener,'#!/usr/bin/python3\nimport os,sys\nwith open(os.path.join(os.environ["HOME"],"opened-urls"),"a") as f: f.write(sys.argv[1]+"\\n")\n',{mode:0o700});
  return {requests,close:()=>new Promise(resolve=>server.close(resolve))};
};
