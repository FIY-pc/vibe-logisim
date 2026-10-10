'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ModelCatalog,normalize,providerFor,URL}=require('./model-catalog.cjs');
const {toolActivity}=require('./tool-activity.cjs');
const provider={id:'service-a',baseUrl:'https://api.deepseek.com/v1',api:'openai-completions',apiKey:'never-in-metadata',model:'private-model',models:['private-model'],effort:'none'};
const feed={deepseek:{models:{'sample-model':{id:'sample-model',name:'Sample',limit:{context:128000},modalities:{input:['text','image']},reasoning:true,tool_call:true,reasoning_options:[{type:'effort',values:['low','high','max']}],baseUrl:'https://malicious.invalid',headers:{authorization:'bad'}}}}};
function fixture(t,options={}){const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-catalog-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return new ModelCatalog({profileDir:root,...options});}
test('remote metadata only enriches exact provider/model pairs; never changes inventory or transports',async t=>{
 const requests=[];const c=fixture(t,{fetchMetadata:async()=>(async(url,options)=>{requests.push({url,options});return Response.json(feed);})});
 await c.refreshMetadata(true);
 assert.equal(requests[0].url,URL);assert.deepEqual(requests[0].options.headers,{Accept:'application/json'});
 assert.deepEqual(c.rows(provider).map(m=>m.model),['private-model']);
 const config={...provider,model:'sample-model',models:['sample-model']};const row=c.rows(config)[0];
 assert.equal(row.name,'Sample');assert.equal(row.metadata.vision,true);assert.deepEqual(row.efforts.map(x=>x.value),['none','low','high','max']);
 assert.equal(c.rows({...config,baseUrl:'https://relay.invalid/v1'})[0].metadata,null);
 assert.equal(c.rows({...config,baseUrl:'https://api.deepseek.com/unrelated'})[0].metadata,null);
 assert.equal(c.metadataFor(config,'toString'),null);
 assert.equal(providerFor({...config,baseUrl:'https://api.deepseek.com.evil.invalid/v1'}),null);
 const saved=fs.readFileSync(c.file,'utf8');assert.ok(!saved.includes('malicious'));assert.ok(!saved.includes('never-in-metadata'));assert.ok(!saved.includes('authorization'));
});
test('opening catalog is synchronous; concurrent refresh coalesces and offline/corrupt refresh retains last good data',async t=>{
 let finish,calls=0;const gate=new Promise(r=>finish=r);
 const c=fixture(t,{fetchMetadata:async()=>async()=>{calls++;await gate;return Response.json(feed);}});
 const first=c.refreshMetadata(true),second=c.refreshMetadata(true);
 assert.equal(c.rows(provider)[0].model,'private-model');finish();await Promise.all([first,second]);assert.equal(calls,1);
 c.fetchMetadata=async()=>async()=>Response.json({oops:true});await c.refreshMetadata(true);
 assert.equal(c.metadataFor(provider,'sample-model').name,'Sample');assert.match(c.error,/仍使用/);
 const restored=new ModelCatalog({profileDir:c.profileDir});assert.equal(restored.metadataFor(provider,'sample-model').name,'Sample');
 fs.writeFileSync(c.file,'broken');const fallback=new ModelCatalog({profileDir:c.profileDir});assert.ok(Object.keys(fallback.metadata).length>0);assert.equal(fallback.rows(provider)[0].metadata,null);
 assert.throws(()=>normalize({models:[]}),/没有可识别/);
});
test('missing effort metadata preserves manual controls without claiming model capabilities',async t=>{
 const c=fixture(t,{fetchMetadata:async()=>async()=>Response.json({deepseek:{models:{
  ...feed.deepseek.models,
  'budget-model':{id:'budget-model',name:'Budget',reasoning:true,reasoning_options:[{type:'budget_tokens',min:1024}]},
  'plain-model':{id:'plain-model',name:'Plain',reasoning:false},
 }}})});
 await c.refreshMetadata(true);
 const values=row=>row.efforts.map(x=>x.value),manual=['none','low','medium','high','xhigh','max'];
 const unknown=c.rows({...provider,baseUrl:'https://relay.invalid/v1'})[0];
 assert.equal(unknown.metadata,null);assert.deepEqual(values(unknown),manual);assert.equal(unknown.defaultEffort,'none');
 assert.deepEqual(values(c.rows(provider)[0]),manual,'missing model on a known provider is also unknown');
 const budget=c.rows({...provider,model:'budget-model'})[0];
 assert.deepEqual(values(budget),manual);assert.deepEqual(budget.metadata.efforts,[],'manual controls are not catalog claims');
 assert.deepEqual(values(c.rows({...provider,api:'anthropic-messages',model:'budget-model'})[0]),['none','low','medium','high'],'known budget-only models do not claim extra effort levels');
 const plain={...provider,model:'plain-model'};
 assert.deepEqual(values(c.rows(plain)[0]),['none']);
 assert.deepEqual(values(c.rows(plain,{...plain,effort:'high'})[0]),['none','high'],'retain a saved override');
 const configured={...provider,baseUrl:'https://relay.invalid/v1',models:['private-model','another-model'],effort:'high'};
 assert.equal(c.rows(configured)[1].defaultEffort,'high','switching unknown models keeps the configured choice');
 assert.deepEqual(values(c.rows({...provider,model:'sample-model'})[0]),['none','low','high','max'],'explicit catalog levels still narrow the menu');
});
test('a legacy cache that removed extended levels cannot replace the updated bundled catalog',t=>{
 const c=fixture(t),config={...provider,baseUrl:'https://api.openai.com/v1',model:'gpt-6-astra',models:['gpt-6-astra']};
 fs.writeFileSync(c.file,JSON.stringify({version:1,updatedAt:Date.now(),providers:{openai:{models:{'gpt-6-astra':{id:'gpt-6-astra',name:'Old cache',reasoning:true,reasoning_options:[{type:'effort',values:['low','medium','high']}]}}}}}));
 const restored=new ModelCatalog({profileDir:c.profileDir});
 assert.deepEqual(restored.rows(config)[0].efforts.map(x=>x.value),['none','low','medium','high','xhigh','max']);
 assert.notEqual(restored.rows(config)[0].name,'Old cache');
});
test('discovered IDs and cached failures are scoped to credentials; explicit models survive empty inventory',async t=>{
 let mode='models',calls=0;const c=fixture(t,{fetchProvider:async()=>async()=>{calls++;if(mode==='error')throw new Error('offline');return Response.json({data:mode==='empty'?[]:[{id:'new-model'}]});}});
 const custom={...provider,baseUrl:'https://relay.invalid/v1'};
 await Promise.all([c.refresh(custom),c.refresh(custom)]);assert.equal(calls,1);
 assert.deepEqual(c.rows(custom).map(m=>m.model),['private-model','new-model']);
 mode='error';await c.refresh(custom);assert.equal(c.rows(custom).length,2);assert.match(c.status(custom).error,/offline/);
 assert.equal(c.rows({...custom,apiKey:'rotated'}).length,1);
 const reopened=new ModelCatalog({profileDir:c.profileDir});assert.equal(reopened.rows(custom).length,2);
 mode='empty';await c.refresh(custom);assert.deepEqual(c.rows(custom).map(m=>m.model),['private-model']);
});
test('tool partial updates retain input, nonzero exits are failures, and output truncation is explicit',()=>{
 const start=toolActivity({type:'tool_execution_start',toolName:'exec_command',args:{command:'node check.cjs'}});
 const update=toolActivity({type:'tool_execution_update',toolName:'exec_command',partialResult:{content:[{type:'text',text:'checking'}]}},start);
 assert.equal(update.status,'running');assert.equal(update.toolOutput.target,'node check.cjs');assert.equal(update.toolOutput.text,'checking');
 const done=toolActivity({type:'tool_execution_end',toolName:'exec_command',result:{content:[{type:'text',text:'{"exitCode":1,"stderr":"invalid input"}'}]}},update);
 assert.equal(done.status,'failed');assert.equal(done.toolOutput.exitCode,1);
 const long=toolActivity({type:'tool_execution_end',toolName:'read_file',result:{content:[{type:'text',text:'a'.repeat(7000)}]}},start);
 assert.equal(long.toolOutput.text.length,6000);assert.equal(long.toolOutput.truncated,true);
 const file=toolActivity({type:'tool_execution_end',toolName:'read_file',result:{content:[{type:'text',text:'{"error":"example","exitCode":1}'}]}},start);
 assert.equal(file.status,'completed','file contents are not a tool failure envelope');
});
test('a service that stalls after headers cannot leave refresh running indefinitely',async t=>{
 const http=require('node:http');const server=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{"data":[');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const c=fixture(t,{timeoutMs:80}),config={...provider,baseUrl:`http://127.0.0.1:${server.address().port}`};
 await c.refresh(config);assert.equal(c.status(config).status,'ready');assert.ok(c.status(config).error);assert.equal(c.rows(config)[0].model,'private-model');
});
