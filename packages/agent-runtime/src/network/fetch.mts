import { resolveSystemProxy } from "./system-proxy.mts";
import { BlockList, isIP } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { ProxyAgent, fetch as request } from "undici";

const exec = promisify(execFile);
type Read = (program: string, args: string[]) => Promise<string>;
const read: Read = async (program, args) => {
  const { stdout } = await exec(program, args, {
    timeout: 1500,
    maxBuffer: 65536,
    windowsHide: true,
  });
  return stdout.trim();
};
function excluded(host: string, patterns: string[]) {
  return patterns.some((p) => {
    if (p.includes("/") && isIP(host)) {
      const [address, prefix] = p.split("/");
      if (isIP(address) === isIP(host)) {
        try {
          const list = new BlockList();
          const family = isIP(host) === 6 ? "ipv6" : "ipv4";
          list.addSubnet(address, Number(prefix), family);
          return list.check(host, family);
        } catch {
          return false;
        }
      }
    }
    if (p === "<local>") return !host.includes(".") && !host.includes(":");
    const pattern = p
      .toLowerCase()
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*");
    return new RegExp(`^${pattern}$`).test(host.toLowerCase());
  });
}
function proxy(address: string, socks = false) {
  if (!address) return "DIRECT";
  // KDE may store the port after a space instead of a colon.
  const normalized = address.trim().replace(/\s+(\d+)$/, ":$1");
  const url = new URL(
    normalized.includes("://") ? normalized : `http://${normalized}`,
  );
  return `${socks ? "SOCKS5" : url.protocol === "https:" ? "HTTPS" : "PROXY"} ${url.host}`;
}
const autoError = () =>
  new Error(
    "当前系统使用自动代理脚本，请配置 HTTP_PROXY / HTTPS_PROXY 或切换为手动系统代理",
  );

/** OS settings are read on each reconnect; environment variables take precedence in the caller. */
export async function systemProxy(
  target: string,
  options: { platform?: string; desktop?: string; read?: Read } = {},
) {
  const url = new URL(target),
    host = url.hostname.replace(/^\[|\]$/g, "");
  if (["localhost", "127.0.0.1", "::1"].includes(host)) return "DIRECT";
  const run = options.read || read,
    platform = options.platform || process.platform;
  if (platform === "win32") {
    const output = await run(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32/reg.exe"),
      [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      ],
    );
    const fields = Object.fromEntries(
      output.split(/\r?\n/).flatMap((line) => {
        const match = line.trim().match(/^(\S+)\s+REG_\w+\s+(.*)$/);
        return match ? [[match[1], match[2]]] : [];
      }),
    );
    if (Number(fields.ProxyEnable) !== 1) {
      if (fields.AutoConfigURL) throw autoError();
      return "DIRECT";
    }
    if (
      excluded(
        host,
        (fields.ProxyOverride || "").split(";").map((s) => s.trim()),
      )
    )
      return "DIRECT";
    const server = fields.ProxyServer || "";
    if (!server.includes("=")) return proxy(server);
    const rules = Object.fromEntries(
      server.split(";").map((s) => s.trim().split("=")),
    );
    return rules[url.protocol.slice(0, -1)]
      ? proxy(rules[url.protocol.slice(0, -1)])
      : rules.socks
        ? proxy(rules.socks, true)
        : "DIRECT";
  }
  if (platform !== "linux") return "DIRECT";
  if (/kde/i.test(options.desktop ?? process.env.XDG_CURRENT_DESKTOP ?? "")) {
    const value = (key: string) =>
      run("kreadconfig6", [
        "--file",
        "kioslaverc",
        "--group",
        "Proxy Settings",
        "--key",
        key,
      ]);
    const type = await value("ProxyType");
    if (!type || type === "0" || type === "4") return "DIRECT";
    if (type !== "1") throw autoError();
    const [address, bypass] = await Promise.all([
      value(url.protocol === "https:" ? "httpsProxy" : "httpProxy"),
      value("NoProxyFor"),
    ]);
    return excluded(host, bypass.split(/[,;\s]+/).filter(Boolean))
      ? "DIRECT"
      : proxy(address);
  }
  const setting = async (schema: string, key: string) =>
    (await run("gsettings", ["get", schema, key])).replace(/^'|'$/g, "");
  let mode: string;
  try {
    mode = await setting("org.gnome.system.proxy", "mode");
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      /No such schema/.test(String(error))
    )
      return "DIRECT";
    throw error;
  }
  if (mode === "none") return "DIRECT";
  if (mode !== "manual") throw autoError();
  const bypass = await run("gsettings", [
    "get",
    "org.gnome.system.proxy",
    "ignore-hosts",
  ]);
  if (
    excluded(
      host,
      [...bypass.matchAll(/'([^']+)'/g)].map((m) => m[1]),
    )
  )
    return "DIRECT";
  const same = await setting("org.gnome.system.proxy", "use-same-proxy");
  const scheme = same === "true" ? "http" : url.protocol.slice(0, -1);
  const addressFor = async (protocol: string) => {
    const [address, port] = await Promise.all([
      setting(`org.gnome.system.proxy.${protocol}`, "host"),
      setting(`org.gnome.system.proxy.${protocol}`, "port"),
    ]);
    return address && Number(port) > 0
      ? `${address.includes(":") ? `[${address}]` : address}:${port}`
      : "";
  };
  const address =
    (await addressFor(scheme)) ||
    (scheme === "https" ? await addressFor("http") : "");
  if (address) return proxy(address);
  const socks = await addressFor("socks");
  return socks ? proxy(socks, true) : "DIRECT";
}

const dispatchers = new Map<string, ProxyAgent>();
export function networkFetch(network: {
  proxyUrl?: string;
  unsupported?: string;
  error?: string;
}): typeof globalThis.fetch {
  if (network.unsupported || network.error)
    throw new Error(network.unsupported || network.error);
  if (!network.proxyUrl) return globalThis.fetch;
  let dispatcher = dispatchers.get(network.proxyUrl);
  if (!dispatcher) {
    dispatcher = new ProxyAgent({ uri: network.proxyUrl, proxyTunnel: true });
    dispatchers.set(network.proxyUrl, dispatcher);
  }
  const selected = dispatcher;
  // Keep fetch and dispatcher on the same Undici major; Node bundles its own version.
  return ((input: any, init: any) =>
    request(input, {
      ...init,
      dispatcher: selected,
    })) as unknown as typeof globalThis.fetch;
}
export async function closeNetwork() {
  await Promise.all([...dispatchers.values()].map((d) => d.destroy()));
  dispatchers.clear();
}

export const runtimeFetch: typeof globalThis.fetch = async (input, init) => {
  const targetUrl = input instanceof Request ? input.url : String(input);
  const network = await resolveSystemProxy({
    targetUrl,
    resolver: systemProxy,
  });
  return networkFetch(network)(input, init);
};
