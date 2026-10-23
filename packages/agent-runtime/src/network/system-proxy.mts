// Resolve environment and operating-system proxy settings for both model
// requests and optional runtime processes. Credentials stay in process memory.
const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
];
const LOOPBACK_BYPASS = ["localhost", "127.0.0.1", "::1"];
const SUPPORTED_SCHEMES = new Set(["http", "https"]);
const DEFAULT_RESOLVE_TIMEOUT_MS = 3000;

function envValue(env: any, ...names: any[]) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

// "127.0.0.1:7890", "http://127.0.0.1:7890", "socks5h://user:pw@host:1080"
// → {url, scheme, host, port, hostPort, rules, credentials} or null.
function parseProxyUrl(value: any) {
  let text = String(value || "").trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = "http://" + text;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (!url.hostname) return null;
  const host = url.hostname;
  const port =
    url.port ||
    (scheme === "https" ? "443" : scheme.startsWith("socks") ? "1080" : "80");
  const hostPort = `${host}:${port}`;
  const credentials = url.username
    ? `${decodeURIComponent(url.username)}${url.password ? ":" + decodeURIComponent(url.password) : ""}`
    : "";
  const rulesScheme =
    scheme === "https"
      ? "https"
      : scheme.startsWith("socks")
        ? scheme.startsWith("socks5")
          ? "socks5"
          : "socks4"
        : "http";
  const envScheme =
    scheme === "socks5h" || scheme === "socks5"
      ? "socks5h"
      : scheme.startsWith("socks")
        ? "socks5h"
        : scheme === "https"
          ? "https"
          : "http";
  return {
    url: `${envScheme}://${credentials ? `${url.username}${url.password ? ":" + url.password : ""}@` : ""}${hostPort}`,
    scheme: envScheme,
    host,
    port,
    hostPort,
    credentials,
    rules: `${rulesScheme}://${hostPort}`,
  };
}

// Chromium's resolveProxy result: "DIRECT" | "PROXY h:p; HTTPS h:p; SOCKS5 h:p; DIRECT" (in order).
function parseChromiumList(text: any) {
  const entries: (
    | { type: "DIRECT" }
    | ({ type: "PROXY" } & NonNullable<ReturnType<typeof parseProxyUrl>>)
  )[] = [];
  for (const raw of String(text || "").split(";")) {
    const item = raw.trim();
    if (!item) continue;
    const [kind, address] = item.split(/\s+/);
    const type = String(kind || "").toUpperCase();
    if (type === "DIRECT") {
      entries.push({ type: "DIRECT" });
      continue;
    }
    if (!address) continue;
    const scheme =
      type === "PROXY" || type === "HTTP"
        ? "http"
        : type === "HTTPS"
          ? "https"
          : type === "SOCKS5"
            ? "socks5h"
            : type === "SOCKS" || type === "SOCKS4"
              ? "socks4"
              : null;
    if (!scheme) continue;
    const parsed = parseProxyUrl(`${scheme}://${address}`);
    if (parsed) entries.push({ type: "PROXY", ...parsed });
  }
  return entries;
}

function parseNoProxy(value: any) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item: any) => item.trim())
    .filter(Boolean);
}

// reqwest / curl semantics: "*" everything; "example.com" and ".example.com"
// both match the host and its subdomains; optional ":port"; IP literals exact.
function bypasses(hostname: any, port: any, noProxyList: any) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  for (const rawEntry of noProxyList) {
    let entry = rawEntry.toLowerCase();
    if (entry === "*") return true;
    let entryPort = null;
    const portMatch = /^(.*):(\d+)$/.exec(entry);
    if (portMatch && !/^\[?[0-9a-f:]+\]?$/.test(entry)) {
      entry = portMatch[1];
      entryPort = portMatch[2];
    }
    entry = entry.replace(/^\[|\]$/g, "").replace(/^\*?\./, "");
    if (!entry) continue;
    if (entryPort && String(port || "") !== entryPort) continue;
    if (host === entry || host.endsWith("." + entry)) return true;
  }
  return false;
}

