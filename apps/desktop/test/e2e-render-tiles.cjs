'use strict';

// Real Electron acceptance for static high-density viewport tiling. This uses
// the course circuit, but never calls the model or mutates the source file.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {_electron} = require('playwright');
const {waitUntil} = require('./support/wait-until.cjs');

const repo = path.resolve(__dirname, '../../..');

function visibleDetail() {
  const svg = document.querySelector('#circuitCanvas');
  const matrix = svg.getScreenCTM(), rect = svg.getBoundingClientRect();
  const a = new DOMPoint(rect.left, rect.top).matrixTransform(matrix.inverse());
  const b = new DOMPoint(rect.right, rect.bottom).matrixTransform(matrix.inverse());
  const margin = 64 / matrix.a;
  const images = [...document.querySelectorAll('#detailLayer image')].map(image => ({
    x:Number(image.getAttribute('x')), y:Number(image.getAttribute('y')),
    right:Number(image.getAttribute('x')) + Number(image.getAttribute('width')),
    bottom:Number(image.getAttribute('y')) + Number(image.getAttribute('height')),
    pixels:[Number(image.dataset.pixelWidth), Number(image.dataset.pixelHeight)]
  }));
  if (!images.length) return {count:0, covers:false, images};
  return {count:images.length, covers:
    Math.min(...images.map(image=>image.x)) <= a.x-margin &&
    Math.max(...images.map(image=>image.right)) >= b.x+margin &&
    Math.min(...images.map(image=>image.y)) <= a.y-margin &&
    Math.max(...images.map(image=>image.bottom)) >= b.y+margin, images};
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-render-tiles-'));
  for (const name of ['stage6-if-id.circ', 'cs3410.jar', 'riscv-probe.jar']) {
    fs.copyFileSync(path.join(repo, 'exports/interface-editing', name), path.join(root, name));
  }
  const source = path.join(root, 'stage6-if-id.circ');
  const original = fs.readFileSync(source);
  const env = {...process.env, XDG_CONFIG_HOME:path.join(root, 'config'), VIBE_LOGISIM_STATE_DIR:path.join(root, 'state')};
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({executablePath:require('electron'), args:[path.join(repo, 'apps/desktop'), source, '--no-sandbox'], env});
  const page = await app.firstWindow();
  const responses = [], errors = [];
  page.on('response', response => {
    if (response.url().includes('/api/render/viewport')) responses.push({status:response.status(), url:response.url()});
  });
  page.on('pageerror', error => errors.push(error.message));
  try {
    // The wide window is deliberate: it makes the visible high-density detail
    // exceed one 1536px tile while exercising the same UI as a user.
    await page.setViewportSize({width:3000, height:960});
    await page.locator('#circuitList button').filter({has:page.locator('strong',{hasText:/^◇气泡流水线$/})}).click({timeout:90000});
    await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='◇气泡流水线' && document.querySelector('#canvasStatus').hidden);
    const before = await page.evaluate(()=>fetch('/api/session').then(response=>response.json()));
    const detail = page.locator('#detailLayer image');
    for (let i=0; i<14; i++) await page.locator('#zoomInButton').click();
    const first = await waitUntil(()=>page.evaluate(visibleDetail).then(detail=>detail.count > 1 ? detail : false), {timeout:60000, label:'multiple static detail tiles'});
    assert.ok(first.count > 1, `expected multiple detail tiles, got ${first.count}`);
    assert.equal(first.covers, true, 'detail tiles cover the complete visible canvas');
    assert.ok(first.images.every(image=>image.pixels[0] <= 4096 && image.pixels[1] <= 4096), 'each tile stays within native bounds');
    assert.ok(responses.length >= first.count, 'native viewport responses arrived for the tiles');
    assert.ok(responses.every(response=>response.status===200), 'all tile responses succeeded');

    await page.locator('#panTool').click();
    const box = await page.locator('#circuitCanvas').boundingBox();
    await page.mouse.move(box.x+box.width*.55, box.y+box.height*.5);
    await page.mouse.down();
    await page.mouse.move(box.x+box.width*.35, box.y+box.height*.5+40, {steps:12});
    await page.mouse.up();
    const after = await waitUntil(()=>page.evaluate(visibleDetail).then(detail=>detail.count > 1 && detail.covers ? detail : false), {timeout:60000, label:'latest panned detail tiles'});
    assert.ok(after.count > 1, `expected multiple panned detail tiles, got ${after.count}`);
    assert.equal(after.covers, true, 'panned detail tiles cover the complete visible canvas');
    assert.deepEqual(fs.readFileSync(source), original, 'rendering did not mutate the circuit source');
    assert.equal((await page.evaluate(()=>fetch('/api/session').then(response=>response.json()))).revision.id, before.revision.id);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({root, circuit:'◇气泡流水线', initialTileCount:first.count, pannedTileCount:after.count,
      maxTilePixels:Math.max(...after.images.flatMap(image=>image.pixels)), viewportResponses:responses.length,
      sourceUnchanged:true, revisionUnchanged:true, errors}, null, 2));
  } finally {
    await app.close();
  }
}

main().catch(error=>{console.error(error.stack || error);process.exitCode=1;});
