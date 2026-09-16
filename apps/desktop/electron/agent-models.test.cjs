'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AgentModels}=require('./agent-models.cjs');

test('selection survives reopening, is validated by catalog, and inherits without modifying provider config',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-models-')),preferencesPath=root+'/selection.json',requests=[];
 const request=async(method,params)=>{requests.push({method,params});return params.cursor
  ? {data:[{model:'second',displayName:'Second',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}],nextCursor:null}
  : {data:[{model:'first',displayName:'First',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}],nextCursor:'page-2'};};
 const settings=new AgentModels({request,preferencesPath});
 const selection=await settings.validate({model:'second',effort:'high'});settings.save(selection);
 assert.equal(requests.length,2);assert.ok(requests.every(r=>r.method==='model/list'));
 const reopened=new AgentModels({request,preferencesPath});assert.deepEqual(reopened.selection,selection);
 await assert.rejects(()=>settings.validate({model:'second',effort:'ultra'}),/不支持/);
 await assert.rejects(()=>settings.validate({model:'made-up',effort:'low'}),/目录/);
 assert.deepEqual(new AgentModels({request,preferencesPath}).selection,selection);
 settings.save(await settings.validate(null));assert.equal(new AgentModels({request,preferencesPath}).selection,null);
 assert.deepEqual(fs.readdirSync(root),['selection.json']);
});

test('reconnected model catalog cannot be overwritten by an old connection response',async()=>{
 let release, calls=0;
 const settings=new AgentModels({preferencesPath:null,request:()=>++calls===1 ? new Promise(resolve=>release=resolve) : Promise.resolve({data:[{model:'new',supportedReasoningEfforts:[]}],nextCursor:null})});
 const old=settings.list();settings.invalidate();
 await settings.list();release({data:[{model:'old',supportedReasoningEfforts:[]}],nextCursor:null});await old;
 assert.equal((await settings.list())[0].model,'new');
});
