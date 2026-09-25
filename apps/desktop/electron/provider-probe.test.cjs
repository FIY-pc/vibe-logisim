'use strict';
const {test, after} = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http');
const {discoverModels, testResponses, ProbeError} = require('./provider-probe.cjs');

// One fake OpenAI-compatible server; each test picks a behaviour by path prefix.
const requests = [];
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
  requests.push({method: req.method, url: req.url, auth: req.headers.authorization, body});
  const [, scenario, ...rest] = req.url.split('/'); const route = '/' + rest.join('/');
  const json = (status, payload) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(payload)); };
  const sse = events => { res.writeHead(200, {'Content-Type': 'text/event-stream'}); for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); res.end(); };
  if (scenario === 'ok') {
    if (route === '/v1/models') return json(200, {object: 'list', data: [{id: 'gpt-x'}, {id: 'text-embedding-3-large'}, {id: 'whisper-1'}, {id: 'deepseek-chat'}, {id: 'dall-e-3'}, {id: 'bad id with spaces'}]});
    if (route === '/v1/responses') return sse([{type: 'response.created', response: {id: 'r1'}}, {type: 'response.output_text.delta', delta: 'OK'}, {type: 'response.completed', response: {id: 'r1'}}]);
  }
  if (scenario === 'nolist') {
    if (route === '/v1/models') return json(404, {error: {message: 'Not Found'}});
    if (route === '/v1/responses') return sse([{type: 'response.completed', response: {id: 'r2'}}]);
  }
  if (scenario === 'badkey') return json(401, {error: {message: 'Incorrect API key provided'}});
  if (scenario === 'chatonly') { if (route === '/v1/responses') { res.writeHead(404, {'Content-Type': 'text/html'}); return res.end('<html><body>404 page not found</body></html>'); } return json(200, {data: [{id: 'm'}]}); }
  if (scenario === 'nomodel') return json(400, {error: {message: 'The model `nope-1` does not exist or you do not have access to it.', code: 'model_not_found'}});
  if (scenario === 'nomodel404') return json(404, {error: {message: 'model nope-1 not found', type: 'invalid_request_error'}});
  if (scenario === 'reasoning') return json(400, {error: {message: "Unsupported parameter: 'reasoning.effort' is not supported with this model."}});
  if (scenario === 'jsonbody') return json(200, {id: 'chatcmpl-1', object: 'chat.completion', choices: [{message: {content: 'OK'}}]});
  if (scenario === 'streamerror') return sse([{type: 'response.created', response: {id: 'r3'}}, {type: 'error', error: {message: 'upstream exploded'}}]);
  if (scenario === 'ratelimit') return json(429, {error: {message: 'Rate limit reached'}});
  if (scenario === 'down') return json(502, {error: {message: 'Bad gateway'}});
  if (scenario === 'slow') return setTimeout(() => json(200, {data: []}), 1500);
  json(500, {error: {message: 'unexpected route ' + req.url}});
});
const ready = new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = async scenario => { await ready; return `http://127.0.0.1:${server.address().port}/${scenario}/v1`; };
after(() => server.close());

test('discoverModels lists chat models, drops embeddings/audio/image ids and malformed ids', async () => {
  const result = await discoverModels({baseUrl: await base('ok'), apiKey: 'sk-test'});
  assert.deepEqual(result.models, ['deepseek-chat', 'gpt-x']);
  assert.equal(result.filtered, 3);
  assert.equal(requests.at(-1).auth, 'Bearer sk-test');
  assert.equal(requests.at(-1).url, '/ok/v1/models');
});

test('discoverModels returns null when the endpoint has no model list, throws on a bad key', async () => {
  assert.equal(await discoverModels({baseUrl: await base('nolist'), apiKey: 'k'}), null);
  await assert.rejects(discoverModels({baseUrl: await base('badkey'), apiKey: 'k'}), error => error instanceof ProbeError && error.code === 'auth' && /密钥/.test(error.message) && /Incorrect API key/.test(error.hint));
});

test('testResponses sends a Codex-shaped streamed request and accepts an SSE completion', async () => {
  const result = await testResponses({baseUrl: await base('ok'), apiKey: 'sk-test', model: 'gpt-x', effort: 'high'});
  assert.equal(result.ok, true); assert.equal(result.sample, 'OK');
  const sent = requests.at(-1);
  assert.equal(sent.url, '/ok/v1/responses'); assert.equal(sent.method, 'POST');
  assert.equal(sent.body.model, 'gpt-x'); assert.equal(sent.body.stream, true); assert.equal(sent.body.store, false);
  assert.deepEqual(sent.body.reasoning, {effort: 'high'}); assert.deepEqual(sent.body.include, ['reasoning.encrypted_content']);
  assert.equal(sent.body.input[0].content[0].type, 'input_text');
  await testResponses({baseUrl: await base('ok'), apiKey: 'k', model: 'gpt-x', effort: 'none'});
  assert.deepEqual(requests.at(-1).body.reasoning, {});
  // A stream that completes without text deltas is still a working endpoint.
  assert.equal((await testResponses({baseUrl: await base('nolist'), apiKey: 'k', model: 'm'})).ok, true);
});

test('testResponses turns provider failures into student-facing codes', async () => {
  const code = async (scenario, extra = {}) => { try { await testResponses({baseUrl: await base(scenario), apiKey: 'k', model: 'nope-1', timeoutMs: 400, ...extra}); return 'ok'; } catch (error) { assert.ok(error instanceof ProbeError, String(error)); return error; } };
  const chatOnly = await code('chatonly'); assert.equal(chatOnly.code, 'protocol'); assert.match(chatOnly.hint, /Responses API/); assert.doesNotMatch(chatOnly.hint, /<html>/);
  assert.equal((await code('nomodel')).code, 'model'); assert.match((await code('nomodel')).message, /nope-1/);
  assert.equal((await code('nomodel404')).code, 'model');
  assert.equal((await code('reasoning')).code, 'reasoning');
  assert.equal((await code('jsonbody')).code, 'protocol');
  const streamError = await code('streamerror'); assert.equal(streamError.code, 'protocol'); assert.match(streamError.message, /upstream exploded/);
  assert.equal((await code('badkey')).code, 'auth');
  assert.equal((await code('ratelimit')).code, 'rate-limit');
  assert.equal((await code('down')).code, 'server'); assert.match((await code('down')).message, /502/);
  const slow = await code('slow'); assert.equal(slow.code, 'timeout'); assert.match(slow.message, /秒没有响应/);
  const refused = await code('x', {baseUrl: 'http://127.0.0.1:9/v1'}); assert.equal(refused.code, 'network'); assert.match(refused.message, /连接|接口/);
  const unknownHost = await code('x', {baseUrl: 'https://definitely-not-a-real-host.invalid/v1'}); assert.equal(unknownHost.code, 'network');
});
