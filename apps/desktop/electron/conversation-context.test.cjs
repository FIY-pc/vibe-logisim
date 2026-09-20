'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../circuit-lens/studio/domain/circuit-plugin.json');
const {splitContext, keptObservationContext, materialContext} = require('./conversation-context.cjs');

test('model binding keeps plugin identity and all circuit facts without copying tool descriptions', () => {
  const capabilities = catalog.tools.filter(tool => tool.exposure === 'direct').map(tool =>
    Object.fromEntries(['name', 'description', 'category', 'sourceMutation', 'candidate', 'owner']
      .map(key => [key, tool[key]])));
  const context = {
    schema:'vibe-logisim.agent-context/v0', plugin:{...catalog, capabilities},
    authority:'exact-runtime', projectId:'project-1', revisionId:'revision-2', selectionId:'selection-3',
    summary:'选中的引脚 🙂', circuit:'Control', source:{mode:'file', name:'电路.circ'},
    selection:{rectangle:{x:10, y:20, width:30, height:40}, componentIds:['pin-1'],
      netIds:['net-1'], wireIds:['wire-1'], intent:'inspect', reference:'circuit://selection/3',
      wires:[{wireId:'wire-1', from:{x:10,y:20}, to:{x:40,y:20}}]},
    query:{kind:'component', ids:['pin-1'], observationProfileId:'profile-1'},
    diskIssue:{kind:'changed'}, projectHistory:[{revisionId:'revision-1'}],
    evidence:{components:[{componentId:'pin-1', label:'数据', width:4}]},
    displayedSimulation:{id:'observed-1', sessionId:'simulation-1', ticks:7, revisionId:'revision-2',
      circuit:'Control', rootCircuit:'Top', instancePath:[{componentId:'instance-B'}],
      components:[{componentId:'pin-1', ports:[{index:0, bits:'xE01', value:null}]}]},
    objectReferences:[{componentId:'pin-1', url:'circuit://object?componentId=pin-1'}],
    keptMoments:[{id:'kept-1', projectId:'project-1', title:'较早观察', revisionId:'revision-1',
      circuit:'Control', rootCircuit:'Top', ticks:2, sessionId:'simulation-0',
      signals:[{componentId:'pin-1', label:'数据', portIndex:0, bits:'xxxx', width:4, value:null}]}],
    materials:[{id:'notes', name:'讲义.md', path:'讲义.md', sha256:'material-hash', page:2,
      quote:'引用原文', reference:'workspace://file?path=notes.md'}],
  };
  const original = structuredClone(context);
  const {binding, untrustedEvidence} = splitContext(context);
  const {schema, id, version, workflow} = catalog;
  assert.deepEqual(binding, {
    schema:context.schema, plugin:{schema, id, version, workflow}, authority:context.authority,
    projectId:context.projectId, revisionId:context.revisionId, selectionId:context.selectionId,
    summary:context.summary, selection:{rectangle:context.selection.rectangle, componentIds:['pin-1'],
      netIds:['net-1'], wireIds:['wire-1'], intent:'inspect'}, query:context.query,
    observationId:'observed-1', keptObservationRefs:[{id:'kept-1', title:'较早观察', revisionId:'revision-1'}],
  });
  assert.deepEqual(untrustedEvidence, {
    circuit:context.circuit, source:context.source, diskIssue:context.diskIssue,
    projectHistory:context.projectHistory, reference:context.selection.reference,
    selectedWires:context.selection.wires, evidence:context.evidence,
    displayedSimulation:context.displayedSimulation, objectReferences:context.objectReferences,
  });
  const kept = keptObservationContext(context);
  assert.equal(kept['vibe-logisim.kept-observation-1'].kind, 'untrusted');
  assert.deepEqual(JSON.parse(kept['vibe-logisim.kept-observation-1'].value), {
    id:'kept-1', projectId:'project-1', title:'较早观察', revisionId:'revision-1', circuit:'Control',
    rootCircuit:'Top', ticks:2, sessionId:'simulation-0',
    columns:['componentId','label','portIndex','bits','width','value'],
    signals:[['pin-1','数据',0,'xxxx',4,null]],
    readMore:'read_kept_observation returns this exact moment, including other component ports and its instance path',
  });
  const materials = materialContext(context);
  assert.equal(materials['vibe-logisim.material-1'].kind, 'untrusted');
  assert.deepEqual(JSON.parse(materials['vibe-logisim.material-1'].value), context.materials[0]);
  const projected = JSON.stringify({binding, untrustedEvidence, kept, materials});
  for (const {description} of capabilities) {
    assert.ok(!projected.includes(JSON.stringify(description).slice(1,-1)), 'do not relocate tool prose');
  }
  assert.deepEqual(context, original, 'raw context, including the complete UI plugin manifest, stays unchanged');
  assert.equal(splitContext({}).binding.plugin, null);
});
