/** Images a tool hands to the model travel beside its JSON text, never inside it. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function splitModelContent(result: any) {
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new TypeError("电路工具结果必须为对象");
  const items = result.modelContentItems;
  const publicResult = { ...result };
  delete publicResult.modelContentItems;
  if (items === undefined) return { publicResult, modelContentItems: [] };
  if (!Array.isArray(items) || items.length > 4)
    throw new Error("模型内容项无效或超过上限");
  const modelContentItems = items.map((item: any) => {
    if (
      !item ||
      item.type !== "inputImage" ||
      item.mimeType !== "image/png" ||
      typeof item.imageData !== "string" ||
      !item.imageData ||
      item.imageData.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 16
    )
      throw new Error("模型图像内容项无效");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(item.imageData))
      throw new Error("模型图像编码无效");
    const data = Buffer.from(item.imageData, "base64");
    if (
      data.length > MAX_IMAGE_BYTES ||
      !data.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "binary"))
    )
      throw new Error("模型图像大小或格式无效");
    return {
      type: "inputImage",
      mimeType: item.mimeType,
      imageData: item.imageData,
    };
  });
  return { publicResult, modelContentItems };
}

export { MAX_IMAGE_BYTES, splitModelContent };
