import type { ProtocolObject } from "../protocol/types.mts";
interface ProbeOptions {
  baseUrl: string;
  apiKey: string;
  api?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  network?: ProtocolObject | null;
}
// Preflight for a user-supplied endpoint: GET {baseUrl}/models lists what it
// offers (null when it has no such list). It runs before anything is written
// to the profile, so a wrong key or an unreachable address is reported in the
// settings form. The connection test itself is one tiny turn through the SDK
// (TurnRunner.probeService). The caller supplies fetch on the same proxy route
// as the model runtime.

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 400;

// Models that are never usable for an agentic Responses turn.
const NON_CHAT_MODEL =
  /(^|[-_/:.])(embed|embedding|embeddings|tts|whisper|transcribe|transcription|dall-e|dalle|image|images|imagen|flux|stable-diffusion|sd3|sdxl|sora|veo|video|audio|realtime|rerank|reranker|moderation|guard|ocr|vision-embedding|voice|speech|music|clip|bge|e5|jina)([-_/:.]|$)/i;

class ProbeError extends Error {
  declare name: string;
  declare code: string;
  declare status: number | null;
  declare hint: string | null;

  constructor(
    code: string,
    message: string,
    {
      status = null,
      hint = null,
    }: { status?: number | null; hint?: string | null } = {},
  ) {
    super(message);
    this.name = "ProbeError";
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

function joinUrl(baseUrl: string, suffix: string) {
  return String(baseUrl).replace(/\/+$/, "") + suffix;
}

async function readBodyText(response: Response, limit = MAX_BODY_BYTES) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    chunks.push(value);
    if (size > limit) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks.map((chunk: any) => Buffer.from(chunk))).toString(
    "utf8",
  );
}

function parseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Providers disagree about error envelopes; pull out whatever message exists.
function errorMessageOf(body: any, text: any) {
  const candidate =
    body?.error?.message ??
    body?.error ??
    body?.message ??
    body?.detail ??
    body?.msg;
  if (typeof candidate === "string" && candidate.trim())
    return candidate.trim().slice(0, 300);
  if (
    candidate &&
    typeof candidate === "object" &&
    typeof candidate.message === "string"
  )
    return candidate.message.trim().slice(0, 300);
  const plain = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain ? plain.slice(0, 200) : "";
}

function withTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return run(controller.signal).finally(() => clearTimeout(timer));
}

// One sentence about the route, appended to network-level hints.
function routeHint(network: any) {
  if (!network) return "";
  if (network.unsupported) return `${network.unsupported}，这次是直接连接的。`;
  if (network.proxyUrl)
    return `这次通过${network.source === "env" ? "环境变量里的代理" : "系统代理"} ${network.hostPort} 连接；确认代理软件在运行、节点可用。`;
  return "这次是直接连接（未检测到系统代理）；如果这个接口需要代理，先在代理软件里开启「系统代理」再试。";
}

