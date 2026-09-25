'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const {resolveSystemProxy, childEnvironment, sessionConfig, describe, parseProxyUrl, parseChromiumList, bypasses} = require('./system-proxy.cjs');

test('parseProxyUrl accepts bare host:port, schemes, credentials and socks', () => {
  assert.deepEqual(parseProxyUrl('127.0.0.1:7890'), {url: 'http://127.0.0.1:7890', scheme: 'http', host: '127.0.0.1', port: '7890', hostPort: '127.0.0.1:7890', credentials: '', rules: 'http://127.0.0.1:7890'});
  assert.equal(parseProxyUrl('http://proxy.lab:3128/').url, 'http://proxy.lab:3128');
  assert.equal(parseProxyUrl('https://proxy.lab').hostPort, 'proxy.lab:443');
  const cred = parseProxyUrl('http://user:p%40ss@10.0.0.1:8080');
  assert.equal(cred.url, 'http://user:p%40ss@10.0.0.1:8080'); assert.equal(cred.credentials, 'user:p@ss'); assert.equal(cred.rules, 'http://10.0.0.1:8080');
  assert.equal(parseProxyUrl('socks5://127.0.0.1:1080').scheme, 'socks5h'); assert.equal(parseProxyUrl('socks5h://127.0.0.1').hostPort, '127.0.0.1:1080');
  assert.equal(parseProxyUrl(''), null); assert.equal(parseProxyUrl('http://'), null);
});

test('parseChromiumList keeps order and maps PROXY/HTTPS/SOCKS5/DIRECT', () => {
  const list = parseChromiumList('PROXY 127.0.0.1:7890; HTTPS secure.lab:443; SOCKS5 127.0.0.1:1080; DIRECT');
  assert.deepEqual(list.map(e => [e.type, e.scheme || null, e.hostPort || null]), [['PROXY', 'http', '127.0.0.1:7890'], ['HTTPS', 'https', 'secure.lab:443'], ['SOCKS5', 'socks5h', '127.0.0.1:1080'], ['DIRECT', null, null]]);
  assert.deepEqual(parseChromiumList('DIRECT'), [{type: 'DIRECT'}]);
  assert.deepEqual(parseChromiumList(''), []);
});

test('bypasses follows NO_PROXY semantics (suffix, leading dot, port, IPs, *)', () => {
  assert.equal(bypasses('api.example.com', '443', ['example.com']), true);
  assert.equal(bypasses('example.com', '443', ['.example.com']), true);
  assert.equal(bypasses('notexample.com', '443', ['example.com']), false);
  assert.equal(bypasses('api.example.com', '443', ['example.com:8443']), false);
  assert.equal(bypasses('api.example.com', '8443', ['example.com:8443']), true);
  assert.equal(bypasses('127.0.0.1', '80', ['localhost', '127.0.0.1']), true);
  assert.equal(bypasses('anything.test', '80', ['*']), true);
  assert.equal(bypasses('[::1]', '80', ['::1']), true);
});

