"use strict";

// Preflight for a student-supplied OpenAI-compatible endpoint. Two probes:
//
//   discoverModels  GET  {baseUrl}/models      -> list the endpoint offers (or
//                                                 null when it has no such list)
//   testResponses   POST {baseUrl}/responses   -> one tiny streamed turn shaped
//                                                 like the request Codex sends
//
// Both run in the Electron main process before anything is written to the
// profile, so a wrong key, a chat-completions-only relay or a mistyped model
// name is reported in the settings form instead of surfacing as a raw
// app-server exit. Uses Node's global fetch on purpose: the Codex child does
// not receive HTTP(S)_PROXY either, so a probe through Electron's net module
// (which honours the system proxy) could pass while the real turn fails.

const DEFAULT_TIMEOUT_MS = 20000;
const RESPONSES_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 400;

// Models that are never usable for an agentic Responses turn.
const NON_CHAT_MODEL = /(^|[-_/:.])(embed|embedding|embeddings|tts|whisper|transcribe|transcription|dall-e|dalle|image|images|imagen|flux|stable-diffusion|sd3|sdxl|sora|veo|video|audio|realtime|rerank|reranker|moderation|guard|ocr|vision-embedding|voice|speech|music|clip|bge|e5|jina)([-_/:.]|$)/i;

class ProbeError extends Error {
  constructor(code, message, {status = null, hint = null} = {}) {
    super(message);
    this.name = "ProbeError";
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

function joinUrl(baseUrl, suffix) {
  return String(baseUrl).replace(/\/+$/, "") + suffix;
}

async function readBodyText(response, limit = MAX_BODY_BYTES) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    size += value.byteLength;
    chunks.push(value);
    if (size > limit) { await reader.cancel().catch(() => {}); break; }
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8");
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// Providers disagree about error envelopes; pull out whatever message exists.
function errorMessageOf(body, text) {
  const candidate = body?.error?.message ?? body?.error ?? body?.message ?? body?.detail ?? body?.msg;
  if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 300);
  if (candidate && typeof candidate === "object" && typeof candidate.message === "string") return candidate.message.trim().slice(0, 300);
  const plain = String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return plain ? plain.slice(0, 200) : "";
}

function withTimeout(timeoutMs, run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return run(controller.signal).finally(() => clearTimeout(timer));
}

function networkError(error, seconds) {
  if (error?.name === "AbortError") {
    return new ProbeError("timeout", `接口 ${seconds} 秒没有响应`, {hint: "检查地址是否正确、网络是否可达；有些接口需要挂代理。"});
  }
  const cause = error?.cause || error;
  const code = cause?.code || "";
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return new ProbeError("network", "找不到这个域名", {hint: "检查接口地址是否拼写正确。"});
  if (/ECONNREFUSED/.test(code)) return new ProbeError("network", "连接被拒绝", {hint: "端口或地址不对，或者服务没有启动。"});
  if (/CERT|SSL|TLS|self.signed|UNABLE_TO_VERIFY/i.test(code + " " + (cause?.message || ""))) {
    return new ProbeError("network", "HTTPS 证书无法验证", {hint: "接口证书不可信；可以换成官方域名或联系接口提供方。"});
  }
  return new ProbeError("network", "无法连接到接口" + (cause?.message ? `：${String(cause.message).slice(0, 160)}` : ""), {hint: "检查网络和接口地址。"});
}

function authError(status, body, text) {
  const detail = errorMessageOf(body, text);
  return new ProbeError("auth", "API 密钥无效或没有权限", {status, hint: detail ? `接口返回：${detail}` : "重新复制一次密钥，注意不要带空格。"});
}

// Model ids from GET /models. Returns {models: string[], filtered: number} or
// null when the endpoint has no list (404/405/HTML/empty). Throws ProbeError
// only for authentication and network failures — a missing list is not an
// error, students can still type the model name.
async function discoverModels({baseUrl, apiKey, fetch: fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS}) {
  const url = joinUrl(baseUrl, "/models");
  const started = Date.now();
  let response;
  try {
    response = await withTimeout(timeoutMs, signal => fetchImpl(url, {
      method: "GET",
      headers: {Authorization: `Bearer ${apiKey}`, Accept: "application/json"},
      redirect: "follow",
      signal,
    }));
  } catch (error) {
    throw networkError(error, Math.round(timeoutMs / 1000));
  }
  const text = await readBodyText(response);
  const body = parseJson(text);
  if (response.status === 401 || response.status === 403) throw authError(response.status, body, text);
  if (!response.ok || !body) return null;
  const raw = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : Array.isArray(body) ? body : null;
  if (!raw) return null;
  const ids = new Set();
  for (const item of raw) {
    const id = typeof item === "string" ? item : item?.id ?? item?.model ?? item?.name;
    if (typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/.test(id)) ids.add(id);
    if (ids.size >= MAX_MODELS) break;
  }
  const all = [...ids].sort((a, b) => a.localeCompare(b, "en"));
  const chat = all.filter(id => !NON_CHAT_MODEL.test(id));
  // If the filter would remove everything the heuristic is wrong for this
  // provider; show the raw list rather than an empty one.
  const models = chat.length ? chat : all;
  return {models, filtered: all.length - models.length, elapsedMs: Date.now() - started};
}

// Parses the SSE stream of a Responses call far enough to know whether the
// server accepted the request. Resolves on the first completed/error event or
// on the first output delta (proof the model is producing tokens).
async function readResponsesStream(response, limit = 256 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) return {ok: true, sawEvent: false, text: ""};
  const decoder = new TextDecoder();
  let buffer = "", size = 0, sawEvent = false, text = "";
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      buffer += decoder.decode(value, {stream: true});
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
        if (!data || data === "[DONE]") continue;
        const event = parseJson(data);
        if (!event) continue;
        sawEvent = true;
        const type = String(event.type || "");
        if (type === "error" || type === "response.failed" || event.error) {
          const message = errorMessageOf(event.response?.error || event.error || event, "");
          return {ok: false, sawEvent, message: message || "接口在流式返回中报告了错误"};
        }
        if (type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
        if (type === "response.output_text.delta" || type === "response.completed" || type === "response.incomplete" || type === "response.done") {
          return {ok: true, sawEvent, text};
        }
      }
      if (size > limit) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return {ok: sawEvent, sawEvent, text, message: sawEvent ? null : "接口没有按 Responses API 的流式格式返回"};
}

