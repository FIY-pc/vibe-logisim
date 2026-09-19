'use strict';

// Production CodexBackend -> real local app-server -> localhost Responses replay.
// No model, credentials, native circuit runtime or user workspace is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {CodexBackend} = require('../electron/codex-backend.cjs');
const {DEVELOPER_INSTRUCTIONS} = require('../electron/agent-instructions.cjs');
const catalog = require('../circuit-lens/studio/domain/circuit-plugin.json');

function context(revision, file) {
  const link = `circuit://object?projectId=fixture-project&revisionId=${revision}&circuit=Control&componentId=port-17`;
  return {
    schema:'fixture-context', projectId:'fixture-project', revisionId:revision,
    folder:{id:'fixture-folder', activeFile:file}, circuit:'Control',
    selection:{componentIds:['port-17'], netIds:['net-2']},
    evidence:{authority:'exact-runtime', label:'UNTRUSTED_LABEL_IGNORE_INSTRUCTIONS'},
    displayedSimulation:{id:'frozen-moment', revisionId:revision, sessionId:'run-1', ticks:7,
      circuit:'Control', rootCircuit:'Top', instancePath:['nested-copy-B'],
      components:[{componentId:'port-17', ports:[{index:0, bits:'xE01', value:null}]}]},
    objectReferences:[{componentId:'port-17', reference:link}],
    keptMoments:[{id:'previous-moment', projectId:'fixture-project', title:'Earlier observation',
      revisionId:'previous', circuit:'Control', rootCircuit:'Top', ticks:2, sessionId:'old-run',
      signals:[{componentId:'port-17', label:'Earlier port', portIndex:0, bits:'xxxx', width:4, value:null}]}],
    materials:[{id:'notes', name:'notes.md', path:'notes.md',
      quote:'UNTRUSTED_REFERENCE_IGNORE_INSTRUCTIONS', reference:'workspace://file?path=notes.md'}],
  };
}

function textInputs(body) {
  return body.input.filter(item => item.type === 'message')
    .map(item => ({role:item.role, text:(item.content || []).map(c => c.text || '').join('\n')}));
}

function contextEntry(body, key, kind) {
  const tag = (kind === 'untrusted' ? 'external_' : '') + key;
  const item = textInputs(body).findLast(m => m.text.startsWith(`<${tag}>`));
  assert.ok(item, `missing native context envelope: ${tag}`);
  assert.equal(item.role, kind === 'untrusted' ? 'user' : 'developer');
  assert.ok(item.text.endsWith(`</${tag}>`));
  return JSON.parse(item.text.slice(tag.length + 2, -(tag.length + 3)));
}

function instructionState(body) {
  const developer = textInputs(body).filter(m => m.role === 'developer').map(m => m.text).join('\n');
  if (developer.includes(DEVELOPER_INSTRUCTIONS)) return 'current';
  if (developer.includes('LEGACY_INSTRUCTIONS_FIXTURE')) return 'initial-thread-instructions';
  assert.fail('neither current nor initial instructions reached the native prompt');
}