function networkError(error: any, seconds: any, network: any = null) {
  const route = routeHint(network);
  const name = error?.name || "";
  const cause = error?.cause || error;
  const code = String(cause?.code || "");
  const text = `${code} ${error?.message || ""} ${cause?.message || ""}`;
  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    /ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|ETIMEDOUT/.test(text)
  ) {
    return new ProbeError("timeout", `接口 ${seconds} 秒没有响应`, {
      hint: `检查地址是否正确、网络是否可达。${route}`.trim(),
    });
  }
  if (
    /ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_AUTH|ERR_MANDATORY_PROXY|ERR_NO_SUPPORTED_PROXIES|ERR_PROXY_CERTIFICATE_INVALID/.test(
      text,
    )
  ) {
    const where = network?.hostPort ? ` ${network.hostPort}` : "";
    if (/ERR_PROXY_AUTH/.test(text))
      return new ProbeError("proxy", `代理${where} 要求账号密码`, {
        hint: "保存前的检测不能带代理账号；可以「跳过检测直接保存」，AI 运行时会使用环境变量里的完整代理地址。",
      });
    return new ProbeError("proxy", `连不上代理${where}`, {
      hint: "代理软件没有运行、端口不对，或节点不可用。修好后重试；不需要代理时在代理软件里关闭「系统代理」。",
    });
  }
  if (
    /ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/.test(
      text,
    )
  )
    return new ProbeError("network", "找不到这个域名", {
      hint: `检查接口地址是否拼写正确。${network?.proxyUrl ? "" : route}`.trim(),
    });
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED|ERR_UNSAFE_PORT/.test(text))
    return new ProbeError("network", "连接被拒绝", {
      hint: `端口或地址不对，或者服务没有启动。${network?.proxyUrl ? route : ""}`.trim(),
    });
  if (
    /ECONNRESET|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_ABORTED/.test(
      text,
    )
  )
    return new ProbeError("network", "连接被中断", {
      hint: `接口在响应前断开了连接。${route}`.trim(),
    });
  if (/CERT|ERR_SSL|SSL|TLS|self.signed|UNABLE_TO_VERIFY/i.test(text)) {
    return new ProbeError("network", "HTTPS 连接失败（证书或协议）", {
      hint: "接口证书不可信，或地址写了 https 但服务只有 http；可以换成官方域名或联系接口提供方。",
    });
  }
  if (
    /ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ENETUNREACH|EHOSTUNREACH/.test(
      text,
    )
  )
    return new ProbeError("network", "网络不可达", {
      hint: `检查本机网络连接。${route}`.trim(),
    });
  const detail = String(cause?.message || error?.message || "")
    .replace(/^net::/, "")
    .slice(0, 160);
  return new ProbeError(
    "network",
    "无法连接到接口" + (detail ? `：${detail}` : ""),
    { hint: `检查网络和接口地址。${route}`.trim() },
  );
}

function authError(status: any, body: any, text: any) {
  const detail = errorMessageOf(body, text);
  return new ProbeError("auth", "API 密钥无效或没有权限", {
    status,
    hint: detail ? `接口返回：${detail}` : "重新复制一次密钥，注意不要带空格。",
  });
}

// Model ids from GET /models. Returns {models: string[], filtered: number} or
// null when the endpoint has no list (404/405/501/HTML/empty). Temporary HTTP,
// authentication and network failures stay visible; a missing list still
// allows a model name to be entered manually.
async function discoverModels({
  baseUrl,
  apiKey,
  api = "openai-responses",
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  network = null,
}: ProbeOptions) {
  const anthropic = api === "anthropic-messages";
  const url = joinUrl(baseUrl, anthropic ? "/v1/models" : "/models");
  const started = Date.now();
  let response, text;
  try {
    ({ response, text } = await withTimeout(timeoutMs, async (signal: any) => {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: anthropic
          ? {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              Accept: "application/json",
            }
          : { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        redirect: "follow",
        signal,
      });
      return { response, text: await readBodyText(response) };
    }));
  } catch (error: any) {
    throw networkError(error, Math.round(timeoutMs / 1000), network);
  }
  const body = parseJson(text || "");
  if (response.status === 401 || response.status === 403)
    throw authError(response.status, body, text);
  if ([404, 405, 501].includes(response.status)) return null;
  if (!response.ok)
    throw new ProbeError(
      response.status === 429 ? "rate-limit" : "server",
      `读取模型列表失败（HTTP ${response.status}）`,
      { status: response.status },
    );
  if (!body) return null;
  const raw = Array.isArray(body.data)
    ? body.data
    : Array.isArray(body.models)
      ? body.models
      : Array.isArray(body)
        ? body
        : null;
  if (!raw) return null;
  const ids = new Set<string>();
  for (const item of raw) {
    const id =
      typeof item === "string" ? item : (item?.id ?? item?.model ?? item?.name);
    if (
      typeof id === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/.test(id)
    )
      ids.add(id);
    if (ids.size >= MAX_MODELS) break;
  }
  const all = [...ids].sort((a: any, b: any) => a.localeCompare(b, "en"));
  const chat = all.filter((id: any) => !NON_CHAT_MODEL.test(id));
  // If the filter would remove everything the heuristic is wrong for this
  // provider; show the raw list rather than an empty one.
  const models = chat.length ? chat : all;
  return {
    models,
    filtered: all.length - models.length,
    elapsedMs: Date.now() - started,
  };
}

export { discoverModels, ProbeError };
