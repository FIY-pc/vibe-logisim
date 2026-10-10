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
// app-server exit.
//
// Network route: the caller passes `fetch` bound to an Electron session whose
// proxy is set from the same system-proxy resolution the Codex child gets in
// its environment (see system-proxy.cjs), so a probe that passes here takes
// the route the real turn will take. Errors from that session are Chromium's
// "net::ERR_*" strings and TimeoutError; Node's fetch (tests) gives
// ECONNREFUSED-style codes. Both are mapped below. `network` (the resolution
// result) only shapes the hints.

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

// One sentence about the route, appended to network-level hints.
function routeHint(network) {
  if (!network) return "";
  if (network.unsupported) return `${network.unsupported}，这次是直接连接的。`;
  if (network.proxyUrl) return `这次通过${network.source === "env" ? "环境变量里的代理" : "系统代理"} ${network.hostPort} 连接；确认代理软件在运行、节点可用。`;
  return "这次是直接连接（未检测到系统代理）；如果这个接口需要代理，先在代理软件里开启「系统代理」再试。";
}

function networkError(error, seconds, network = null) {
  const route = routeHint(network);
  const name = error?.name || "";
  const cause = error?.cause || error;
  const code = String(cause?.code || "");
  const text = `${code} ${error?.message || ""} ${cause?.message || ""}`;
  if (name === "AbortError" || name === "TimeoutError" || /ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|ETIMEDOUT/.test(text)) {
    return new ProbeError("timeout", `接口 ${seconds} 秒没有响应`, {hint: `检查地址是否正确、网络是否可达。${route}`.trim()});
  }
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_AUTH|ERR_MANDATORY_PROXY|ERR_NO_SUPPORTED_PROXIES|ERR_PROXY_CERTIFICATE_INVALID/.test(text)) {
    const where = network?.hostPort ? ` ${network.hostPort}` : "";
    if (/ERR_PROXY_AUTH/.test(text)) return new ProbeError("proxy", `代理${where} 要求账号密码`, {hint: "保存前的检测不能带代理账号；可以「跳过检测直接保存」，AI 运行时会使用环境变量里的完整代理地址。"});
    return new ProbeError("proxy", `连不上代理${where}`, {hint: "代理软件没有运行、端口不对，或节点不可用。修好后重试；不需要代理时在代理软件里关闭「系统代理」。"});
  }
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/.test(text)) return new ProbeError("network", "找不到这个域名", {hint: `检查接口地址是否拼写正确。${network?.proxyUrl ? "" : route}`.trim()});
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED|ERR_UNSAFE_PORT/.test(text)) return new ProbeError("network", "连接被拒绝", {hint: `端口或地址不对，或者服务没有启动。${network?.proxyUrl ? route : ""}`.trim()});
  if (/ECONNRESET|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_ABORTED/.test(text)) return new ProbeError("network", "连接被中断", {hint: `接口在响应前断开了连接。${route}`.trim()});
  if (/CERT|ERR_SSL|SSL|TLS|self.signed|UNABLE_TO_VERIFY/i.test(text)) {
    return new ProbeError("network", "HTTPS 连接失败（证书或协议）", {hint: "接口证书不可信，或地址写了 https 但服务只有 http；可以换成官方域名或联系接口提供方。"});
  }
  if (/ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ENETUNREACH|EHOSTUNREACH/.test(text)) return new ProbeError("network", "网络不可达", {hint: `检查本机网络连接。${route}`.trim()});
  const detail = String(cause?.message || error?.message || "").replace(/^net::/, "").slice(0, 160);
  return new ProbeError("network", "无法连接到接口" + (detail ? `：${detail}` : ""), {hint: `检查网络和接口地址。${route}`.trim()});
}

function authError(status, body, text) {
  const detail = errorMessageOf(body, text);
  return new ProbeError("auth", "API 密钥无效或没有权限", {status, hint: detail ? `接口返回：${detail}` : "重新复制一次密钥，注意不要带空格。"});
}

// Model ids from GET /models. Returns {models: string[], filtered: number} or
// null when the endpoint has no list (404/405/501/HTML/empty). Temporary HTTP,
// authentication and network failures stay visible; a missing list still
// allows a model name to be entered manually.
async function discoverModels({baseUrl, apiKey, api = "openai-responses", fetch: fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, network = null}) {
  const anthropic = api === "anthropic-messages";
  const url = joinUrl(baseUrl, anthropic ? "/v1/models" : "/models");
  const started = Date.now();
  let response, text;
  try {
    ({response, text} = await withTimeout(timeoutMs, async signal => {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: anthropic
          ? {"x-api-key": apiKey, "anthropic-version": "2023-06-01", Accept: "application/json"}
          : {Authorization: `Bearer ${apiKey}`, Accept: "application/json"},
        redirect: "follow",
        signal,
      });
      return {response, text: await readBodyText(response)};
    }));
  } catch (error) {
    throw networkError(error, Math.round(timeoutMs / 1000), network);
  }
  const body = parseJson(text);
  if (response.status === 401 || response.status === 403) throw authError(response.status, body, text);
  if ([404, 405, 501].includes(response.status)) return null;
  if (!response.ok) throw new ProbeError(response.status === 429 ? "rate-limit" : "server", `读取模型列表失败（HTTP ${response.status}）`, {status: response.status});
  if (!body) return null;
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
async function testResponses({baseUrl, apiKey, model, effort = "medium", fetch: fetchImpl = globalThis.fetch, timeoutMs = RESPONSES_TIMEOUT_MS, network = null}) {
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
    throw networkError(error, seconds, network);
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
