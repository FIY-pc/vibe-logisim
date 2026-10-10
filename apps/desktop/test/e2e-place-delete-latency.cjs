'use strict';

// Real mouse latency probe for placement and deletion. It uses a temporary
// copy of the course circuit and never calls the model or touches the original.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {_electron} = require('playwright');
const {waitUntil} = require('./support/wait-until.cjs');

const repo = path.resolve(__dirname, '../../..');
const {requireSamples} = require('./support/samples.cjs');
requireSamples(repo, 'exports/interface-editing/full_adder.circ', 'exports/interface-editing/cs3410.jar', 'exports/interface-editing/riscv-probe.jar');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-place-delete-'));
  for (const name of ['full_adder.circ', 'cs3410.jar', 'riscv-probe.jar']) {
    fs.copyFileSync(path.join(repo, 'exports/interface-editing', name), path.join(root, name));
  }
  const source = path.join(root, 'full_adder.circ'), original = fs.readFileSync(source);
  const env = {...process.env, XDG_CONFIG_HOME:path.join(root, 'config'), VIBE_LOGISIM_STATE_DIR:path.join(root, 'state'), VIBE_LOGISIM_CODEX:path.join(root, 'no-agent')};
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({executablePath:require('electron'), args:[path.join(repo, 'apps/desktop'), source, '--no-sandbox'], env});
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const appReady = () => page.waitForFunction(()=>document.querySelector('#appShell').getAttribute('aria-busy')==='false');
  const componentCount = () => page.locator('.circuit-component').count();
  const optimisticCount = () => page.locator('[data-optimistic="true"]').count();
  try {
    await page.setViewportSize({width:1500, height:960});
    await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='FullAdder' && document.querySelector('#canvasStatus').hidden);
    await appReady();
    const originalCount = await componentCount();

    await page.locator('#circuitCanvas').press('a');
    await page.locator('#componentSearch').fill('与门');
    await page.getByRole('button',{name:'与门',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#placementToolbar .placement-loading'));
    const canvas = await page.locator('#circuitCanvas').boundingBox();
    const point = (x,y)=>({x:canvas.x+canvas.width*x,y:canvas.y+canvas.height*y});

    const singleStart = await page.evaluate(()=>performance.now());
    await page.mouse.click(...Object.values(point(.78,.25)));
    await page.locator('[data-optimistic="true"]').first().waitFor();
    const singleOptimisticMs = await page.evaluate(start=>performance.now()-start,singleStart);
    await waitUntil(()=>Promise.all([optimisticCount(),page.evaluate(()=>document.querySelector('#appShell').getAttribute('aria-busy')==='false')]).then(([count,idle])=>count===0&&idle),{timeout:60000,label:'single placement commit'});

    const burstStart = await page.evaluate(()=>performance.now());
    for (const [x,y] of [[.55,.3],[.62,.3],[.69,.3],[.76,.3],[.83,.3]]) await page.mouse.click(...Object.values(point(x,y)));
    await waitUntil(()=>componentCount().then(count=>count>=originalCount+6),{timeout:10000,label:'optimistic burst visible'});
    const burstOptimisticMs = await page.evaluate(start=>performance.now()-start,burstStart);
    const burstVisibleCount = await componentCount();
    await waitUntil(()=>Promise.all([optimisticCount(),page.evaluate(()=>document.querySelector('#appShell').getAttribute('aria-busy')==='false')]).then(([count,idle])=>count===0&&idle),{timeout:60000,label:'burst placement commit'});

    // The newest confirmed component is isolated and safe to remove from the
    // temporary copy. Select it with a real click, then use Backspace.
    const target = page.locator('.circuit-component').last();
    const targetId = await target.getAttribute('data-object-id');
    await target.focus();
    await target.press('Enter');
    await page.waitForFunction(id=>document.querySelector(`.circuit-component[data-object-id="${CSS.escape(id)}"].is-selected`),targetId);
    const deleteStart = await page.evaluate(()=>performance.now());
    await page.keyboard.press('Backspace');
    try {
      await waitUntil(()=>page.locator(`.circuit-component[data-object-id="${targetId}"]`).count().then(count=>count===0),{timeout:60000,label:'delete visible'});
    } catch (error) {
      console.error('delete-debug', await page.evaluate(id=>({id,selected:document.querySelector(`.circuit-component[data-object-id="${CSS.escape(id)}"]`)?.className,
        busy:document.querySelector('#appShell')?.getAttribute('aria-busy'),status:document.querySelector('#canvasStatus')?.textContent,
        disabled:document.querySelector('#deleteSelectionButton')?.disabled,components:[...document.querySelectorAll('.circuit-component')].map(node=>node.dataset.objectId)}),targetId));
      throw error;
    }
    const deleteVisibleMs = await page.evaluate(start=>performance.now()-start,deleteStart);
    await appReady();
    const deleteFinishedMs = await page.evaluate(start=>performance.now()-start,deleteStart);
    assert.ok(!fs.readFileSync(source).equals(original),'temporary circuit changed through the project action');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({root,originalCount,singleOptimisticMs,burstOptimisticMs,burstVisibleCount,
      deleteVisibleMs,deleteFinishedMs,sourceChanged:true,errors},null,2));
  } finally { await app.close(); }
}

main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
