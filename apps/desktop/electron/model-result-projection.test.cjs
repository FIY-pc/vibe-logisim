'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {projectModelResult,MODEL_OUTPUT_SCHEMA} = require('./model-result-projection.cjs');
const {dynamicToolResponse,splitModelContent} = require('./model-tool-output.cjs');
const {verifyResult,restore,read,freeze} = require('../../../experiments/010-model-efficiency/verify.cjs');
const results = path.resolve(__dirname,'../../../experiments/010-model-efficiency/results');
const corpus = JSON.parse(fs.readFileSync(path.join(results,'responses.json'),'utf8'));
const sample = name => structuredClone(corpus.find(record=>record.name===name).raw);
const set = (object,pointer,value) => {
  const keys=pointer.slice(1).split('/'),key=keys.pop();
  for(const part of keys)object=object[part];
  object[key]=value;
};

test('real 009 production responses recover every original field, including host submit', () => {
  for(const {name,raw} of corpus) {
    const model=verifyResult(raw);
    if(name.startsWith('inspect')) assert.deepEqual(model,raw,'unproven electrical duplicates stay');
    else assert.equal(model.modelProjection.schema,MODEL_OUTPUT_SCHEMA,name);
  }
});

test('a single differing field defeats an alias; identical IDs do not establish equality', () => {
  for(const {raw} of corpus) {
    const projected=projectModelResult(raw);
    for(const destination of Object.keys(projected.modelProjection?.aliases||{})) {
      const altered=structuredClone(raw),previous=read(raw,destination);
      const value=typeof previous==='object' ? {...previous,unrecognizedFutureField:'keep me'} : 'a different value';
      set(altered,destination,value);
      const model=verifyResult(altered);
      assert.deepEqual(read(model,destination),value,destination);
    }
  }
  const trace=sample('trace-module');
  trace.runtimeProfile.status='configured-not-observed';
  trace.runtimeProfile.reportedVersion=null;
  const model=verifyResult(trace);
  assert.deepEqual(model.runtimeProfile,trace.runtimeProfile,'same profile ID, different observed state');
  assert.equal(model.binding.runtimeProfile.status,'observed');
});

test('unknowns, new fields, failed expectations and large observations remain verbatim', () => {
  const raw=sample('evaluate-unknown');
  raw.future={bytes:'x'.repeat(20000),value:null};
  raw.result.rows=Array.from({length:10000},(_,tick)=>({tick,oscillating:false,values:{Q:null},bits:{Q:'x0E1'}}));
  raw.binding.future={triState:'unknown',nullable:null};
  raw.result.binding=structuredClone(raw.binding);
  const model=verifyResult(raw);
  assert.equal(model.result.rows.length,10000);
  assert.equal(model.evaluation.status,'unknown');
  assert.deepEqual(model.future,raw.future);
  assert.deepEqual(model.binding.future,raw.binding.future);
  const failed=sample('evaluate-failure');
  assert.equal(verifyResult(failed).feedback.status,'failed');
  assert.deepEqual(projectModelResult(failed).feedback.firstFailure,failed.feedback.firstFailure);
});

test('unrecognized schemas/tools, errors, reserved-field collisions and no saving pass through', () => {
  for(const update of [
    {schema:'vibe-logisim.circuit-plugin.result/v99'},
    {invocation:{tool:'future_tool'}},
    {modelProjection:{schema:'user-data',aliases:null}},
  ]) {
    const value={...sample('trace-module'),...update}; freeze(value);
    assert.equal(projectModelResult(value),value);
  }
  const error=JSON.parse(fs.readFileSync(path.join(results,'error.json'),'utf8'));
  const value={...sample('trace-module'),...error};
  assert.equal(projectModelResult(freeze(value)),value);
  assert.deepEqual(projectModelResult(freeze(error)),error);
  // Even long null-like/false/error details do not get normalized or sampled.
  const details={error:{code:'FAILED',retryable:false,hint:'修正输入',context:{details:'x'.repeat(20000),unknown:null}}};
  assert.deepEqual(projectModelResult(freeze(details)),details);
  const short={schema:'vibe-logisim.circuit-plugin.result/v1',invocation:{tool:'trace_circuit'},binding:{circuit:'Q'},circuit:'Q'};
  assert.equal(projectModelResult(short),short,'no fixed metadata tax for a small response');
});

test('null metadata stays null and missing stays missing; differing host save state is kept', () => {
  const raw=sample('trace-module');
  raw.runtimeProfile=null;
  raw.binding.runtimeProfile=null;
  delete raw.artifactSha256;
  const model=verifyResult(raw);
  assert.equal(model.runtimeProfile,null);
  assert.equal(Object.hasOwn(model,'artifactSha256'),false);
  const host=sample('submit');
  host.workspace.savedRevisionId='previous-revision';
  host.workspace.dirty=true;
  host.sourceStatus.currentSha256='changed-on-disk';
  host.capabilities.profile.reportedVersion='different runtime';
  const projected=verifyResult(host);
  assert.equal(projected.workspace.savedRevisionId,'previous-revision');
  assert.equal(projected.workspace.dirty,true);
  assert.equal(projected.sourceStatus.currentSha256,'changed-on-disk');
  assert.equal(projected.capabilities.profile.reportedVersion,'different runtime');
});

test('only dynamic model text is projected; real native PNG is byte-for-byte unchanged', () => {
  const raw=sample('render-module');
  const png=fs.readFileSync(path.join(results,'render-module-0.png')).toString('base64');
  raw.modelContentItems=[{type:'inputImage',mimeType:'image/png',imageData:png}];
  const model=verifyResult(raw);
  const publicResult=splitModelContent(raw).publicResult;
  assert.equal(publicResult.modelProjection,undefined);
  assert.equal(publicResult.result.artifactSha256,raw.result.artifactSha256);
  const response=dynamicToolResponse(raw);
  assert.equal(response.contentItems.length,2);
  assert.equal(response.contentItems[1].imageUrl,'data:image/png;base64,'+png);
  assert.equal(response.contentItems[0].text.includes(png),false);
  assert.deepEqual(restore(model),publicResult);
  assert.throws(()=>dynamicToolResponse({...raw,modelContentItems:[{type:'inputImage',mimeType:'image/png',imageData:'not-a-png'}]}),/编码无效|格式无效/);
});
