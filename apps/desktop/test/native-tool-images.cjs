'use strict';

// Real local Codex + deterministic localhost Responses stream. No credentials,
// remote provider or model quota. Inspect what reaches the next model request,
// rather than merely checking the app-server's dynamic-tool acknowledgement.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const readline = require('node:readline');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const catalog = require('../circuit-lens/studio/domain/circuit-plugin.json');
const {CircuitToolRegistry} = require('../electron/circuit-tools.cjs');
const registry = new CircuitToolRegistry(catalog, Object.fromEntries(catalog.tools
  .filter(tool => tool.owner === 'host').map(tool => [tool.name, () => {}])));
const renderTool = registry.tools.find(tool => tool.name === 'render_circuit');
const {dynamicToolResponse, modelMediaEvidence} = require('../electron/model-tool-output.cjs');

const fixturePng = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAKUlEQVR4nGP8//8/AymAiSTVDKMaKAxWRkZG0jT8xxGhTES6hGFEawAADTwGHXfTkWsAAAAASUVORK5CYII=';
// Optional saved production result exercises candidate identity and real PNGs
// through this same protocol fixture. Never load user auth or model profiles.
const result = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  : {result:{background:'white'}, modelContentItems:[{type:'inputImage',mimeType:'image/png',imageData:fixturePng}]};
const png = result.modelContentItems[0].imageData;
const renderArgs = result.binding?.candidateId ? {candidateId:result.binding.candidateId} : {};
const completed = id => ({type:'response.completed',response:{id,usage:{input_tokens:0,output_tokens:0,total_tokens:0}}});

async function probe(code) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-native-tool-images-'));
  const requests = [];
  const rawItems = [];
  let child, lines, timer;
  let nextId = 0;
  let logs = '';
  const pending = new Map();
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.method !== 'POST' || !request.url.endsWith('/responses')) {
      response.writeHead(404); response.end(); return;
    }
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const id = 'resp-' + requests.length;
    const events = [{type:'response.created',response:{id}}];
    if (requests.length === 1) events.push({type:'response.output_item.done',item:{
      type:'custom_tool_call',call_id:'image-probe',name:'exec',input:code,
    }});
    else events.push({type:'response.output_item.done',item:{
      type:'message',id:'done',role:'assistant',content:[{type:'output_text',text:'Local protocol fixture complete.'}],
    }});
    events.push(completed(id));
    response.writeHead(200, {'Content-Type':'text/event-stream'});
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    fs.writeFileSync(path.join(root, 'config.toml'), [
      'model = "gpt-5.4"', 'model_provider = "local_fixture"',
      '[features]', 'code_mode = true', 'code_mode_host = true',
      '[model_providers.local_fixture]', 'name = "Local protocol fixture"',
      `base_url = "http://127.0.0.1:${server.address().port}/v1"`,
      'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false',
    ].join('\n'));
    child = spawn(process.env.VIBE_LOGISIM_CODEX || 'codex', ['app-server'], {
      cwd:root, env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:root},
      stdio:['pipe','pipe','pipe'], detached:true,
    });
    child.stderr.on('data', data => { logs = (logs + data).slice(-4000); });
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId; pending.set(id, {resolve,reject}); send({id,method,params});
    });
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    lines = readline.createInterface({input:child.stdout});
    lines.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.method === 'rawResponseItem/completed') { rawItems.push(message.params.item); }
      else if (message.method === 'item/tool/call') {
        assert.equal(message.params.tool, 'render_circuit');
        assert.deepEqual(message.params.arguments, renderArgs);
        send({id:message.id,result:dynamicToolResponse(result)});
      } else if (message.method === 'turn/completed') finish(message.params);
      else if (pending.has(message.id)) {
        const p = pending.get(message.id); pending.delete(message.id);
        if (message.error) p.reject(new Error(JSON.stringify(message.error))); else p.resolve(message.result);
      }
    });
    const run = async () => {
      await request('initialize', {clientInfo:{name:'vibe-native-image-test',version:'1'},capabilities:{experimentalApi:true}});
      send({method:'initialized'});
      const started = await request('thread/start', {
        cwd:root,ephemeral:true,experimentalRawEvents:true,approvalPolicy:'never',sandbox:'danger-full-access',
        dynamicTools:[{name:renderTool.name,description:renderTool.description,inputSchema:renderTool.inputSchema}],
      });
      await request('turn/start', {threadId:started.thread.id,input:[{type:'text',text:'Local image transport test'}]});
      const end = await done;
      assert.equal(end.turn.status, 'completed', JSON.stringify(end));
      assert.equal(requests.length, 2);
      const flatten = tools => (tools || []).flatMap(tool => tool.type === 'namespace' ? flatten(tool.tools) : [tool]);
      const visibleTools = [...flatten(requests[0].tools), ...requests[0].input.flatMap(item => flatten(item.tools))];
      // Native model catalogs may expose the same callable separately or inline
      // its declaration under exec. In either case the actual request must carry
      // the complete production description, including the image exception.
      const contractCarrier = visibleTools.find(tool => ['exec', renderTool.name].includes(tool.name)
        && tool.description?.includes(renderTool.description));
      assert.ok(contractCarrier, 'actual projected image contract must reach the model request');
      return {output:requests[1].input.find(item => item.call_id === 'image-probe' && item.type.endsWith('tool_call_output')),
        rawItems, contractCarrier:contractCarrier.name};
    };
    return await Promise.race([run(),new Promise((_,reject) => {
      timer = setTimeout(() => reject(new Error('Native image probe timed out: '+logs)), 45000);
    })]);
  } finally {
    clearTimeout(timer); lines?.close();
    if (child) {
      const exited = once(child, 'exit');
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      if (child.exitCode === null && child.signalCode === null) await exited;
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, {recursive:true,force:true});
  }
}

