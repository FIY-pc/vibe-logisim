'use strict';

// Measures density, narrow-window and rapid-camera behavior in real Electron.
// It intentionally reports whether cache reuse and in-flight cancellation are
// present; it does not turn those product questions into assumptions.
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
    pixels:[Number(image.dataset.pixelWidth), Number(image.dataset.pixelHeight)],
    scale:Number(image.dataset.scale)
  }));
  if (!images.length) return {count:0, covers:false, images, dpr:devicePixelRatio};
  return {count:images.length, covers:
    Math.min(...images.map(image=>image.x)) <= a.x-margin &&
    Math.max(...images.map(image=>image.right)) >= b.x+margin &&
    Math.min(...images.map(image=>image.y)) <= a.y-margin &&
    Math.max(...images.map(image=>image.bottom)) >= b.y+margin,
    images, maxScale:Math.max(...images.map(image=>image.scale)), dpr:devicePixelRatio, viewBox:svg.getAttribute('viewBox')};
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-render-density-'));
  for (const name of ['stage6-if-id.circ', 'cs3410.jar', 'riscv-probe.jar']) {
    fs.copyFileSync(path.join(repo, 'exports/interface-editing', name), path.join(root, name));
  }
  const source = path.join(root, 'stage6-if-id.circ'), original = fs.readFileSync(source);
  const env = {...process.env, XDG_CONFIG_HOME:path.join(root, 'config'), VIBE_LOGISIM_STATE_DIR:path.join(root, 'state')};
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({executablePath:require('electron'), args:[path.join(repo, 'apps/desktop'), source, '--no-sandbox'], env});
  const page = await app.firstWindow();
  const requests = [], responses = [], failures = [], errors = [];
  page.on('request', request => {
    if (request.url().includes('/api/render/viewport')) requests.push({url:request.url(), at:Date.now()});
  });
  page.on('response', response => {
    if (response.url().includes('/api/render/viewport')) responses.push({url:response.url(), status:response.status(), at:Date.now()});
  });
  page.on('requestfailed', request => {
    if (request.url().includes('/api/render/viewport')) failures.push({url:request.url(), failure:request.failure()});
  });
  page.on('pageerror', error => errors.push(error.message));
  const cdp = await page.context().newCDPSession(page);
  const waitForDetail = (label, minimum=1) => waitUntil(
    () => page.evaluate(visibleDetail).then(detail => detail.count >= minimum && detail.covers ? detail : false),
    {timeout:60000, label});

  try {
    await page.setViewportSize({width:1100, height:760});
    await page.locator('#circuitList button').filter({has:page.locator('strong',{hasText:/^◇气泡流水线$/})}).click({timeout:90000});
    await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='◇气泡流水线' && document.querySelector('#canvasStatus').hidden);
    await page.locator('#fitButton').click();
    for (let i=0; i<18; i++) await page.locator('#zoomInButton').click();
    const narrow = await waitForDetail('narrow viewport detail');

    const narrowScale = narrow.maxScale, before2xResponses = responses.length;
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1100,height:760,deviceScaleFactor:2,mobile:false});
    await page.waitForFunction(()=>Math.abs(devicePixelRatio-2)<.001);
    const hidpi2 = await waitUntil(async()=>{
      const detail = await page.evaluate(visibleDetail);
      return responses.length > before2xResponses && detail.count && detail.covers && detail.maxScale >= narrowScale*1.7 ? detail : false;
    }, {timeout:60000, label:'2x detail'});
    const before3xResponses = responses.length;
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1100,height:760,deviceScaleFactor:3,mobile:false});
    await page.waitForFunction(()=>Math.abs(devicePixelRatio-3)<.001);
    const hidpi3 = await waitUntil(async()=>{
      const detail = await page.evaluate(visibleDetail);
      return responses.length > before3xResponses && detail.count && detail.covers && detail.maxScale >= narrowScale*2.5 ? detail : false;
    }, {timeout:60000, label:'3x detail'});
    assert.ok([...narrow.images,...hidpi2.images,...hidpi3.images].every(image=>image.pixels[0] <= 4096 && image.pixels[1] <= 4096), 'all density tiles stay within native bounds');

    // A small pan should keep some work reusable if a tile cache exists. The
    // current result records overlap instead of assuming the cache is there.
    await page.setViewportSize({width:3000, height:960});
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:3000,height:960,deviceScaleFactor:1,mobile:false});
    await page.waitForFunction(()=>Math.abs(devicePixelRatio-1)<.001);
    await page.locator('#fitButton').click();
    for (let i=0; i<14; i++) await page.locator('#zoomInButton').click();
    const beforePan = await waitForDetail('wide baseline detail', 2);
    const panStartRequests = requests.length;
    const beforeUrls = new Set(requests.slice(0, panStartRequests).map(request=>request.url));
    const beforeViewBox = beforePan.viewBox;
    const box = await page.locator('#circuitCanvas').boundingBox();
    await page.locator('#panTool').click();
    await page.mouse.move(box.x+box.width*.55, box.y+box.height*.5);
    await page.mouse.down();
    await page.mouse.move(box.x+box.width*.53, box.y+box.height*.5+8, {steps:4});
    await page.mouse.up();
    const afterPan = await waitUntil(async()=>{
      const detail = await page.evaluate(visibleDetail);
      return requests.length > panStartRequests && detail.count >= 2 && detail.covers && detail.viewBox !== beforeViewBox ? detail : false;
    }, {timeout:60000, label:'small panned detail'});
    await new Promise(resolve=>setTimeout(resolve,400));
    const panUrls = new Set(requests.slice(panStartRequests).map(request=>request.url));
    const reusedUrls = [...beforeUrls].filter(url=>panUrls.has(url));

    // Hold one real native request, then change the camera several times. If
    // the controller aborts in-flight work, the held route is released by the
    // browser before we open the gate. Otherwise stale-result guards still
    // protect the canvas, but transport work remains in flight.
    let releaseHeld, heldUrl = null, heldReleased = false;
    const gate = new Promise(resolve=>releaseHeld=resolve);
    await page.route('**/api/render/viewport?**', async route => {
      if (heldUrl) return route.continue();
      heldUrl = route.request().url();
      const response = await route.fetch();
      await gate;
      try { await route.fulfill({response}); } catch (_) { /* an abort is evidence too */ }
      heldReleased = true;
    });
    const requestStart = requests.length;
    await page.locator('#zoomInButton').click();
    await waitUntil(()=>heldUrl, {timeout:30000, label:'held viewport request'});
    for (let i=0; i<6; i++) await page.locator('#zoomInButton').click();
    await new Promise(resolve=>setTimeout(resolve,400));
    const heldWhileCameraChanged = !heldReleased;
    const requestsWhileHeld = requests.length-requestStart;
    releaseHeld();
    await page.unroute('**/api/render/viewport?**', {behavior:'wait'});
    const finalDetail = await waitForDetail('final rapid-zoom detail', 1);
    assert.equal(finalDetail.covers, true);
    assert.deepEqual(fs.readFileSync(source), original, 'rendering did not mutate the circuit source');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({root, circuit:'◇气泡流水线',
      narrow:{dpr:narrow.dpr,tileCount:narrow.count,maxTilePixels:Math.max(...narrow.images.flatMap(image=>image.pixels))},
      hidpi2:{dpr:hidpi2.dpr,tileCount:hidpi2.count,maxTilePixels:Math.max(...hidpi2.images.flatMap(image=>image.pixels))},
      hidpi3:{dpr:hidpi3.dpr,tileCount:hidpi3.count,maxTilePixels:Math.max(...hidpi3.images.flatMap(image=>image.pixels))},
      pan:{beforeTileCount:beforePan.count,afterTileCount:afterPan.count,requests:requests.length,reusedTileUrls:reusedUrls.length},
      rapidZoom:{requestsWhileHeld,heldRequestStillInFlight:heldWhileCameraChanged,failedRequests:failures.length,finalTileCount:finalDetail.count},
      sourceUnchanged:true,errors}, null, 2));
  } finally {
    await app.close();
  }
}

main().catch(error=>{console.error(error.stack || error);process.exitCode=1;});
