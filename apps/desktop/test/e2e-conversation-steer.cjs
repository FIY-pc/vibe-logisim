'use strict';

// Real Electron mouse/keyboard, IPC, circuit selection, references and drafts.
// Only Codex startup, ask and interrupt are local replay. The production
// snapshot() computes busy/canSteer/turnId from the replay's backend fields,
// with a temporary alive marker solely for its connection-presence check.
// This file is also the Electron entry point, so interception happens before
// startup can read a Codex profile or spawn a model process. No auth is copied.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const repo = path.resolve(__dirname, '../../..');

function installReplay() {
  const {ipcMain, dialog} = require('electron');
  const {CodexBackend} = require('../electron/codex-backend.cjs');
  const replay = global.__steerReplay = {rawRequests:[], requests:[], events:[], interrupts:[], turnStarts:0, rejectNext:false};
  dialog.showErrorBox = (title, message) => console.error('[steer-ui-replay] startup error:', title, message);
  const snapshot = CodexBackend.prototype.snapshot;
  CodexBackend.prototype.snapshot = function() {
    assert.equal(this.child, null, 'No real Codex child is permitted in this UI replay');
    this.child = {uiReplayAliveMarker:true};
    try {return snapshot.call(this);}
    finally {this.child = null;}
  };
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => handle(channel, channel === 'vibe-logisim:agent-ask'
    ? (event, request) => {replay.rawRequests.push(structuredClone(request)); return listener(event, request);}
    : listener);
  replay.emit = event => {replay.events.push(structuredClone(event)); replay.backend.emit('event', event);};
  replay.status = () => {
    const {messages, ...state} = replay.backend.snapshot();
    replay.emit({type:'status', ...state});
  };
  replay.finish = status => {
    const backend = replay.backend, turnId = backend.activeTurnId;
    backend.activeTurnId = null; backend.pendingTurn = null; backend.finalizing = false; backend.turnStarting = false;
    backend.status = 'ready'; replay.status();
    replay.emit({type:'turn-completed', turnId, status});
  };
  CodexBackend.prototype.start = async function() {
    replay.backend = this; this.status = 'ready';
    this.statusDetail = null; replay.status();
    return this.snapshot();
  };
  CodexBackend.prototype.ask = async function(request) {
    replay.requests.push(structuredClone(request));
    const steering = request.expectedTurnId != null;
    if (steering && (!this.snapshot().canSteer || request.expectedTurnId !== this.activeTurnId))
      throw new Error('本地回放：目标回合已结束，未创建新回合');
    if (replay.rejectNext) {
      replay.rejectNext = false;
      throw new Error('本地回放：追加暂时失败');
    }
    assert.equal(this.child, null, 'UI replay must never start Codex');
    if (!steering) {
      assert.equal(this.snapshot().busy, false);
      this.threadId = 'local-steer-ui-thread';
      this.activeTurnId = 'local-steer-ui-turn-' + ++replay.turnStarts;
      this.pendingTurn = {threadId:this.threadId, turnId:this.activeTurnId};
      this.status = 'busy';
    }
    const context = request.context;
    const message = {type:'user', id:'local-steer-ui-user-' + replay.requests.length, text:request.question,
      context:{folderId:context.folder.id, projectId:context.projectId, circuit:context.circuit,
        observationId:context.displayedSimulation?.id, materials:context.materials,
        moments:(context.keptMoments || []).map(m => ({id:m.id, title:m.title, projectId:m.projectId})),
        ...(steering ? {turnContinuation:true} : {})}};
    this.history.push(message);
    this.conversations.remember(request.workspaceKey, {threadId:this.threadId, messages:this.history,
      messageId:message.id, context:message.context});
    replay.emit({type:'conversations-changed', workspaceKey:request.workspaceKey, ...this.conversations.state(request.workspaceKey)});
    replay.emit({...message, type:'user-message'});
    if (!steering) {
      replay.status();
      replay.emit({type:'turn-started', turnId:this.activeTurnId});
      replay.emit({type:'activity', itemId:'local-tool-' + replay.turnStarts, kind:'tool',
        activityKey:'local:inspect', label:'本地回放：读取电路', status:'running', turnId:this.activeTurnId});
    }
    return {threadId:this.threadId, turnId:this.activeTurnId, ...(steering ? {steered:true} : {})};
  };
  CodexBackend.prototype.interrupt = async function() {
    replay.interrupts.push(this.activeTurnId);
    if (!this.activeTurnId) return {interrupted:false};
    replay.finish('interrupted');
    return {interrupted:true};
  };
}

