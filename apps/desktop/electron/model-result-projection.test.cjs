'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {projectModelResult} = require('./model-result-projection.cjs');
const {dynamicToolResponse,splitModelContent} = require('./model-tool-output.cjs');
const {verifyResult,semanticChanges,componentReference,read,freeze} = require('../../../experiments/010-model-efficiency/verify.cjs');
const results = path.resolve(__dirname,'../../../experiments/010-model-efficiency/results');
const corpus = JSON.parse(fs.readFileSync(path.join(results,'responses.json'),'utf8'));
const sample = name => structuredClone(corpus.find(record=>record.name===name).raw);
const set = (object,pointer,value) => {
  const keys=pointer.slice(1).split('/'),key=keys.pop();
  for(const part of keys)object=object[part];
  object[key]=value;
};

test('real 009 production responses preserve all facts in canonical positions, without a decoder', () => {
  for(const {name,raw} of corpus) {
    const model=verifyResult(raw);
    assert.equal(model.modelProjection,undefined,name);
    assert.equal(model.aliases,undefined,name);
    if(name==='inspect-project')assert.deepEqual(model,raw);
    if(name.startsWith('trace') || name.startsWith('evaluate') || name.startsWith('render')) {
      assert.deepEqual(model.binding,raw.binding);
      assert.equal(model.runtimeProfile,undefined);
    }
  }
});

test('one differing field defeats metadata removal; identical IDs do not establish equality', () => {
  for(const {raw} of corpus) {
    const projected=projectModelResult(raw);
    for(const {field:destination,kind} of semanticChanges(raw,projected)) {
      if(kind!=='metadata')continue;
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

test('combined harness observations use the same canonical metadata view', () => {
  const raw = sample('evaluate-unknown');
  raw.invocation.tool = 'harness_run';
  const projected = projectModelResult(raw);

  assert.equal(Object.hasOwn(projected.result, 'binding'), false);
  assert.equal(Object.hasOwn(projected.result, 'run'), false);
  assert.equal(Object.hasOwn(projected.result, 'schema'), false);
  assert.equal(Object.hasOwn(projected.result, 'plugin'), false);
  assert.equal(Object.hasOwn(projected.result, 'runtimeProfile'), false);
  assert.equal(projected.binding.revisionId, raw.binding.revisionId);
  assert.equal(projected.result.rows.length, raw.result.rows.length);
  assert.equal(JSON.stringify(projected).length < JSON.stringify(raw).length, true);
});

test('other envelope tools keep domain details while collapsing exact identity copies', () => {
  for (const tool of ['compare_circuit', 'run_verification']) {
    const raw = sample('evaluate-unknown');
    raw.invocation.tool = tool;
    const projected = projectModelResult(raw);
    assert.equal(Object.hasOwn(projected.result, 'binding'), false, tool);
    assert.equal(projected.binding.artifactSha256, raw.binding.artifactSha256, tool);
    assert.deepEqual(projected.result.evaluation, raw.result.evaluation, tool);
  }
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

test('unrecognized schemas/tools, errors and existing projection fields pass through', () => {
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
  const small=projectModelResult(short);
  assert.equal(Object.hasOwn(small,'circuit'),false);
  assert.equal(small.binding.circuit,'Q');
  assert.equal(small.modelProjection,undefined,'no fixed metadata tax for a small response');
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

test('host save/current/disk state stays explicit even when all values equal the revision', () => {
  for(const name of ['submit','open']) {
    const raw=sample(name),model=verifyResult(raw);
    for(const key of ['currentRevisionId','savedRevisionId']) {
      assert.equal(raw.workspace[key],raw.revision.id);
      assert.ok(Object.hasOwn(model.workspace,key));
      assert.equal(model.workspace[key],raw.workspace[key]);
    }
    assert.equal(raw.sourceStatus.currentSha256,raw.revision.artifactSha256);
    assert.ok(Object.hasOwn(model.sourceStatus,'currentSha256'));
    assert.equal(model.sourceStatus.currentSha256,raw.sourceStatus.currentSha256);
  }
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
  semanticChanges(publicResult,model);
  assert.throws(()=>dynamicToolResponse({...raw,modelContentItems:[{type:'inputImage',mimeType:'image/png',imageData:'not-a-png'}]}),/编码无效|格式无效/);
});

test('all real inspect component references recover through the existing template and IDs', () => {
  for(const name of ['inspect-main','inspect-module']) {
    const raw=sample(name),model=verifyResult(raw);
    assert.equal(model.objectReferenceTemplate,raw.objectReferenceTemplate);
    assert.equal(model.components.length,raw.components.length);
    raw.components.forEach((component,index)=>{
      assert.equal(Object.hasOwn(model.components[index],'reference'),false);
      const recovered=componentReference(model,index);
      assert.equal(recovered,component.reference);
      const actual=new URL(recovered),expected=new URL(component.reference);
      for(const key of ['projectId','revisionId','circuit','componentId'])
        assert.equal(actual.searchParams.get(key),expected.searchParams.get(key));
      assert.equal(actual.searchParams.get('componentId'),model.components[index].componentId);
    });
  }
});

test('reference conflicts and instance/history scopes win over the default template', () => {
  const raw=sample('inspect-main');
  raw.components[0].reference+='&sessionId=earlier&instancePath=%5B%22A%22%5D';
  raw.components[1].reference=raw.components[1].reference.replace('revisionId=','revisionId=other-');
  raw.components[2].reference=raw.components[2].reference.replace('componentId=c','componentId=other-c');
  raw.components[3].reference=null;
  delete raw.components[4].reference;
  const model=verifyResult(raw);
  for(const index of [0,1,2,3]) {
    assert.equal(componentReference(model,index),raw.components[index].reference);
    assert.ok(Object.hasOwn(model.components[index],'reference'));
  }
  assert.equal(Object.hasOwn(model.components[4],'reference'),false,'missing is not synthesized');
  assert.equal(Object.hasOwn(model.components[5],'reference'),false,'other exact references can still collapse');
});

test('ambiguous templates, unsafe IDs, missing templates and future inspect schemas are untouched', () => {
  for(const template of [null,'',undefined,'circuit://object?componentId=OTHER',
    'circuit://object?circuit=COMPONENT_ID&componentId=COMPONENT_ID','file://object?componentId=COMPONENT_ID']) {
    const raw=sample('inspect-main');
    if(template===undefined)delete raw.objectReferenceTemplate;
    else raw.objectReferenceTemplate=template;
    assert.equal(projectModelResult(freeze(raw)),raw);
  }
  for(const componentId of ['a b','a&scope=B','é','$&']) {
    const raw=sample('inspect-main');
    raw.components=[{componentId,reference:raw.objectReferenceTemplate.replace('COMPONENT_ID',componentId)}];
    assert.equal(projectModelResult(freeze(raw)),raw);
  }
  const future={...sample('inspect-main'),schema:'future-inspection/v2'};
  assert.equal(projectModelResult(freeze(future)),future);
  const encoded=sample('inspect-main');
  encoded.objectReferenceTemplate=encoded.objectReferenceTemplate.replace('circuit=main','circuit=%E5%AD%90%E7%94%B5%E8%B7%AF%2F%E4%B8%80');
  encoded.components.forEach(c=>{c.reference=encoded.objectReferenceTemplate.replace('COMPONENT_ID',c.componentId);});
  const model=verifyResult(encoded);
  assert.equal(new URL(componentReference(model,0)).searchParams.get('circuit'),'子电路/一');
});
