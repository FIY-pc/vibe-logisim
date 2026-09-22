'use strict';

// Real app-server, synthetic Responses SSE only. No user config/auth is read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const readline = require('node:readline');
const {spawn, execFileSync} = require('node:child_process');
const {once} = require('node:events');
const {createHash} = require('node:crypto');
const catalog = require('../circuit-lens/studio/domain/circuit-plugin.json');
const {CircuitToolRegistry} = require('../electron/circuit-tools.cjs');
const {dynamicToolResponse, CODE_MODE_RESULT_CONTRACT} = require('../electron/model-tool-output.cjs');

const rawTools = catalog.tools.filter(t => t.exposure === 'direct')
  .map(({type, name, description, inputSchema}) => ({type, name, description, inputSchema}));
const registry = new CircuitToolRegistry(catalog, Object.fromEntries(catalog.tools
  .filter(tool => tool.owner === 'host').map(tool => [tool.name, () => {}])));
const outputArg = process.argv.slice(2).find(arg => !arg.startsWith('--'));
const output = outputArg ? path.resolve(outputArg) : null;
const baselineOnly = process.argv.includes('--baseline-only');
const binary = process.env.VIBE_LOGISIM_CODEX || 'codex';

function execTool(body) {
  const flatten = tools => (tools || []).flatMap(tool => tool.type === 'namespace' ? flatten(tool.tools) : [tool]);
  return [...flatten(body.tools), ...body.input.flatMap(item => flatten(item.tools))]
    .find(tool => tool.name === 'exec');
}

function toolBlock(text, name) {
  return text.split('### `' + name + '`\n')[1]?.split('\n### ')[0];
}

