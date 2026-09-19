'use strict';
const assert=require('node:assert/strict');
const {itemErrorText}=require('./codex-backend.cjs');

const detail=itemErrorText({
  status:'failed',
  contentItems:[{type:'inputText',text:JSON.stringify({error:{
    code:'UNKNOWN_INPUT',
    message:'找不到输入引脚 Cin。',
    hint:'使用当前 inspect_circuit 返回的 stimulusSchema.label。',
    availableInputs:['A','B'],
  }})}],
});
assert.equal(detail,'找不到输入引脚 Cin。 建议：使用当前 inspect_circuit 返回的 stimulusSchema.label。 可用输入：A、B');
assert.equal(itemErrorText({status:'completed',contentItems:[]}),null);
console.log('codex backend output checks passed');
