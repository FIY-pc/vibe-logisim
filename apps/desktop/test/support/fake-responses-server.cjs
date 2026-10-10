'use strict';
// A minimal OpenAI-compatible server for tests: GET /v1/models lists a few
// ids, POST /v1/responses streams one short assistant message in Responses
// API event form. Rejects any key other than the configured one so tests can
// prove the settings form reports a bad key before saving. No model turns
// with tool calls — enough for the app-server to start, list models and for
// the preflight to succeed.
//
// `viaProxy: true` additionally starts a logging HTTP forward proxy and
// returns a baseUrl on a `.invalid` hostname that only the proxy can resolve
// (it maps *.invalid to loopback). Anything that reaches the fake through
// that baseUrl therefore *proves* the caller used the proxy; the proxy log
// records method, URL and User-Agent so the app's own probe (Chromium UA) and
// the Codex child (reqwest UA) can be told apart. CONNECT to other hosts is
// refused with 403 so a sandboxed test never opens real outbound sockets.
const http = require('node:http'), net = require('node:net'), {URL} = require('node:url');

function startLoggingProxy() {
  const log = [];
  const mapHost = host => host.endsWith('.invalid') ? '127.0.0.1' : null;
  const server = http.createServer((req, res) => {
    let url; try { url = new URL(req.url); } catch { res.writeHead(400); return res.end('absolute-form URI required'); }
    const host = mapHost(url.hostname);
    log.push({kind: 'absolute', method: req.method, url: req.url, userAgent: req.headers['user-agent'] || ''});
    if (!host) { res.writeHead(403, {'Content-Type': 'text/plain'}); return res.end('test proxy only forwards *.invalid'); }
    const headers = {...req.headers}; delete headers['proxy-connection']; delete headers['proxy-authorization'];
    const upstream = http.request({host, port: url.port || 80, path: url.pathname + url.search, method: req.method, headers}, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('error', error => { res.writeHead(502); res.end(error.message); });
    req.pipe(upstream);
  });
  server.on('connect', (req, socket, head) => {
    const [hostname, port] = req.url.split(':');
    const host = mapHost(hostname);
    log.push({kind: 'connect', method: 'CONNECT', url: req.url, userAgent: req.headers['user-agent'] || ''});
    if (!host) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const upstream = net.connect(Number(port) || 443, host, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head?.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
    upstream.on('error', () => socket.end()); socket.on('error', () => upstream.end());
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, log,
    close: () => new Promise(done => server.close(done)),
  })));
}

function startFakeResponsesServer({apiKey = 'sk-test-key-0123456789', models = ['probe-chat', 'probe-mini', 'text-embedding-3-small'], reply = 'OK', viaProxy = false} = {}) {
  const requests = [];
  let modelListStatus = 200;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    requests.push({method: req.method, url: req.url, authorization: req.headers.authorization || '', userAgent: req.headers['user-agent'] || '', body});
    const json = (status, payload) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(payload)); };
    if (req.headers.authorization !== `Bearer ${apiKey}`) return json(401, {error: {message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key'}});
    if (req.method === 'GET' && req.url === '/v1/models') return modelListStatus === 200
      ? json(200, {object: 'list', data: models.map(id => ({id, object: 'model', owned_by: 'fake'}))})
      : json(modelListStatus, {error: {message: 'Model list temporarily unavailable'}});
    if (req.method === 'POST' && req.url === '/v1/responses') {
      if (!models.includes(body?.model)) return json(400, {error: {message: `The model \`${body?.model}\` does not exist or you do not have access to it.`, type: 'invalid_request_error', code: 'model_not_found'}});
      const id = 'resp_' + Date.now(), item = 'msg_' + Date.now();
      res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'});
      const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({type: 'response.created', response: {id, object: 'response', status: 'in_progress', output: []}});
      send({type: 'response.output_item.added', output_index: 0, item: {type: 'message', id: item, role: 'assistant', status: 'in_progress', content: []}});
      send({type: 'response.content_part.added', output_index: 0, item_id: item, content_index: 0, part: {type: 'output_text', text: ''}});
      send({type: 'response.output_text.delta', output_index: 0, item_id: item, content_index: 0, delta: reply});
      send({type: 'response.output_text.done', output_index: 0, item_id: item, content_index: 0, text: reply});
      send({type: 'response.content_part.done', output_index: 0, item_id: item, content_index: 0, part: {type: 'output_text', text: reply}});
      send({type: 'response.output_item.done', output_index: 0, item: {type: 'message', id: item, role: 'assistant', status: 'completed', content: [{type: 'output_text', text: reply}]}});
      send({type: 'response.completed', response: {id, object: 'response', status: 'completed', output: [{type: 'message', id: item, role: 'assistant', status: 'completed', content: [{type: 'output_text', text: reply}]}], usage: {input_tokens: 10, output_tokens: 2, total_tokens: 12}}});
      return res.end();
    }
    json(404, {error: {message: `no route ${req.method} ${req.url}`}});
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const proxy = viaProxy ? await startLoggingProxy() : null;
    resolve({
      baseUrl: proxy ? `http://fake-responses.invalid:${port}/v1` : `http://127.0.0.1:${port}/v1`,
      directBaseUrl: `http://127.0.0.1:${port}/v1`, apiKey, models, requests, proxy,
      setModelListStatus: status => { modelListStatus = status; },
      close: async () => { await new Promise(done => server.close(done)); if (proxy) await proxy.close(); },
    });
  }));
}
module.exports = {startFakeResponsesServer, startLoggingProxy};
