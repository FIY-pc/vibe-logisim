import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import {
  systemProxy,
  networkFetch,
  closeNetwork,
} from "../../packages/agent-runtime/src/network.mts";
import { resolveSystemProxy } from "../../packages/agent-runtime/core/system-proxy.mts";
const registry = `ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ http=127.0.0.1:8080;https=127.0.0.1:8443\nProxyOverride REG_SZ *.internal;<local>`;
const windows = { platform: "win32", read: async () => registry };
assert.equal(
  await systemProxy("https://service.example/", windows),
  "PROXY 127.0.0.1:8443",
);
assert.equal(
  await systemProxy("http://service.example/", windows),
  "PROXY 127.0.0.1:8080",
);
assert.equal(await systemProxy("https://local.internal/", windows), "DIRECT");
assert.equal(await systemProxy("https://intranet/", windows), "DIRECT");
await assert.rejects(
  systemProxy("https://service.example/", {
    platform: "win32",
    read: async () => "AutoConfigURL REG_SZ http://config.example/proxy.pac",
  }),
  /自动代理脚本/,
);
const kde = {
  ProxyType: "1",
  httpsProxy: "http://127.0.0.1 7890",
  NoProxyFor: "*.internal",
};
assert.equal(
  await systemProxy("https://service.example/", {
    platform: "linux",
    desktop: "KDE",
    read: async (_p, args) => kde[args.at(-1)! as keyof typeof kde],
  }),
  "PROXY 127.0.0.1:7890",
);
const gnome: Record<string, string> = {
  mode: "'manual'",
  "ignore-hosts": "['*.internal']",
  "use-same-proxy": "false",
  host: "'127.0.0.1'",
  port: "7891",
};
assert.equal(
  await systemProxy("https://service.example/", {
    platform: "linux",
    desktop: "GNOME",
    read: async (_p, args) => gnome[args.at(-1)!],
  }),
  "PROXY 127.0.0.1:7891",
);
let systemCalls = 0;
const env = { HTTPS_PROXY: "http://127.0.0.1:8000", NO_PROXY: ".internal" };
assert.equal(
  (
    await resolveSystemProxy({
      targetUrl: "https://local.internal/",
      env,
      resolver: () => {
        systemCalls++;
        return "DIRECT";
      },
    })
  ).source,
  "env-bypass",
);
assert.equal(
  (await resolveSystemProxy({ targetUrl: "https://service.example/", env }))
    .proxyUrl,
  "http://127.0.0.1:8000",
);
assert.equal(systemCalls, 0);
const endpoint = createServer((_req, res) => res.end("model response"));
const proxy = createServer();
let tunnels = 0;
await new Promise<void>((r) => endpoint.listen(0, "127.0.0.1", r));
const port = (endpoint.address() as any).port;
proxy.on("connect", (req, client, head) => {
  assert.equal(req.url, "model.invalid:80");
  assert.equal(
    req.headers["proxy-authorization"],
    "Basic " + Buffer.from("fixture:secret").toString("base64"),
  );
  tunnels++;
  const upstream = connect(port, "127.0.0.1", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
});
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
try {
  const fetch = networkFetch({
    proxyUrl: `http://fixture:secret@127.0.0.1:${(proxy.address() as any).port}`,
  });
  assert.equal(
    await (
      await fetch("http://model.invalid/", {
        signal: AbortSignal.timeout(5000),
      })
    ).text(),
    "model response",
  );
  assert.equal(
    tunnels,
    1,
    "Model request must actually traverse the configured proxy",
  );
  assert.throws(
    () => networkFetch({ unsupported: "unsupported proxy" }),
    /unsupported proxy/,
  );
  console.log(
    "Verified proxy selection, bypass, explicit PAC limitation, authenticated CONNECT transport, and shared provider fetch.",
  );
} finally {
  await closeNetwork();
  proxy.closeAllConnections();
  endpoint.closeAllConnections();
  await Promise.all([
    new Promise<void>((r) => proxy.close(() => r())),
    new Promise<void>((r) => endpoint.close(() => r())),
  ]);
}
