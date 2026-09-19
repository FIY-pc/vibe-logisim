'use strict';

const assert = require('node:assert/strict');
const {dynamicToolResponse, splitModelContent} = require('./model-tool-output.cjs');

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
