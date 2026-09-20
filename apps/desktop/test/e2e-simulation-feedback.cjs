'use strict';

// Replay saved production native events in a real Electron window. Transport
// progress and conversation are explicit fixtures; no model or account access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {_electron} = require('playwright');

const repo = path.resolve(__dirname, '../../..');
const input = process.argv[2] && path.resolve(process.argv[2]);
const output = process.argv[3] && path.resolve(process.argv[3]);
if (!input || !output) throw new Error('Usage: node e2e-simulation-feedback.cjs NATIVE_EVIDENCE_ROOT NEW_OUTPUT_DIRECTORY');
const native = JSON.parse(fs.readFileSync(path.join(input, '2.16.2.2/evidence.json'), 'utf8'));
const original = fs.readFileSync(path.join(input, '2.16.2.2/folder/test.circ'));
fs.mkdirSync(output); // Preserve prior runs rather than overwrite evidence.
const folder = path.join(output, 'folder'); fs.mkdirSync(folder);
const source = path.join(folder, 'test.circ'); fs.writeFileSync(source, original);
const env = {...process.env, XDG_CONFIG_HOME:path.join(output, 'config'),
  VIBE_LOGISIM_STATE_DIR:path.join(output, 'state'), VIBE_LOGISIM_CODEX:path.join(output, 'no-agent')};
delete env.ELECTRON_RUN_AS_NODE;

async function main() {
  const app = await _electron.launch({executablePath:require('electron'),
    args:[path.join(repo, 'apps/desktop'), source, '--no-sandbox'], env});
  const page = await app.firstWindow(), errors = [], captures = [];
  page.on('pageerror', error => errors.push(error.message));
  const emit = event => app.evaluate(({BrowserWindow}, event) =>
    BrowserWindow.getAllWindows()[0].webContents.send('vibe-logisim:agent-event', event), event);
  const session = () => page.evaluate(() => fetch('/api/session').then(r => r.json()));
  let phase = 'launch';
  try {
    await page.setViewportSize({width:1500, height:960});
    await page.waitForFunction(() => document.querySelector('#currentCircuitName').textContent === 'main'
      && document.querySelector('#canvasStatus').hidden);
    const initial = await session();
    await emit({type:'history', messages:[]});
    async function begin(id) {
      await emit({type:'user-message', id, text:'界面回放：检查原生运行反馈，不是模型新回答。'});
      await emit({type:'turn-started', turnId:id});
    }
    async function result(name) {
      const recorded = native.find(entry => entry.name === name);
      assert.ok(recorded && recorded.events.length === 1, name);
      const event = recorded.events[0].event;
      await emit({type:'activity', itemId:event.itemId, kind:'tool', label:'检查输入输出',
        status:'running', activityKey:'circuit:simulate_circuit'});
      await emit(event); // Actual result, including its original historical binding.
      await emit({type:'activity', itemId:event.itemId, kind:'tool', label:'检查输入输出',
        status:'completed', activityKey:'circuit:simulate_circuit'});
    }
    async function finish(id, expected, filename) {
      await emit({type:'turn-completed', turnId:id, status:'completed'});
      const work = page.locator('.agent-work').last();
      await work.locator('summary').filter({hasText:expected}).waitFor();
      await work.locator('summary').click(); // Real mouse opens the work process.
      await page.screenshot({path:path.join(output, filename + '.png')});
      captures.push({phase, text:await work.innerText()});
      return work;
    }
    phase = 'unknown survives transport completion';
    await begin('unknown-turn'); await result('undefined');
    const unknown = await finish('unknown-turn', '1 个结果待确认', '01-unknown');
    assert.equal(await unknown.locator('.agent-activity').count(), 1);
    assert.equal(await unknown.locator('[data-result-status="unknown"]').getAttribute('data-status'), 'warning');
    assert.equal(await unknown.locator('.agent-activity-status').textContent(), '待确认');

    phase = 'mismatch survives another passing batch';
    await begin('mismatch-turn'); await result('settled-mismatch'); await result('settled-match');
    const mismatch = await finish('mismatch-turn', '1 个运行结果不匹配', '02-mismatch-and-pass');
    assert.equal(await mismatch.locator('.agent-activity').count(), 2);
    const failed = mismatch.locator('[data-result-status="failed"]');
    assert.equal(await failed.locator('.agent-activity-status').textContent(), '不匹配');
    assert.equal(await failed.getAttribute('data-recovered'), null);
    assert.equal(await mismatch.locator('[data-result-status="passed"]').count(), 1);

    phase = 'unasserted observation is not presented as a pass';
    await begin('observe-turn'); await result('empty-expectation');
    const observed = await finish('observe-turn', '1 个工作步骤', '03-observed');
    assert.match(await observed.locator('.agent-activity-label').textContent(), /已观察/);
    assert.equal(await observed.locator('[data-result-status="passed"]').count(), 0);
    assert.deepEqual((await session()).workspace, initial.workspace);
    assert.equal((await session()).revision.id, initial.revision.id);
    assert.ok(fs.readFileSync(source).equals(original));
    assert.deepEqual(errors, []);
    const summary = {modelCalls:0, nativeEventsFrom:input,
      transport:'explicit replay of tool lifecycle around saved native feedback',
      interactions:'real mouse expands each work process', sourceAndRevisionUnchanged:true, captures, errors};
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify({ok:true, output, modelCalls:0}));
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({phase, error:error.stack, errors}, null, 2));
    await page.screenshot({path:path.join(output, 'failure.png')}).catch(() => {});
    throw error;
  } finally { await app.close(); }
}
main().catch(error => {console.error(error.stack); process.exitCode=1;});