function targetOf(targetUrl: any) {
  let url;
  try {
    url = new URL(String(targetUrl || "https://chatgpt.com/"));
  } catch {
    url = new URL("https://chatgpt.com/");
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  return {
    url,
    scheme,
    hostname: url.hostname,
    port: url.port || (scheme === "https" ? "443" : "80"),
  };
}

// Every result carries its own student-facing `description` so the renderer
// only displays; the wording lives here, next to the facts it depends on.
function result(fields: any) {
  const resolved = {
    proxyUrl: null,
    scheme: null,
    hostPort: null,
    rules: null,
    credentials: false,
    source: "none",
    unsupported: null,
    noProxy: [],
    target: null,
    resolvedAt: Date.now(),
    ...fields,
  };
  resolved.description = describe(resolved);
  return resolved;
}

// The host resolver returns a standard proxy chain; without it use environment settings.
async function resolveSystemProxy({
  targetUrl,
  env = process.env,
  resolver = null,
  timeoutMs = DEFAULT_RESOLVE_TIMEOUT_MS,
}: any = {}) {
  const target = targetOf(targetUrl);
  const noProxy = parseNoProxy(envValue(env, "NO_PROXY", "no_proxy"));
  const base = { target: target.url.href, noProxy };
  const envProxy =
    target.scheme === "https"
      ? envValue(env, "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy")
      : envValue(env, "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy");
  if (envProxy) {
    if (bypasses(target.hostname, target.port, noProxy))
      return result({ ...base, source: "env-bypass" });
    const parsed = parseProxyUrl(envProxy);
    if (!parsed)
      return result({
        ...base,
        source: "env",
        unsupported: `无法识别代理地址 ${envProxy.slice(0, 80)}`,
      });
    if (!SUPPORTED_SCHEMES.has(parsed.scheme))
      return result({
        ...base,
        source: "env",
        hostPort: parsed.hostPort,
        scheme: parsed.scheme,
        unsupported: `环境变量里的代理 ${envProxy.replace(/\/\/[^@]*@/, "//")} 是 SOCKS 代理，AI 运行时只支持 HTTP 代理`,
      });
    return result({
      ...base,
      source: "env",
      proxyUrl: parsed.url,
      scheme: parsed.scheme,
      hostPort: parsed.hostPort,
      rules: parsed.rules,
      credentials: Boolean(parsed.credentials),
    });
  }
  if (typeof resolver !== "function") return result(base);
  let list;
  try {
    list = await Promise.race([
      resolver(target.url.href),
      new Promise((_: any, reject: any) =>
        setTimeout(() => reject(new Error("resolveProxy timeout")), timeoutMs),
      ),
    ]);
  } catch (error: any) {
    return result({
      ...base,
      source: "none",
      unsupported: null,
      error: String(error?.message || error).slice(0, 120),
    });
  }
  const entries = parseChromiumList(list);
  const direct = entries.find((entry: any) => entry.type === "DIRECT");
  const usable = entries.find(
    (entry) => entry.type !== "DIRECT" && SUPPORTED_SCHEMES.has(entry.scheme),
  );
  const socks = entries.find(
    (entry) => entry.type !== "DIRECT" && !SUPPORTED_SCHEMES.has(entry.scheme),
  );
  if (
    usable &&
    usable.type !== "DIRECT" &&
    (!direct || entries.indexOf(usable) < entries.indexOf(direct))
  ) {
    return result({
      ...base,
      source: "system",
      proxyUrl: usable.url,
      scheme: usable.scheme,
      hostPort: usable.hostPort,
      rules: usable.rules,
    });
  }
  if (socks && socks.type !== "DIRECT" && !direct) {
    return result({
      ...base,
      source: "system",
      scheme: socks.scheme,
      hostPort: socks.hostPort,
      unsupported: `系统代理 ${socks.hostPort} 是 SOCKS 代理，AI 运行时只支持 HTTP 代理；请在代理软件里开启 HTTP 端口（Clash 默认 7890）或「混合端口」`,
    });
  }
  return result(base);
}

// Env block for a child process. reqwest-style clients read all of these; setting the
// three to the same value covers every code path. Loopback is always
// bypassed (local model servers, the app's own service) so the child's
// behaviour matches Chromium's implicit loopback bypass in the probe.
function childEnvironment(network: any) {
  if (!network?.proxyUrl) return {};
  const noProxy = [
    ...new Set([...LOOPBACK_BYPASS, ...(network.noProxy || [])]),
  ].join(",");
  return {
    HTTPS_PROXY: network.proxyUrl,
    HTTP_PROXY: network.proxyUrl,
    ALL_PROXY: network.proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

// {kind:"proxy"|"direct"|"unsupported", label, sentence}
function describe(network: any) {
  if (network?.error)
    return {
      kind: "error",
      label: "代理设置无法读取",
      sentence: network.error,
    };
  if (!network)
    return { kind: "unknown", label: "正在检测网络…", sentence: "" };
  if (network.unsupported)
    return {
      kind: "unsupported",
      label: `代理不支持 · ${network.hostPort || ""}`.replace(/ · $/, ""),
      sentence: network.unsupported + "。",
    };
  if (network.proxyUrl) {
    const origin = network.source === "env" ? "环境变量里的代理" : "系统代理";
    return {
      kind: "proxy",
      label: `${origin} ${network.hostPort}`,
      sentence: `已检测到${origin} ${network.hostPort}，AI 运行时和保存前的检测都会通过它访问接口。`,
    };
  }
  if (network.source === "env-bypass")
    return {
      kind: "direct",
      label: "直连（NO_PROXY 排除）",
      sentence: "这个地址在 NO_PROXY 里，直接连接。",
    };
  return {
    kind: "direct",
    label: "直连（未检测到系统代理）",
    sentence:
      "未检测到系统代理，AI 运行时会直接连接。访问 ChatGPT / OpenAI 需要先在代理软件里开启「系统代理」，再点「重新连接」；国内中转站一般不需要。",
  };
}

export {
  resolveSystemProxy,
  childEnvironment,
  describe,
  parseProxyUrl,
  parseChromiumList,
  parseNoProxy,
  bypasses,
  PROXY_ENV_KEYS,
  LOOPBACK_BYPASS,
  DEFAULT_RESOLVE_TIMEOUT_MS,
};