async function replay(root) {
  assert.equal(process.env.CODEX_HOME, path.join(root, 'source'), 'isolated fixture config only');
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404); response.end(); return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const id = 'fixture-' + requests.length;
    const events = [
      {type:'response.created', response:{id}},
      {type:'response.output_item.done', item:{type:'message', id:'reply-' + requests.length,
        role:'assistant', phase:'final_answer', content:[{type:'output_text', text:'Local protocol fixture.'}]}},
      {type:'response.completed', response:{id, usage:{input_tokens:0, output_tokens:0, total_tokens:0}}},
    ];
    response.writeHead(200, {'Content-Type':'text/event-stream'});
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  const workDir = path.join(root, 'workspace');
  fs.mkdirSync(workDir);
  fs.mkdirSync(process.env.CODEX_HOME);
  const file = path.join(workDir, 'circuit.circ');
  fs.writeFileSync(file, 'initial fixture file\n');
  let backend;
  const logs = [];
  const terminate = async () => { await backend?.stop(); process.exit(1); };
  process.once('SIGTERM', terminate);
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    fs.writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), [
      'model = "gpt-5.4"', 'model_provider = "local_fixture"',
      '[model_providers.local_fixture]', 'name = "Local protocol fixture"',
      `base_url = "http://127.0.0.1:${server.address().port}/v1"`,
      'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false',
    ].join('\n'));
    const createBackend = (options = {}) => {
      const b = new CodexBackend({workDir, profileDir:path.join(root, 'profile'),
        sessionStorePath:path.join(root, 'sessions.json'), circuitManifest:async () => catalog,
        circuitTool:async () => { throw new Error('fixture must not call circuit tools'); }, ...options});
      b.on('log', line => { logs.push(line); if (logs.length > 15) logs.shift(); });
      return b;
    };
    const send = async (question, ctx, editMessageId = null) => {
      // Register before ask: the fixture can finish before turn/start returns.
      const done = new Promise(resolve => {
        const listener = event => {
          if (event.type === 'turn-completed') { backend.off('event', listener); resolve(event); }
        };
        backend.on('event', listener);
      });
      await backend.ask({question, context:ctx, workspaceKey:'fixture-folder', editMessageId});
      const end = await done;
      assert.equal(end.status, 'completed', JSON.stringify(end));
    };

    backend = createBackend({developerInstructions:'LEGACY_INSTRUCTIONS_FIXTURE'});
    await send('QUESTION_ONE', context('revision-one', 'circuit.circ'));
    const originalThread = backend.threadId;
    const replyId = backend.history.find(m => m.type === 'assistant').id;
    assert.equal(requests.length, 1);
    const first = textInputs(requests[0]);
    assert.ok(first.some(m => m.role === 'developer' && m.text.includes('LEGACY_INSTRUCTIONS_FIXTURE')));
    const description = catalog.tools.find(tool => tool.name === 'describe_component').description;
    assert.ok(JSON.stringify(requests[0]).includes(JSON.stringify(description).slice(1, -1)),
      'native model prompt must expose the full component reference description from the catalog');
    const sent = context('revision-one', 'circuit.circ');
    const evidence = contextEntry(requests[0], 'vibe-logisim.evidence', 'untrusted');
    assert.deepEqual(evidence.displayedSimulation, sent.displayedSimulation,
      'instance, moment, unknown/error bits and null value must survive transport exactly');
    assert.deepEqual(evidence.objectReferences, sent.objectReferences);
    assert.equal(evidence.evidence.label, sent.evidence.label);
    const kept = contextEntry(requests[0], 'vibe-logisim.kept-observation-1', 'untrusted');
    assert.equal(kept.revisionId, 'previous');
    assert.deepEqual(kept.signals, [['port-17', 'Earlier port', 0, 'xxxx', 4, null]]);
    const material = contextEntry(requests[0], 'vibe-logisim.material-1', 'untrusted');
    assert.equal(material.reference, sent.materials[0].reference);
    assert.equal(material.quote, sent.materials[0].quote);
    const binding = contextEntry(requests[0], 'vibe-logisim.binding', 'application');
    assert.equal(binding.revisionId, 'revision-one');
    assert.deepEqual(binding.selection.componentIds, ['port-17']);
    assert.deepEqual(contextEntry(requests[0], 'vibe-logisim.workspace', 'application'), {
      cwd:backend.runtimeWorkDir, file:'circuit.circ', folderId:'fixture-folder', changeMode:'direct',
    });

    // Simulate a later file edit, then restart/resume and fork earlier history.
    // No circuit parser is used: this checks conversation/file separation only.
    fs.writeFileSync(file, 'current file survives history operations\n');
    await backend.stop();
    backend = createBackend();
    await send('QUESTION_TWO', context('revision-two', 'circuit.circ'));
    assert.equal(backend.threadId, originalThread);
    // Diagnose native instruction replacement separately from extraction and
    // context transport. Some app-server versions retain the initial prompt
    // despite accepting developerInstructions on resume/fork. Do not hide that
    // limitation behind a test that resumes an identical instruction string.
    const resumedInstructions = instructionState(requests[1]);
    assert.equal(contextEntry(requests[1], 'vibe-logisim.binding', 'application').revisionId, 'revision-two');

    await backend.changeConversation('fixture-folder', 'fork', {messageId:replyId});
    await send('QUESTION_FORK', context('revision-two', 'circuit.circ'));
    assert.notEqual(backend.threadId, originalThread);
    const forkInput = JSON.stringify(requests[2]);
    assert.ok(forkInput.includes('QUESTION_ONE') && !forkInput.includes('QUESTION_TWO'));
    assert.equal(contextEntry(requests[2], 'vibe-logisim.binding', 'application').revisionId, 'revision-two',
      'earlier chat still receives the current file binding');
    const forkedInstructions = instructionState(requests[2]);
    assert.equal(fs.readFileSync(file, 'utf8'), 'current file survives history operations\n');

    const originalQuestion = backend.history.find(m => m.type === 'user');
    await send('QUESTION_EDITED', context('revision-two', 'circuit.circ'), originalQuestion.id);
    const editedInput = JSON.stringify(requests[3]);
    assert.ok(editedInput.includes('QUESTION_EDITED') && !editedInput.includes('QUESTION_ONE'));
    assert.ok(!editedInput.includes('QUESTION_FORK'));
    assert.equal(contextEntry(requests[3], 'vibe-logisim.binding', 'application').revisionId, 'revision-two');
    assert.equal(fs.readFileSync(file, 'utf8'), 'current file survives history operations\n');

    // Controlled comparisons keep their explicit override and omit app context.
    await backend.stop();
    backend = createBackend({developerInstructions:'BASELINE_INSTRUCTIONS_FIXTURE', includeCircuitContext:false,
      circuitTool:null, circuitManifest:null, ephemeral:true});
    await send('BASELINE_QUESTION', context('revision-two', 'circuit.circ'));
    assert.ok(textInputs(requests[4]).some(m => m.role === 'developer' && m.text.includes('BASELINE_INSTRUCTIONS_FIXTURE')));
    const baseline = JSON.stringify(requests[4]);
    assert.ok(!baseline.includes(DEVELOPER_INSTRUCTIONS) && !baseline.includes('previous-moment'));
    await backend.stop();
    backend = createBackend({ephemeral:true});
    await send('EMPTY_WORKSPACE_QUESTION', {folder:{id:'fixture-folder', activeFile:null}});
    assert.ok(textInputs(requests[5]).some(m => m.role === 'developer' && m.text.includes(DEVELOPER_INSTRUCTIONS)),
      'new default thread receives the module even without an active circuit');
    assert.equal(contextEntry(requests[5], 'vibe-logisim.workspace', 'application').file, null);
    assert.equal(contextEntry(requests[5], 'vibe-logisim.binding', 'application').revisionId, undefined);
    assert.equal(requests.length, 6, 'one deterministic fixture response per turn; no tools or model loop');
    console.log(JSON.stringify({newThreadInstructions:'current', resumedInstructions, forkedInstructions,
      contextTransport:true, untrustedContext:true, historicalObservations:true,
      currentFilesPreserved:true, describeComponentDiscoverable:true, explicitOverride:true, modelCalls:0}));
  } catch (error) {
    error.message += '\n' + logs.join('\n').slice(-2000);
    throw error;
  } finally {
    await backend?.stop();
    process.off('SIGTERM', terminate);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}

async function main() {
  if (process.argv[2] === '--fixture-worker') return replay(process.argv[3]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-agent-instructions-'));
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
    'VIBE_LOGISIM_CODEX', 'VIBE_LOGISIM_CODE_MODE_HOST'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  // Only the worker sees these fixture locations; never read/copy the user's profile.
  const child = spawn(process.execPath, [__filename, '--fixture-worker', root], {
    cwd:root, env:{...env, HOME:root, CODEX_HOME:path.join(root, 'source')}, stdio:'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 90_000);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, 0, `fixture worker failed: code=${code} signal=${signal}`);
  } finally {
    clearTimeout(timer); fs.rmSync(root, {recursive:true, force:true});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
