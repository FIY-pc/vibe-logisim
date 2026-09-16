import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConversationDraft} from '../circuit-lens/web/core/conversation-draft.js';

test('a delayed send clears only the submitted edits, including when the same reference was re-added',()=>{
  const d=new ConversationDraft(),ref={id:'material-a',name:'任务书',page:3,quote:'停顿时保留'};
  d.text('原问题');d.references('materials',[ref]);d.references('moments',[{id:'moment-a'}]);
  const receipt=d.snapshot();
  d.text('下一条');d.references('materials',[]);d.references('materials',[ref]);
  d.references('moments',[{id:'moment-a'},{id:'moment-b'}]);d.acknowledge(receipt);
  assert.equal(d.value.text,'下一条');assert.equal(d.value.materials.length,1);
  assert.deepEqual(d.value.moments.map(m=>m.id),['moment-b']);
});
test('unchanged text is consumed while a newly added attachment remains',()=>{
  const d=new ConversationDraft();d.text('原问题');const receipt=d.snapshot();
  d.references('moments',[{id:'moment-b'}]);d.acknowledge(receipt);
  assert.equal(d.value.text,'');assert.equal(d.value.moments.length,1);
});
test('editing back to identical words is still a new user edit',()=>{
  const d=new ConversationDraft();d.text('原问题');const receipt=d.snapshot();
  d.text('');d.text('原问题');d.acknowledge(receipt);assert.equal(d.value.text,'原问题');
});
