'use strict';
// Fresh-profile packaged UI -> real built-in SDK -> local HTTP fixture.
// Covers setup, model choices, offline refresh, restart and runtime history. No quota.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const {_electron} = require('playwright');
const {waitUntil} = require('./support/wait-until.cjs');
const http=require('node:http');
const {startFakeResponsesServer} = require('./support/fake-responses-server.cjs');
const executable = path.resolve(process.argv[2]);
const runtimeFiles = path.join(path.dirname(executable), 'resources', 'app', 'electron');
assert.ok(Object.keys(JSON.parse(fs.readFileSync(path.join(runtimeFiles, 'model-catalog.snapshot.json'))).providers).length);
assert.match(fs.readFileSync(path.join(runtimeFiles, 'model-catalog.LICENSE.txt'), 'utf8'), /MIT License/);
const root = fs.mkdtempSync(path.join(process.env.VIBE_SMOKE_ROOT || os.tmpdir(), 'vibe-runtime-smoke-'));
const folder = path.join(root, 'workspace'), out = path.resolve(process.argv[3] || root);
fs.mkdirSync(folder); fs.mkdirSync(out, {recursive: true});
const env = {...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), APPDATA: path.join(root, 'config'), CODEX_HOME: path.join(root, 'empty-codex'), VIBE_LOGISIM_NO_UPDATE_CHECK: '1'};
for (const name of ['ELECTRON_RUN_AS_NODE', 'VIBE_LOGISIM_STATE_DIR', 'VIBE_LOGISIM_CODEX', 'VIBE_LOGISIM_PYTHON', 'VIBE_LOGISIM_MODEL', 'VIBE_LOGISIM_EFFORT']) delete env[name];
let app, page, phase = 'launch'; const errors = [];
const state = () => page.evaluate(() => window.vibeDesktop.agent.getState());
const settled = () => waitUntil(() => state().then(s => !s.busy && ['ready', 'auth-required', 'unavailable'].includes(s.status) && s), {timeout:120000});
async function launch() {
  const noSandbox = process.platform === 'win32' || Boolean(process.env.VIBE_SMOKE_NO_SANDBOX);
  app = await _electron.launch({executablePath:executable, args:noSandbox?['--no-sandbox']:[], chromiumSandbox:!noSandbox, cwd:root, env, timeout:120000});
  page = await app.firstWindow(); page.setDefaultTimeout(45000); page.on('pageerror', e => errors.push(e.message));
  app.process().stderr.on('data', data => fs.appendFileSync(path.join(out, 'app.log'), data));
  await waitUntil(() => app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().some(window => window.isVisible())));
  await page.setViewportSize({width:1440,height:960});
  assert.equal(await app.evaluate(({app}) => app.isPackaged), true);
  await settled();
  // Main-process readiness can precede renderer event binding on a fresh install.
  await page.waitForFunction(()=>document.querySelector('#connectionClose svg')&&document.querySelector('#appShell').getAttribute('aria-busy')!=='true');
}
async function settings() { await page.locator('#agentSettings').click(); await page.locator('#connectionDialog[open]').waitFor(); }
async function addService(fake, name) {
  await page.locator('#connectionTabApi').click();
  await page.locator('#providerPreset').selectOption('custom');
  if (!await page.locator('#providerName').isVisible()) await page.locator('#providerAdvanced > summary').click();
  await page.locator('#providerName').fill(name);
  await page.locator('#providerProtocol').selectOption('openai-responses');
  await page.locator('#providerBaseUrl').fill(fake.baseUrl);
  await page.locator('#providerApiKey').fill(fake.apiKey);
  await page.locator('#providerModel').fill('probe-chat');
  await page.locator('#providerSave').click();
  await waitUntil(() => state().then(s => s.services?.some(v=>v.name===name)&&s), {timeout:60000});
  await page.waitForFunction(() => !document.querySelector('#connectionDialog').open || !document.querySelector('#settingsOverview').hidden);
}
(async()=>{
 const first = await startFakeResponsesServer({reply:'First service reply'}), second = await startFakeResponsesServer({reply:'Second service reply'});
 let downloadMode='slow',downloadRequests=0;
 const download=http.createServer((req,res)=>{downloadRequests++;res.writeHead(200,{'content-length':1024,'content-type':'application/octet-stream'});if(downloadMode==='slow')res.write(Buffer.alloc(128));else res.end(Buffer.alloc(1024));});
 await new Promise(r=>download.listen(0,'127.0.0.1',r));
 try {
  await launch();
  assert.equal((await state()).runtime,'builtin'); assert.equal((await state()).status,'auth-required');
  phase='create a workspace';
  assert.equal(await page.locator('#openButton').isVisible(),false);
  assert.equal(await page.locator('#emptyOpenButton').isVisible(),true);
  await app.evaluate(({dialog}, folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},folder);
  await page.locator('#emptyOpenButton').click();
  await page.locator('#fileActions').waitFor({state:'visible'});
  await page.locator('#newFileMenu').click();
  await page.getByRole('menuitem',{name:'新建电路',exact:true}).waitFor({state:'visible'});
  // Native window sizing can finish after renderer startup on Windows. A
  // resize must reposition the open menu, not discard the user's action.
  await page.setViewportSize({width:1420,height:940});
  await page.getByRole('menuitem',{name:'新建电路',exact:true}).click();
  await page.setViewportSize({width:1440,height:960});
  const name=page.getByRole('textbox',{name:'文件名称',exact:true});await name.fill('example.circ');await name.press('Enter');
  await page.waitForFunction(()=>document.querySelector('#appShell').getAttribute('aria-busy')!=='true'&&!document.querySelector('#fileActions').hidden);
  phase='first-use connection';
  await page.locator('#agentTab').click(); await page.locator('#agentConfigureApi').click();
  await page.locator('#settingsOverview').waitFor({state:'visible'});
  await addService(first,'First service');
  await page.locator('#connectionDialog[open]').waitFor({state:'hidden'});
  let s=await state(); assert.equal(s.status,'ready'); const firstId=s.customProvider.id, conversationId=s.conversationId;
  assert.ok(!JSON.stringify(s).includes(first.apiKey));
  phase='model controls and cached list survive failed refresh';
  await page.waitForFunction(()=>document.querySelector('#agentEffort').textContent==='默认');
  await page.locator('#agentEffort').click();
  await page.locator('#effortOptions [data-effort="max"]').waitFor({state:'visible'});
  assert.deepEqual(await page.locator('#effortOptions strong').allTextContents(),['默认','轻度','中','高','极高','最高']);
  await page.locator('#effortOptions [data-effort="max"]').click();
  await waitUntil(()=>state().then(s=>s.effort==='max'&&s));
  await page.locator('#agentModel').click();
  await page.locator('#modelRefresh').click();
  await page.locator('#modelChoice [data-model="probe-mini"]').waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('#modelRefresh').disabled);
  first.setModelListStatus(503);
  await page.locator('#modelRefresh').click();
  await page.locator('#modelError').waitFor({state:'visible'});
  assert.match(await page.locator('#modelError').innerText(),/模型列表未更新/);
  await page.locator('#modelChoice [data-model="probe-mini"]').click();
  await waitUntil(()=>state().then(s=>s.model==='probe-mini'&&s.effort==='max'&&s));
  first.setModelListStatus(200);
  await page.locator('#questionInput').fill('Remember this conversation.');await page.locator('#askButton').click();
  await waitUntil(()=>state().then(s=>!s.busy&&s.messages.some(m=>m.type==='assistant'&&m.text==='First service reply')&&s),{timeout:60000});
  assert.ok(first.requests.some(r=>r.body?.model==='probe-mini'&&r.body?.reasoning?.effort==='max'));
  const toolRequests=first.requests.filter(r=>r.body?.tools?.length);
  assert.ok(toolRequests.length,'packaged runtime sends its tools');
  for(const request of toolRequests)for(const tool of request.body.tools)assert.equal(tool.strict,false,tool.name);
  await page.screenshot({path:path.join(out,'01-connected.png')});
  phase='new service preserves conversation binding';
  await settings();await addService(second,'Second service');
  s=await state();assert.equal(s.customProvider.id,firstId);assert.equal(s.conversationId,conversationId);
  const secondId=s.services.find(v=>v.name==='Second service').id;
  await page.locator('#defaultService').selectOption(secondId);
  await waitUntil(()=>state().then(s=>s.defaultServiceId===secondId&&s));
  assert.equal((await state()).customProvider.id,firstId);
  await page.locator('#connectionClose').click();
  phase='restart restores original destination and visible history';
  await app.close();app=null;await launch();s=await state();
  assert.equal(s.conversationId,conversationId);assert.equal(s.customProvider.id,firstId);assert.equal(s.defaultServiceId,secondId);
  assert.equal(s.model,'probe-mini');assert.equal(s.effort,'max');
  await page.waitForFunction(()=>document.querySelector('#agentEffort').textContent==='最高');
  assert.ok(s.messages.some(m=>m.text==='First service reply'));
  const before=first.requests.length;
  await page.locator('#questionInput').fill('Continue this conversation.');await page.locator('#askButton').click();
  await waitUntil(()=>state().then(s=>!s.busy&&s.messages.filter(m=>m.text==='First service reply').length===2&&s),{timeout:60000});
  assert.ok(first.requests.slice(before).some(r=>JSON.stringify(r.body).includes('Remember this conversation.')));
  phase='new conversation uses the new default';
  await page.locator('#conversationNew').click();
  await waitUntil(()=>state().then(s=>s.conversationId!==conversationId&&s.customProvider?.id===secondId&&s));
  phase='cross-runtime history remains selectable';
  // Intercept only the optional runtime transport in the test process. The
  // shipped manifest and checksum remain unchanged; incomplete/corrupt bytes
  // must never be executed, and no GitHub download is needed for this fixture.
  await app.evaluate(({session,net},url)=>{const proto=Object.getPrototypeOf(session.defaultSession),original=proto.fetch;proto.fetch=function(target,init){return String(target).includes('/codex-package-')?globalThis.fetch(url,init):original.call(this,target,init);};},`http://127.0.0.1:${download.address().port}/runtime`);
  await settings();await page.locator('#settingsRuntime').click();await page.locator('#useCodexRuntime').click();
  await waitUntil(()=>state().then(s=>s.runtime==='codex'&&s.runtimeInstall?.received===128&&s));
  assert.equal((await state()).busy,false);
  await page.locator('#runtimeInstall').waitFor({state:'visible'});
  await page.screenshot({path:path.join(out,'02-downloading.png')});
  await page.locator('#runtimeInstallAction').click();
  await waitUntil(()=>state().then(s=>s.runtimeInstall?.phase==='cancelled'&&s));
  phase='optional runtime retry verifies downloaded bytes';downloadMode='corrupt';
  await page.locator('#runtimeInstallAction').click();
  await waitUntil(()=>state().then(s=>s.runtimeInstall?.phase==='error'&&s));
  assert.match(await page.locator('#runtimeInstallText').innerText(),/校验失败/);assert.equal(downloadRequests,2);
  await page.screenshot({path:path.join(out,'03-download-failed.png')});
  await page.locator('#connectionClose').click();await page.locator('#conversationPicker').click();
  await page.locator('#conversationList').getByRole('button').filter({hasText:'Remember this conversation.'}).first().click();
  await waitUntil(()=>state().then(s=>s.runtime==='builtin'&&s.conversationId===conversationId&&s),{timeout:120000});
  s=await state();assert.equal(s.customProvider.id,firstId);assert.equal(s.messages.filter(m=>m.text==='First service reply').length,2);
  await page.screenshot({path:path.join(out,'02-restored.png')});
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({success:true,platform:process.platform,firstUse:true,modelChoices:true,offlineCatalog:true,extendedEffort:true,restart:true,pinnedService:true,sharedHistory:true,runtimeCancel:true,runtimeRetry:true,runtimeChecksum:true,remoteModelTurns:0},null,2));
  console.log('OK: packaged built-in setup, SDK stream, restart, service defaults and cross-runtime history');
 }catch(error){
  console.error('FAILED',phase,error, 'downloads:',downloadRequests, 'install:',await state().then(s=>s.runtimeInstall).catch(()=>null));await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({success:false,phase,error:String(error),errors},null,2));process.exitCode=1;
 }finally{await app?.close().catch(()=>{});await first.close();await second.close();download.closeAllConnections();download.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
