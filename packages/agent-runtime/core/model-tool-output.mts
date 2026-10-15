// The Codex app-server accepts Responses-compatible output content items from
// dynamic tools. Domain executors may attach bounded binary observations here;
// this adapter keeps them out of the text JSON and never exposes host paths.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// DynamicToolSpec has no return schema. Codex Code Mode joins content items
// into a string, even for a JSON-only response. The shared transport rule is
// sent once in agent-instructions.mts; do not repeat it for every tool.
const CODE_MODE_RESULT_CONTRACT =
  "Code Mode return type: string. Parse JSON text with JSON.parse(result) before reading fields. Image-bearing results use the image delivery format described by the tool.";

// app-server 0.154.0 DynamicToolSpec: a function entry must carry its type.
function dynamicToolSpec(tool: {
  name: string;
  description: string;
  inputSchema: unknown;
}) {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function splitModelContent(result: any) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError("电路工具结果必须为对象");
  }
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
    ) {
      throw new Error("模型图像内容项无效");
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(item.imageData))
      throw new Error("模型图像编码无效");
    const data = Buffer.from(item.imageData, "base64");
    if (
      data.length > MAX_IMAGE_BYTES ||
      !data.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "binary"))
    ) {
      throw new Error("模型图像大小或格式无效");
    }
    return {
      type: "inputImage",
      mimeType: item.mimeType,
      imageData: item.imageData,
    };
  });
  return { publicResult, modelContentItems };
}

function dynamicToolResponse(result: any) {
  const { publicResult, modelContentItems } = splitModelContent(result);
  return {
    contentItems: [
      { type: "inputText", text: JSON.stringify(publicResult) },
      ...modelContentItems.map((item: any) => ({
        type: "inputImage",
        imageUrl: `data:${item.mimeType};base64,${item.imageData}`,
      })),
    ],
    success: true,
  };
}

// A failed call answers in the same content-item form; the payload is the
// structured tool error the model reads to decide whether to retry.
function dynamicToolError(payload: unknown) {
  return {
    contentItems: [
      { type: "inputText", text: JSON.stringify({ error: payload }) },
    ],
    success: false,
  };
}

// Opt-in evaluation sees only the shape of the native model-facing output.
// Never forward raw response text, code, data URLs or image bytes to telemetry.
function modelMediaEvidence(item: any) {
  if (
    !item ||
    !["custom_tool_call_output", "function_call_output"].includes(item.type)
  )
    return null;
  const content = Array.isArray(item.output)
    ? item.output
    : [{ type: "input_text", text: item.output }];
  const textItems = content.filter(
    (part: any) => part.type === "input_text" && typeof part.text === "string",
  );
  return {
    callId: item.call_id || null,
    itemType: item.type,
    imageItems: content.filter((part: any) => part.type === "input_image")
      .length,
    textChars: textItems.reduce(
      (sum: number, part: any) => sum + part.text.length,
      0,
    ),
    base64TextItems: textItems.filter((part: any) =>
      /data:image\/[^;\s]+;base64,/.test(part.text),
    ).length,
  };
}

export {
  MAX_IMAGE_BYTES,
  splitModelContent,
  dynamicToolResponse,
  dynamicToolError,
  dynamicToolSpec,
  modelMediaEvidence,
  CODE_MODE_RESULT_CONTRACT,
};
