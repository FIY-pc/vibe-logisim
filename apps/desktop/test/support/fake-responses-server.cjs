'use strict';
// A minimal OpenAI-compatible server for tests: GET /v1/models lists a few
// ids, POST /v1/responses streams one short assistant message in Responses
// API event form. Rejects any key other than the configured one so tests can
// prove the settings form reports a bad key before saving. No model turns
// with tool calls — enough for the app-server to start, list models and for
// the preflight to succeed.
const http = require('node:http');

function startFakeResponsesServer({apiKey = 'sk-test-key-0123456789', models = ['probe-chat', 'probe-mini', 'text-embedding-3-small'], reply = 'OK'} = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    requests.push({method: req.method, url: req.url, authorization: req.headers.authorization || '', body});
    const json = (status, payload) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(payload)); };
    if (req.headers.authorization !== `Bearer ${apiKey}`) return json(401, {error: {message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key'}});
    if (req.method === 'GET' && req.url === '/v1/models') return json(200, {object: 'list', data: models.map(id => ({id, object: 'model', owned_by: 'fake'}))});
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
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey, models, requests,
    close: () => new Promise(done => server.close(done)),
  })));
}
module.exports = {startFakeResponsesServer};