test('env proxy wins over the Chromium resolver; scheme-specific variables and NO_PROXY apply', async () => {
  const resolver = async () => 'PROXY 10.9.9.9:3128';
  const https = await resolveSystemProxy({targetUrl: 'https://api.openai.com/v1', env: {HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: 'http://127.0.0.1:7891'}, resolver});
  assert.equal(https.source, 'env'); assert.equal(https.proxyUrl, 'http://127.0.0.1:7890'); assert.equal(https.rules, 'http://127.0.0.1:7890');
  const http = await resolveSystemProxy({targetUrl: 'http://relay.example:8080/v1', env: {HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: 'http://127.0.0.1:7891'}, resolver});
  assert.equal(http.proxyUrl, 'http://127.0.0.1:7891');
  const lower = await resolveSystemProxy({targetUrl: 'https://api.openai.com/', env: {all_proxy: '127.0.0.1:7892'}, resolver});
  assert.equal(lower.source, 'env'); assert.equal(lower.proxyUrl, 'http://127.0.0.1:7892');
  const bypass = await resolveSystemProxy({targetUrl: 'https://api.internal.example/v1', env: {HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,.internal.example'}, resolver});
  assert.equal(bypass.source, 'env-bypass'); assert.equal(bypass.proxyUrl, null); assert.deepEqual(bypass.noProxy, ['localhost', '.internal.example']);
  const socksEnv = await resolveSystemProxy({targetUrl: 'https://api.openai.com/', env: {ALL_PROXY: 'socks5h://127.0.0.1:1080'}, resolver});
  assert.equal(socksEnv.proxyUrl, null); assert.match(socksEnv.unsupported, /SOCKS/); assert.equal(socksEnv.hostPort, '127.0.0.1:1080');
});

test('without env the Chromium resolver decides: first usable entry, SOCKS-only is unsupported, DIRECT is direct, timeout is tolerated', async () => {
  const sys = await resolveSystemProxy({targetUrl: 'https://chatgpt.com/', env: {}, resolver: async url => { assert.equal(url, 'https://chatgpt.com/'); return 'PROXY 127.0.0.1:7890; DIRECT'; }});
  assert.equal(sys.source, 'system'); assert.equal(sys.proxyUrl, 'http://127.0.0.1:7890'); assert.equal(sys.hostPort, '127.0.0.1:7890');
  assert.deepEqual(sys.description, describe(sys), 'every result carries its description');
  const httpsProxy = await resolveSystemProxy({targetUrl: 'https://chatgpt.com/', env: {}, resolver: async () => 'HTTPS secure.lab:443'});
  assert.equal(httpsProxy.proxyUrl, 'https://secure.lab:443'); assert.equal(httpsProxy.rules, 'https://secure.lab:443');
  const socks = await resolveSystemProxy({targetUrl: 'https://chatgpt.com/', env: {}, resolver: async () => 'SOCKS5 127.0.0.1:1080'});
  assert.equal(socks.proxyUrl, null); assert.equal(socks.source, 'system'); assert.match(socks.unsupported, /SOCKS/); assert.match(socks.unsupported, /7890/);
  const socksThenDirect = await resolveSystemProxy({targetUrl: 'https://chatgpt.com/', env: {}, resolver: async () => 'SOCKS5 127.0.0.1:1080; DIRECT'});
  assert.equal(socksThenDirect.proxyUrl, null); assert.equal(socksThenDirect.unsupported, null);
  const direct = await resolveSystemProxy({targetUrl: 'https://chatgpt.com/', env: {}, resolver: async () => 'DIRECT'});
  assert.equal(direct.source, 'none'); assert.equal(direct.proxyUrl, null);
  const slow = await resolveSystemProxy({targetUrl: 'https://chatgpt.com/', env: {}, resolver: () => new Promise(() => {}), timeoutMs: 30});
  assert.equal(slow.proxyUrl, null); assert.match(slow.error, /timeout/);
  const none = await resolveSystemProxy({targetUrl: 'https://chatgpt.com/', env: {}});
  assert.equal(none.source, 'none');
});

test('childEnvironment and sessionConfig route the same way; loopback always bypassed; credentials only in the env', async () => {
  const network = await resolveSystemProxy({targetUrl: 'https://api.openai.com/', env: {HTTPS_PROXY: 'http://u:p@127.0.0.1:7890', NO_PROXY: '.lab.example'}});
  const env = childEnvironment(network);
  assert.equal(env.HTTPS_PROXY, 'http://u:p@127.0.0.1:7890'); assert.equal(env.HTTP_PROXY, env.HTTPS_PROXY); assert.equal(env.ALL_PROXY, env.HTTPS_PROXY);
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1,.lab.example'); assert.equal(env.no_proxy, env.NO_PROXY);
  assert.deepEqual(sessionConfig(network), {mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:7890', proxyBypassRules: 'localhost,127.0.0.1,::1,*.lab.example'});
  assert.equal(network.credentials, true);
  assert.deepEqual(childEnvironment(await resolveSystemProxy({targetUrl: 'https://x.example/', env: {}})), {});
  assert.deepEqual(sessionConfig(null), {mode: 'direct'});
});

test('describe gives the dialog one sentence per situation', async () => {
  const proxied = describe(await resolveSystemProxy({targetUrl: 'https://chatgpt.com/', env: {}, resolver: async () => 'PROXY 127.0.0.1:7890'}));
  assert.equal(proxied.kind, 'proxy'); assert.equal(proxied.label, '系统代理 127.0.0.1:7890'); assert.match(proxied.sentence, /通过它/);
  const envProxied = describe(await resolveSystemProxy({targetUrl: 'https://chatgpt.com/', env: {HTTPS_PROXY: '127.0.0.1:7890'}}));
  assert.match(envProxied.label, /环境变量/);
  const direct = describe(await resolveSystemProxy({targetUrl: 'https://chatgpt.com/', env: {}}));
  assert.equal(direct.kind, 'direct'); assert.match(direct.sentence, /系统代理/);
  const socks = describe(await resolveSystemProxy({targetUrl: 'https://chatgpt.com/', env: {}, resolver: async () => 'SOCKS5 127.0.0.1:1080'}));
  assert.equal(socks.kind, 'unsupported'); assert.match(socks.sentence, /HTTP 代理/);
  assert.equal(describe(null).kind, 'unknown');
});