// One minimal turn through POST /responses, shaped like Codex's real request
// (streaming, reasoning effort, encrypted reasoning include, store:false).
// Resolves {ok:true, ...} or throws ProbeError with a student-facing message.
async function testResponses({baseUrl, apiKey, model, effort = "medium", fetch: fetchImpl = globalThis.fetch, timeoutMs = RESPONSES_TIMEOUT_MS}) {
  const url = joinUrl(baseUrl, "/responses");
  const seconds = Math.round(timeoutMs / 1000);
  const payload = {
    model,
    instructions: "You are a connectivity check. Reply with the single word OK.",
    input: [{type: "message", role: "user", content: [{type: "input_text", text: "Reply with OK."}]}],
    stream: true,
    store: false,
    max_output_tokens: 64,
    reasoning: effort && effort !== "none" ? {effort} : {},
    include: ["reasoning.encrypted_content"],
  };
  const started = Date.now();
  let response;
  try {
    response = await withTimeout(timeoutMs, async signal => {
      const result = await fetchImpl(url, {
        method: "POST",
        headers: {Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream"},
        body: JSON.stringify(payload),
        redirect: "follow",
        signal,
      });
      if (!result.ok) return {response: result, text: await readBodyText(result, 64 * 1024)};
      const stream = await readResponsesStream(result);
      return {response: result, stream};
    });
  } catch (error) {
    throw networkError(error, seconds);
  }
  const {response: http, text, stream} = response;
  const elapsedMs = Date.now() - started;
  if (http.ok) {
    if (stream.ok) return {ok: true, elapsedMs, sample: stream.text.slice(0, 40)};
    throw new ProbeError("protocol", stream.message || "接口返回的内容不是 Responses API 事件流", {status: http.status,
      hint: "这个地址可能只支持 chat/completions；本应用内置的 Codex 只能使用 Responses API（/v1/responses）。"});
  }
  const body = parseJson(text);
  const detail = errorMessageOf(body, text);
  const status = http.status;
  if (status === 401 || status === 403) throw authError(status, body, text);
  if ((status === 400 || status === 422) && /reasoning|effort/i.test(detail)) {
    throw new ProbeError("reasoning", "这个模型不接受思考深度参数", {status, hint: `接口返回：${detail}。可以在高级选项里把思考深度设为「关闭」再试。`});
  }
  const unknownModel = /model|模型/i.test(detail) &&
    /(not (found|exist|available|supported)|invalid|unknown|不存在|无效|不支持|does not exist|no such)/i.test(detail) &&
    !/(route|path|endpoint|resource|page)/i.test(detail);
  if (unknownModel) throw new ProbeError("model", `接口不认识模型「${model}」`, {status, hint: `接口返回：${detail}`});
  if (status === 404 || status === 405 || status === 501) {
    throw new ProbeError("protocol", "这个地址不支持 Responses API", {status,
      hint: (detail ? `接口返回：${detail}。` : "") + "本应用内置的 Codex 只能使用 Responses API（POST /v1/responses）；只提供 chat/completions 的接口目前不能用。请确认地址以 /v1 结尾，或换一个支持 Responses 的接口。"});
  }
  if (status === 400 || status === 422) {
    throw new ProbeError("request", "接口拒绝了请求" + (detail ? `：${detail}` : ""), {status,
      hint: "多数是模型名称不对，或接口不完整支持 Responses API。"});
  }
  if (status === 402) throw new ProbeError("billing", "账户余额不足或未开通", {status, hint: detail ? `接口返回：${detail}` : null});
  if (status === 429) throw new ProbeError("rate-limit", "接口限流或额度用尽", {status, hint: detail ? `接口返回：${detail}` : "稍等一会再试；如果一直如此，检查套餐额度。"});
  if (status >= 500) throw new ProbeError("server", `接口服务端错误（HTTP ${status}）`, {status, hint: detail ? `接口返回：${detail}` : "稍后再试；连续出现说明接口方有故障。"});
  throw new ProbeError("http", `接口返回 HTTP ${status}` + (detail ? `：${detail}` : ""), {status});
}

module.exports = {discoverModels, testResponses, ProbeError, NON_CHAT_MODEL};
