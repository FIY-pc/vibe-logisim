'use strict';

const assert = require('node:assert/strict');
const {dynamicToolResponse, splitModelContent, describeCodeModeResult, CODE_MODE_RESULT_CONTRACT} = require('./model-tool-output.cjs');

const tool = {type:'function', name:'fixture_tool', description:'Fixture tool description', inputSchema:{type:'object'}};
assert.deepEqual(describeCodeModeResult(tool), tool, 'shared result transport is not repeated in each tool');
assert.ok(CODE_MODE_RESULT_CONTRACT.includes('JSON.parse(result)'));

const png = Buffer.from('\x89PNG\r\n\x1a\n' + 'model-observation', 'binary').toString('base64');
const result = {
  schema: 'vibe-logisim.circuit-plugin.result/v1',
  result: {kind: 'full', pixelWidth: 100, pixelHeight: 50},
  modelContentItems: [{type: 'inputImage', mimeType: 'image/png', imageData: png}],
};
const output = dynamicToolResponse(result);
assert.equal(output.success, true);
assert.equal(output.contentItems[0].type, 'inputText');
assert.equal(output.contentItems[1].type, 'inputImage');
assert.match(output.contentItems[1].imageUrl, /^data:image\/png;base64,/);
assert.equal(output.contentItems[0].text.includes(png), false, 'binary data must not be duplicated in text JSON');
assert.equal(splitModelContent(result).publicResult.modelContentItems, undefined);
assert.throws(() => dynamicToolResponse({modelContentItems: [{type: 'inputImage', mimeType: 'image/png', imageData: 'not-base64'}]}), /编码无效/);
assert.throws(() => dynamicToolResponse({modelContentItems: [{type: 'inputImage', mimeType: 'image/jpeg', imageData: png}]}), /内容项无效/);
console.log('model tool output checks passed');
