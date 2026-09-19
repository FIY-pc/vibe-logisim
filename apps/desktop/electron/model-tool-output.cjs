'use strict';

// The Codex app-server accepts Responses-compatible output content items from
// dynamic tools. Domain executors may attach bounded binary observations here;
// this adapter keeps them out of the text JSON and never exposes host paths.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const {projectModelResult} = require('./model-result-projection.cjs');

function splitModelContent(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('电路工具结果必须为对象');
  }
  const items = result.modelContentItems;
  const publicResult = {...result};
  delete publicResult.modelContentItems;
  if (items === undefined) return {publicResult, modelContentItems: []};
  if (!Array.isArray(items) || items.length > 4) throw new Error('模型内容项无效或超过上限');
  const modelContentItems = items.map((item) => {
    if (!item || item.type !== 'inputImage' || item.mimeType !== 'image/png' ||
        typeof item.imageData !== 'string' || !item.imageData ||
        item.imageData.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 16) {
      throw new Error('模型图像内容项无效');
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(item.imageData)) throw new Error('模型图像编码无效');
    const data = Buffer.from(item.imageData, 'base64');
    if (data.length > MAX_IMAGE_BYTES || !data.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'binary'))) {
      throw new Error('模型图像大小或格式无效');
    }
    return {type: 'inputImage', mimeType: item.mimeType, imageData: item.imageData};
  });
  return {publicResult, modelContentItems};
}

function dynamicToolResponse(result) {
  const {publicResult, modelContentItems} = splitModelContent(result);
  return {
    contentItems: [
      {type: 'inputText', text: JSON.stringify(projectModelResult(publicResult))},
      ...modelContentItems.map(item => ({
        type: 'inputImage',
        imageUrl: `data:${item.mimeType};base64,${item.imageData}`,
      })),
    ],
    success: true,
  };
}

// Opt-in evaluation sees only the shape of the native model-facing output.
// Never forward raw response text, code, data URLs or image bytes to telemetry.
function modelMediaEvidence(item) {
  if (!item || !['custom_tool_call_output', 'function_call_output'].includes(item.type)) return null;
  const content = Array.isArray(item.output) ? item.output : [{type:'input_text',text:item.output}];
  const textItems = content.filter(part => part.type === 'input_text' && typeof part.text === 'string');
  return {
    callId: item.call_id || null,
    itemType: item.type,
    imageItems: content.filter(part => part.type === 'input_image').length,
    textChars: textItems.reduce((sum, part) => sum + part.text.length, 0),
    base64TextItems: textItems.filter(part => /data:image\/[^;\s]+;base64,/.test(part.text)).length,
  };
}

module.exports = {MAX_IMAGE_BYTES, splitModelContent, dynamicToolResponse, modelMediaEvidence};