async function probe() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-tool-constraints-'));
  const requests = [];
  let child, lines, timer, nextId = 0, finishTurn;
  let logs = '';
  let resultProbe = false, resultProbeCalls = 0;
  const pending = new Map();
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404); response.end(); return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const id = 'fixture-' + requests.length;
    const body = requests.at(-1);
    const returned = resultProbe && body.input.find(item => item.call_id === 'json-result-fixture'
      && item.type.endsWith('tool_call_output'));
    const item = resultProbe && !returned ? {
      type:'custom_tool_call', id:'json-result-item', call_id:'json-result-fixture', name:'exec',
      input:'const raw = await tools.simulate_circuit({circuit:"main",vectors:[{inputs:{In:1},expected:{Out:1}}]}); const parsed=JSON.parse(raw); text({type:typeof raw,rawPassedMissing:raw.passed===undefined,parsed});',
    } : {type:'message', id:'reply-' + requests.length,
      role:'assistant', phase:'final_answer', content:[{type:'output_text', text:'Local constraints fixture.'}]};
    const events = [
      {type:'response.created', response:{id}},
      {type:'response.output_item.done', item},
      {type:'response.completed', response:{id, usage:{input_tokens:0, output_tokens:0, total_tokens:0}}},
    ];
    response.writeHead(200, {'Content-Type':'text/event-stream'});
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    fs.writeFileSync(path.join(root, 'config.toml'), [
      'model = "gpt-6-astra"', 'model_provider = "local_fixture"',
      '[features]', 'code_mode = true', 'code_mode_host = true',
      '[model_providers.local_fixture]', 'name = "Local constraints fixture"',
      `base_url = "http://127.0.0.1:${server.address().port}/v1"`,
      'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false',
    ].join('\n'));
    child = spawn(binary, ['app-server'], {
      cwd:root, env:{PATH:process.env.PATH, HOME:root, CODEX_HOME:root},
      stdio:['pipe','pipe','pipe'], detached:true,
    });
    child.stderr.on('data', data => { logs = (logs + data).slice(-4000); });
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId; pending.set(id, {resolve,reject}); send({id,method,params});
    });
    lines = readline.createInterface({input:child.stdout});
    lines.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.method === 'turn/completed') finishTurn?.(message.params);
      else if (message.method === 'item/tool/call' && resultProbe) {
        assert.equal(message.params.tool, 'simulate_circuit');
        resultProbeCalls++;
        // Fixed protocol data, not a claim that a native circuit was run.
        send({id:message.id, result:dynamicToolResponse({passed:1, failed:0, unchecked:0,
          unknown:null, label:'协议🙂', fixture:true})});
      }
      else if (pending.has(message.id)) {
        const p = pending.get(message.id); pending.delete(message.id);
        if (message.error) p.reject(new Error(JSON.stringify(message.error))); else p.resolve(message.result);
      } else if (message.id !== undefined && message.method) {
        // Fixed replies never ask for tools, approval or credentials.
        send({id:message.id, error:{code:-32601, message:'Unexpected fixture request'}});
      }
    });
    const turn = async (threadId, label, expectedRequests=1) => {
      const done = new Promise(resolve => { finishTurn = resolve; });
      const before = requests.length;
      await rpc('turn/start', {threadId, input:[{type:'text', text:'Local constraints transport fixture.'}]});
      const end = await done;
      assert.equal(end.turn.status, 'completed', JSON.stringify(end));
      assert.equal(requests.length, before + expectedRequests, 'fixed local response sequence');
      const body = requests.at(-1);
      if (output) fs.writeFileSync(path.join(output, label + '.request.json'), JSON.stringify(body, null, 2) + '\n');
      return body;
    };
    const start = tools => rpc('thread/start', {
      cwd:root, approvalPolicy:'never', sandbox:'danger-full-access',
      dynamicTools:tools, developerInstructions:'Local constraints transport fixture.',
    });
    const run = async () => {
      await rpc('initialize', {clientInfo:{name:'vibe-tool-constraints-test', version:'1'}, capabilities:{experimentalApi:true}});
      send({method:'initialized'});
      const before = await start(rawTools);
      const baseline = await turn(before.thread.id, 'before');
      const bodies = {before:baseline};
      if (!baselineOnly) {
        await rpc('thread/unsubscribe', {threadId:before.thread.id});
        await rpc('thread/resume', {threadId:before.thread.id, dynamicTools:registry.tools});
        bodies.resumed = await turn(before.thread.id, 'resumed');
        const fork = await rpc('thread/fork', {threadId:before.thread.id, dynamicTools:registry.tools});
        bodies.forked = await turn(fork.thread.id, 'forked');
        const after = await start(registry.tools);
        bodies.after = await turn(after.thread.id, 'after');
        resultProbe = true;
        bodies.jsonResult = await turn(after.thread.id, 'json-result', 2);
        assert.equal(resultProbeCalls, 1, 'return inspection must not rerun the expensive operation');
      }
      return bodies;
    };
    return await Promise.race([run(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native constraints replay timed out: ' + logs)), 55000);
    })]);
  } finally {
    clearTimeout(timer); lines?.close();
    if (child) {
      const exited = once(child, 'exit');
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      if (child.exitCode === null && child.signalCode === null) await exited;
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, {recursive:true, force:true});
  }
}