(async () => {
  const rawProbe = await probe(`text(await tools.render_circuit(${JSON.stringify(renderArgs)}));`);
  const raw = rawProbe.output;
  assert.ok(raw, 'missing Code Mode output');
  assert.equal(JSON.stringify(raw).includes(png), true, 'reproduce base64 in text');
  assert.equal(Array.isArray(raw.output) && raw.output.some(item => item.type === 'input_image'), false);
  const recipe = renderTool.description.match(/```javascript\n([\s\S]+?)\n```/)?.[1];
  assert.ok(recipe, 'tool catalog must explain native Code Mode image delivery');
  const fixedProbe = await probe(recipe.replace('tools.render_circuit({})', `tools.render_circuit(${JSON.stringify(renderArgs)})`));
  const fixed = fixedProbe.output;
  const rawEvidence = rawProbe.rawItems.map(modelMediaEvidence).filter(Boolean);
  const fixedEvidence = fixedProbe.rawItems.map(modelMediaEvidence).filter(Boolean);
  assert.ok(rawEvidence.some(item => item.base64TextItems > 0 && item.imageItems === 0));
  assert.ok(fixedEvidence.some(item => item.imageItems === 1 && item.base64TextItems === 0));
  assert.equal(JSON.stringify(fixedEvidence).includes(png), false);
  const content = fixed.output;
  assert.ok(Array.isArray(content), JSON.stringify(fixed));
  assert.equal(content.filter(item => item.type === 'input_image').length, 1, JSON.stringify(fixed).slice(0,2000));
  assert.equal(content.find(item => item.type === 'input_image').image_url, 'data:image/png;base64,' + png);
  assert.equal(content.filter(item => item.type === 'input_text').some(item => item.text.includes(png)), false);
  if (renderArgs.candidateId) {
    const metadata = content.filter(item => item.type === 'input_text').map(item => item.text).join('\n');
    assert.ok(metadata.includes(renderArgs.candidateId));
    assert.ok(metadata.includes(result.binding.artifactSha256));
    assert.ok(metadata.includes(result.binding.baseRevisionId));
  }
  const summary = {rawEvidence,fixedEvidence,nativeCodeMode:true,rawTextLeaksBase64:true,explicitImageEmission:true,
    base64InFixedText:false,modelTurns:0,candidateId:renderArgs.candidateId || null,artifactSha256:result.binding?.artifactSha256 || null,
    exactPngPreserved:true,catalogVersion:catalog.version,projectedContractSignature:registry.signature,
    projectedDescriptionVisible:true,descriptionCarrier:fixedProbe.contractCarrier};
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify(summary));
})().catch(error => { console.error(error); process.exitCode = 1; });