async function run() {
  const {_electron} = require('playwright');
  const {waitUntil} = require('./support/wait-until.cjs');
  const {simulationMenu} = require('./support/simulation-menu.cjs');
  const runs = path.join(os.homedir(), '.local/share/vibe-logisim-dev/runs');
  fs.mkdirSync(runs, {recursive:true});
  const root = fs.mkdtempSync(path.join(runs, 'conversation-steer-'));
  const folder = path.join(root, '电路工作区');
  fs.mkdirSync(folder);
  const source = path.join(folder, 'steer.circ');
  const xml = '<project source="2.16.2.2.jar" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/><circuit name="main"><comp lib="0" name="Pin" loc="(100,150)"><a name="label" val="A"/></comp><comp lib="0" name="Pin" loc="(300,150)"><a name="output" val="true"/><a name="facing" val="west"/><a name="label" val="Y"/></comp><wire from="(100,150)" to="(300,150)"/></circuit></project>';
  fs.writeFileSync(source, xml);
  fs.writeFileSync(path.join(folder, '任务说明.md'), '本地界面验收资料：请保留 A 到 Y 的连线。');
  const env = {...process.env, XDG_CONFIG_HOME:path.join(root, 'config'),
    VIBE_LOGISIM_STATE_DIR:path.join(root, 'state'), VIBE_LOGISIM_CODEX:path.join(root, 'no-model-executable')};
  delete env.ELECTRON_RUN_AS_NODE;
  let app, page, phase = 'launch', releaseSelection;
  const errors = [], checks = [], snapshots = [];
  const state = () => page.evaluate(() => window.vibeDesktop.agent.getState());
  const replay = () => app.evaluate(() => ({requests:global.__steerReplay.requests,
    rawRequests:global.__steerReplay.rawRequests, events:global.__steerReplay.events,
    interrupts:global.__steerReplay.interrupts, turnStarts:global.__steerReplay.turnStarts,
    childStarted:Boolean(global.__steerReplay.backend.child)}));
  const shot = name => page.screenshot({path:path.join(root, name + '.png')});
  async function writeDraft(text) {
    await page.locator('#questionInput').click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText(text);
  }
  async function findPin(label) {
    await page.locator('#findObject').click();
    await page.locator('#finderInput').fill(label + ' Pin');
    await page.locator('#finderInput').press('Enter');
    await page.locator('.circuit-component.is-selected').waitFor();
  }
  async function attachReferences({capture = false} = {}) {
    await page.locator('.file-row').filter({hasText:'任务说明.md'}).click();
    await page.locator('.material-text').waitFor();
    await page.locator('#materialQuote').click();
    await page.locator('.material-chip').waitFor();
    if (capture) {
      await simulationMenu(page, 'simulationStart');
      await waitUntil(() => page.locator('#momentCapture').isEnabled(), {label:'native observation ready'});
      await simulationMenu(page, 'momentCapture');
    } else {
      await simulationMenu(page, 'momentOpen');
      await page.locator('#momentList .moment-title').first().click();
      await page.locator('#momentAttach').click();
    }
    await page.locator('.moment-chip').waitFor();
  }
  async function sent(count) {
    await waitUntil(async () => (await replay()).requests.length === count, {label:'local replay request ' + count});
  }
  async function cleared() {
    await page.waitForFunction(() => document.querySelector('#questionInput').value === '' &&
      !document.querySelector('.material-chip') && !document.querySelector('.moment-chip'));
  }
  function contextIn(request, target) {
    assert.equal(request.expectedTurnId, target);
    assert.equal(request.context.materials.length, 1);
    assert.match(request.context.materials[0].name, /任务说明/);
    assert.equal(request.context.keptMoments.length, 1);
    assert.ok(request.context.selectionId);
  }
  try {
    app = await _electron.launch({executablePath:require('electron'), args:[__filename, source, '--no-sandbox', '--ozone-platform=x11', '--disable-gpu'], cwd:repo, env, timeout:30000});
    app.process().stderr.on('data', data => fs.appendFileSync(path.join(root, 'electron.log'), data));
    page = await app.firstWindow({timeout:30000});
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.stack));
    await page.setViewportSize({width:1500, height:960});
    await page.waitForFunction(() => document.querySelector('#canvasStatus')?.hidden &&
      !document.querySelector('#questionInput').disabled && document.querySelector('#questionInput').dataset.conversationId);
    await waitUntil(async () => (await state()).status === 'ready', {label:'local ready snapshot'});

    phase = 'idle send and empty busy composer';
    await writeDraft('本地回放：开始查看电路');
    await page.locator('#askButton').click();
    await sent(1); await cleared();
    const active = await state(), target = active.turnId;
    snapshots.push(active);
    assert.ok(target); assert.equal(active.busy, true); assert.equal(active.canSteer, true);
    assert.equal((await replay()).rawRequests[0].expectedTurnId, undefined);
    assert.equal(await page.locator('#askButton').isVisible(), false);
    assert.equal(await page.locator('#interruptButton').isEnabled(), true);
    assert.equal(await page.locator('[aria-label="编辑此问题"]').first().isEnabled(), false);
    await page.locator('.agent-work').locator(':scope > summary').click();
    const activity = await page.locator('.agent-activity').elementHandle();
    const work = await page.locator('.agent-work').elementHandle();
    await shot('01-empty-stop'); checks.push(phase);

    phase = 'Enter steering with selection, material and kept observation';
    await findPin('A'); await attachReferences({capture:true});
    await writeDraft('本地回放：先结合资料与留存观察解释 A');
    assert.equal(await page.locator('#askButton').isEnabled(), true);
    assert.equal(await page.locator('#interruptButton').isEnabled(), true);
    assert.equal(await page.locator('#askButton').getAttribute('title'), '追加到当前任务');
    const sendBox = await page.locator('#askButton').boundingBox(), stopBox = await page.locator('#interruptButton').boundingBox();
    assert.ok(stopBox.width < sendBox.width && stopBox.x + stopBox.width <= sendBox.x);
    await shot('02-ready-to-steer');
    await page.locator('#questionInput').press('Enter');
    await sent(2); await cleared();
    let recorded = await replay(); contextIn(recorded.requests[1], target);
    const raw = recorded.rawRequests[1];
    assert.equal(raw.expectedTurnId, target); assert.equal(raw.materialRefs.length, 1);
    assert.equal(raw.momentRefs.length, 1); assert.ok(raw.selectionId); assert.ok(raw.observationId);
    assert.equal((await state()).turnId, target); assert.equal(recorded.turnStarts, 1);
    const continuation = page.locator('[data-item-id="local-steer-ui-user-2"]');
    assert.equal(await continuation.locator('[aria-label="编辑此问题"]').count(), 0);
    assert.equal(await continuation.locator('[aria-label="复制消息"]').count(), 1);
    assert.equal(await activity.evaluate(node => node.isConnected && node.dataset.status === 'running'), true);
    assert.equal(await work.evaluate(node => node.isConnected && node.dataset.status === 'running'), true);
    await app.evaluate(() => global.__steerReplay.emit({type:'activity', itemId:'local-tool-1', kind:'tool',
      activityKey:'local:inspect', label:'本地回放：结合补充意见继续读取', status:'running'}));
    await page.locator('.agent-work').last().locator('.agent-tool-batch > summary').click();
    await page.locator('.agent-activity-label').filter({hasText:'本地回放：结合补充意见继续读取'}).waitFor();
    assert.equal(await page.locator('.agent-work').count(), 1);
    assert.equal(await page.locator('.agent-activity').count(), 1);
    await shot('03-continuing-same-work'); checks.push(phase);

    phase = 'button steering keeps the native target and clears only accepted draft';
    await attachReferences(); await writeDraft('本地回放：也说明 Y');
    await page.locator('#askButton').click(); await sent(3); await cleared();
    recorded = await replay(); contextIn(recorded.requests[2], target);
    assert.equal(recorded.rawRequests[2].expectedTurnId, target);
    assert.equal(recorded.rawRequests[2].materialRefs.length, 1);
    assert.equal(recorded.turnStarts, 1); checks.push(phase);

    phase = 'failed steering preserves draft and both attachments';
    await attachReferences(); await writeDraft('本地回放：失败后保留这条补充');
    await app.evaluate(() => {global.__steerReplay.rejectNext = true;});
    await page.locator('#askButton').click(); await sent(4);
    await page.locator('#toast').filter({hasText:'追加暂时失败'}).waitFor();
    assert.equal(await page.locator('#questionInput').inputValue(), '本地回放：失败后保留这条补充');
    assert.equal(await page.locator('.material-chip').count(), 1); assert.equal(await page.locator('.moment-chip').count(), 1);
    assert.equal(await page.locator('[data-item-id="local-steer-ui-user-4"]').count(), 0);
    assert.equal((await state()).canSteer, true);
    await shot('04-rejected-draft-retained'); checks.push(phase);

    phase = 'starting, finalizing and nonsteerable busy block Enter';
    const beforeBlocked = (await replay()).rawRequests.length;
    for (const mode of ['turnStarting', 'finalizing', 'withoutPendingTurn']) {
      const snapshot = await app.evaluate((_, mode) => {
        const r = global.__steerReplay, b = r.backend;
        if (mode === 'withoutPendingTurn') {r.savedPending = b.pendingTurn; b.pendingTurn = null;}
        else b[mode] = true;
        r.status(); return b.snapshot();
      }, mode);
      snapshots.push(snapshot); assert.equal(snapshot.busy, true); assert.equal(snapshot.canSteer, false);
      await page.waitForFunction(() => document.querySelector('#askButton').disabled);
      await page.locator('#questionInput').press('Enter');
      assert.equal((await replay()).rawRequests.length, beforeBlocked);
      await app.evaluate((_, mode) => {
        const r = global.__steerReplay;
        if (mode === 'withoutPendingTurn') r.backend.pendingTurn = r.savedPending;
        else r.backend[mode] = false;
        r.status();
      }, mode);
    }
    checks.push(phase);

    phase = 'turn ends during real selection preparation; old target still sent';
    await simulationMenu(page, 'simulationStop');
    await findPin('Y'); await writeDraft('本地回放：只追加到刚才的回合');
    let selectionReady;
    const selected = new Promise(resolve => {selectionReady = resolve;});
    const release = new Promise(resolve => {releaseSelection = resolve;});
    await page.route('**/api/selection', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      selectionReady(response.status()); await release; await route.fulfill({response});
    });
    await page.locator('#askButton').click();
    const selectionStatus = await Promise.race([selected, new Promise((_, reject) => setTimeout(() => reject(new Error('selection gate was not reached')), 20000).unref())]);
    assert.ok(selectionStatus >= 200 && selectionStatus < 300);
    assert.equal((await replay()).rawRequests.length, 4, 'IPC ask waits for selection response');
    await app.evaluate(() => global.__steerReplay.finish('completed'));
    snapshots.push(await state());
    assert.equal((await state()).turnId, null);
    // Wait for the renderer to consume completion while its submission awaits selection.
    await page.waitForFunction(() => document.querySelector('.agent-work')?.dataset.status === 'completed');
    releaseSelection();
    await sent(5);
    await page.locator('#toast').filter({hasText:'目标回合已结束'}).waitFor();
    recorded = await replay(); contextIn(recorded.requests[4], target);
    assert.equal(recorded.rawRequests[4].expectedTurnId, target); assert.equal(recorded.turnStarts, 1);
    assert.equal(await page.locator('#questionInput').inputValue(), '本地回放：只追加到刚才的回合');
    assert.equal(await page.locator('.material-chip').count(), 1); assert.equal(await page.locator('.moment-chip').count(), 1);
    await page.unroute('**/api/selection');
    await shot('05-finished-target-rejected'); checks.push(phase);

    phase = 'idle send and explicit compact Stop';
    await writeDraft('本地回放：现在明确开始新问题');
    await page.locator('#questionInput').press('Enter'); await sent(6); await cleared();
    const second = await state(); snapshots.push(second); assert.notEqual(second.turnId, target);
    assert.equal((await replay()).rawRequests[5].expectedTurnId, undefined);
    await writeDraft('停止时仍保留的下一条草稿');
    assert.equal(await page.locator('#askButton').isVisible(), true);
    await page.locator('#interruptButton').click();
    await waitUntil(async () => (await replay()).interrupts.length === 1);
    await page.waitForFunction(() => document.querySelector('#interruptButton').hidden && !document.querySelector('#askButton').disabled);
    assert.equal((await replay()).interrupts[0], second.turnId);
    assert.equal((await state()).busy, false); assert.equal((await state()).canSteer, false);
    assert.equal(await page.locator('#questionInput').inputValue(), '停止时仍保留的下一条草稿');
    assert.equal(await page.locator('.agent-work').last().getAttribute('data-status'), 'interrupted');
    await shot('06-explicit-stop'); checks.push(phase);

    phase = 'continuation cannot be edited live or from snapshot history; copy remains';
    assert.equal(await continuation.locator('.message-edit').count(), 0);
    assert.equal(await page.locator('[data-item-id="local-steer-ui-user-1"] .message-edit').isEnabled(), true);
    await continuation.locator('[aria-label="复制消息"]').click();
    assert.equal(await app.evaluate(({clipboard}) => clipboard.readText()), '本地回放：先结合资料与留存观察解释 A');
    const historySnapshot = await state(); snapshots.push(historySnapshot);
    assert.equal(historySnapshot.messages.find(m => m.id === 'local-steer-ui-user-2').context.turnContinuation, true);
    await page.reload();
    await page.locator('[data-item-id="local-steer-ui-user-2"]').waitFor();
    assert.equal(await continuation.locator('.message-edit').count(), 0);
    assert.equal(await continuation.locator('[aria-label="复制消息"]').count(), 1);
    assert.equal(await page.locator('[data-item-id="local-steer-ui-user-1"] .message-edit').isEnabled(), true);
    await shot('07-snapshot-history'); checks.push(phase);

    assert.equal(fs.readFileSync(source, 'utf8'), xml);
    assert.deepEqual(errors, []);
    recorded = await replay(); assert.equal(recorded.childStarted, false);
    assert.equal(recorded.events.filter(e => e.type === 'turn-started').length, 2);
    const result = {root, success:true, modelTurns:0, boundary:'Codex startup/ask/interrupt are local replay; production snapshot, IPC, context, native circuit and drafts are real',
      snapshotConnection:'temporary read-only alive marker; no child process', checks, snapshots, ...recorded, errors};
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({root, success:true, checks, modelTurns:0}));
  } catch (error) {
    releaseSelection?.();
    if (page) await shot('failure').catch(() => {});
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({root, success:false, phase, checks, error:error.stack, errors,
      replay:app ? await replay().catch(() => null) : null}, null, 2));
    console.error({root, phase, error}); process.exitCode = 1;
  } finally {
    await app?.close();
  }
}

if (process.versions.electron && process.type === 'browser') {
  console.error('[steer-ui-replay] installing local transport before application startup');
  installReplay();
  process.argv = process.argv.filter(arg => arg !== __filename); // Electron flags can precede the app entry.
  console.error('[steer-ui-replay] loading production main');
  require('../electron/main.cjs');
} else {
  run().catch(error => {console.error(error); process.exitCode = 1;});
}
