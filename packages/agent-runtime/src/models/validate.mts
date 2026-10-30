/** Validation of a student-supplied OpenAI-compatible model service. */
import type { ProtocolObject } from "../protocol/types.mts";
import { hasCredential } from "./public-fields.mts";

const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;
const MAX_CATALOG_MODELS = 400;

function normaliseBaseUrl(value: unknown) {
  let url = String(value || "").trim();
  if (!url) throw new Error("请填写接口地址，例如 https://api.deepseek.com/v1");
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("接口地址格式不正确");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error("接口地址不能包含账号、查询参数或锚点");
  // Accept both ".../v1" and ".../v1/", with or without a trailing endpoint.
  parsed.pathname = parsed.pathname
    .replace(/\/+$/, "")
    .replace(/\/(responses|chat\/completions|models)$/, "");
  return parsed.origin + parsed.pathname;
}

// Address + key only: enough to ask the endpoint for its model list. A blank
// key means "keep the one already saved" so students never retype it.
function validateEndpoint(
  settings: ProtocolObject,
  { storedApiKey = null }: any = {},
) {
  const baseUrl = normaliseBaseUrl(settings.baseUrl);
  let apiKey = String(settings.apiKey || "").trim();
  if (!apiKey && storedApiKey) apiKey = storedApiKey;
  if (!apiKey) throw new Error("请填写 API 密钥");
  if (/[\r\n"\\]/.test(apiKey) || apiKey.length > 512)
    throw new Error("API 密钥格式不正确");
  return { baseUrl, apiKey };
}

function validate(settings: ProtocolObject, options: any = {}) {
  const { baseUrl, apiKey } = validateEndpoint(settings, options);
  const model = String(settings.model || "").trim();
  if (!model) throw new Error("请填写或选择模型名称，例如 deepseek-chat");
  if (!MODEL_ID.test(model))
    throw new Error("模型名称只能包含字母、数字和 . _ : / -");
  if ([model, String(settings.name || ""), baseUrl].some((v) => hasCredential(v, apiKey)))
    throw new Error("模型名称、服务名称和地址不能包含 API 密钥；请把密钥只填入 API Key 栏");
  const effort = settings.effort || "medium";
  if (!EFFORTS.includes(effort))
    throw new Error("不支持这个思考深度，请重新选择");
  const name =
    String(settings.name || "")
      .trim()
      .slice(0, 40) || "自定义接口";
  // The context window bounds a turn's transcript. Frontier models behind
  // relays accept 200k+; let the student say what their model has.
  let contextWindow = Number(settings.contextWindow);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0)
    contextWindow = 256000;
  contextWindow = Math.max(32000, Math.min(2000000, Math.round(contextWindow)));
  // The chosen model always leads; the rest is whatever the endpoint listed.
  const models = [model];
  for (const candidate of Array.isArray(settings.models)
    ? settings.models
    : []) {
    const id = String(candidate || "").trim();
    if (id && MODEL_ID.test(id) && !hasCredential(id, apiKey) && !models.includes(id)) models.push(id);
    if (models.length >= MAX_CATALOG_MODELS) break;
  }
  return { baseUrl, apiKey, model, effort, name, contextWindow, models };
}

function maskKey(key: string) {
  if (!key) return "";
  if (key.length <= 8) return "••••";
  return key.slice(0, 4) + "••••" + key.slice(-4);
}

export { normaliseBaseUrl, validateEndpoint, validate, maskKey, EFFORTS };