async function main() {
  if (output) fs.mkdirSync(output, {recursive:true});
  const bodies = await probe();
  const hash = value => createHash('sha256').update(value).digest('hex');
  const summary = {
    codex:execFileSync(binary, ['--version'], {encoding:'utf8'}).trim(), modelCalls:0,
    catalogVersion:catalog.version,
    catalogSha256:hash(fs.readFileSync(require.resolve('../circuit-lens/studio/domain/circuit-plugin.json'))),
    projectedContractSignature:registry.signature,
  };
  for (const [label, body] of Object.entries(bodies)) {
    const exec = execTool(body);
    assert.ok(exec, 'actual Responses request must use Code Mode');
    const text = exec.description;
    summary[label] = {model:body.model, execDescriptionChars:text.length,
      execDescriptionBytes:Buffer.byteLength(text), execDescriptionSha256:hash(text),
      requestJsonBytes:Buffer.byteLength(JSON.stringify(body)), requestJsonSha256:hash(JSON.stringify(body))};
    if (output) fs.writeFileSync(path.join(output, label + '.exec.txt'), text + '\n');
  }
  const before = execTool(bodies.before).description;
  const inspectBefore = toolBlock(before, 'inspect_circuit');
  const evaluateBefore = toolBlock(before, 'evaluate_circuit');
  assert.ok(inspectBefore.includes('wireLimit?: number'));
  assert.ok(!inspectBefore.includes('512'), 'recheck upstream behavior if limits now arrive natively');
  assert.ok(evaluateBefore.includes('inputEvents?: Array<'));
  assert.ok(!evaluateBefore.includes('1000'), 'recheck upstream behavior if limits now arrive natively');
  const propertyDescription = catalog.tools.find(t => t.name === 'evaluate_circuit').inputSchema.properties.inputEvents.description;
  assert.ok(evaluateBefore.includes('// ' + propertyDescription), 'existing top-level property descriptions survive as TS comments');
  summary.baseline = {wireLimitBoundVisible:false, inputEventsBoundVisible:false, propertyDescriptionVisible:true};
  if (!baselineOnly) {
    const after = execTool(bodies.after).description;
    let restored = after;
    summary.perToolAddedBytes = {};
    for (const raw of rawTools) {
      const projected = registry.tools.find(t => t.name === raw.name);
      assert.deepEqual(projected.inputSchema, raw.inputSchema);
      const suffix = projected.description.slice(raw.description.length);
      summary.perToolAddedBytes[raw.name] = Buffer.byteLength(suffix);
      if (suffix) {
        assert.ok(toolBlock(after, raw.name).includes(projected.description), 'full projected description must reach the model: ' + raw.name);
        assert.equal(toolBlock(after, raw.name).split(suffix).length - 1, 1, 'projected contract must appear once per tool');
        restored = restored.replace(projected.description, raw.description);
      }
    }
    assert.equal(restored, before, 'native declarations, property comments and all other tool text stay byte-for-byte identical');
    assert.ok(toolBlock(after, 'inspect_circuit').includes('wireLimit: integer 1..512'));
    assert.ok(toolBlock(after, 'evaluate_circuit').includes('buttonEvents, inputEvents: <=1000 items'));
    assert.ok(toolBlock(after, 'evaluate_circuit').includes('expectedRows[].values: >=1 properties'));
    assert.equal(execTool(bodies.resumed).description, before, 'record native resume retaining the original interface');
    assert.equal(execTool(bodies.forked).description, before, 'record native fork retaining the original interface');
    summary.addedExecDescriptionBytes = Buffer.byteLength(after) - Buffer.byteLength(before);
    assert.equal(summary.addedExecDescriptionBytes, Object.values(summary.perToolAddedBytes).reduce((a,b) => a+b, 0));
    summary.semantics = {schemasUnchanged:true, nativeTypesAndExistingTextUnchanged:true,
      newThreadBoundsVisible:true, resumedInterface:'initial-thread-tools', forkedInterface:'initial-thread-tools'};
    for (const tool of registry.tools) assert.ok(toolBlock(after, tool.name).includes(CODE_MODE_RESULT_CONTRACT));
    const resultItem = bodies.jsonResult.input.find(item => item.call_id === 'json-result-fixture'
      && item.type.endsWith('tool_call_output'));
    assert.ok(resultItem, 'next request must contain the actual exec output');
    const text = typeof resultItem.output === 'string' ? resultItem.output
      : resultItem.output.filter(item => item.type === 'input_text').map(item => item.text).join('');
    const proof = JSON.parse(text.slice(text.indexOf('{')));
    assert.deepEqual(proof, {type:'string',rawPassedMissing:true,
      parsed:{passed:1,failed:0,unchecked:0,unknown:null,label:'协议🙂',fixture:true}});
    summary.codeModeResult = {contractVisible:true, calls:1, ...proof};
  }
  if (output) fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
