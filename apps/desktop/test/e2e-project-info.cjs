'use strict';
// Real Electron UI, native circuit read/edit and actual ZIP download/reopen.
// Only native file selections and a labelled failed HTTP response are supplied.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {_electron}=require('playwright');
const {waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..');
const root=fs.mkdtempSync('/tmp/vibe-project-info-');
const out=repo+'/apps/desktop/docs/product/evidence/2026-09-16-project-info';
fs.mkdirSync(out,{recursive:true});
const folder=root+'/我的课设/流水线电路与相关组件库';fs.mkdirSync(folder,{recursive:true});
for(const name of ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar'])fs.copyFileSync(repo+'/exports/interface-editing/'+name,folder+'/'+name);
const source=folder+'/stage6-if-id.circ',original=fs.readFileSync(source);
const env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const errors=[],result={root,modelTurns:0};
const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
const shot=name=>page.screenshot({path:out+'/'+name+'.png'});
async function open(file){await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.locator('#openButton').click();await waitUntil(()=>session().then(s=>s.source?.path===file));await page.waitForFunction(()=>document.querySelector('#workspaceName').textContent!=='没有打开的电路');}
async function ifid(){await page.locator('#circuitList button').filter({has:page.locator('strong',{hasText:/^IF_ID$/})}).click({timeout:90000});await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden);}
(async()=>{try{
  app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop','--no-sandbox'],env});
  page=await app.firstWindow();page.on('pageerror',e=>{errors.push(e.stack);console.error(e.stack);});await page.setViewportSize({width:1500,height:960});
  await app.evaluate(async ({clipboard,session}, {repo,root})=>{
    const require=process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');
    require('./codex-backend.cjs').CodexBackend.prototype.ask=async()=>{throw new Error('Model generation disabled for project information acceptance');};
    global.__infoClipboard=await clipboard.read();
    global.__infoDownloads=[];
    session.defaultSession.on('will-download',(_,item)=>{item.setSavePath(root+'/'+item.getFilename());item.on('done',(_,state)=>global.__infoDownloads.push({state,path:item.getSavePath(),name:item.getFilename()}));});
  },{repo,root});
  await page.locator('#emptyOpenButton').waitFor();assert.equal(await page.locator('#projectInfo').isDisabled(),true);
  await open(source);await ifid();const initial=await session();
  await page.locator('#questionInput').fill('保持这个想法：先整理 IF_ID 的控制信号。');
  await page.locator('#findObject').click();await page.locator('#finderInput').fill('ID.PC');await page.locator('#finderInput').press('Enter');
  const label=page.getByRole('textbox',{name:'标签',exact:true});await label.fill('DECODE.PC');await label.press('Enter');
  const edited=await waitUntil(()=>session().then(s=>s.workspace?.dirty&&s));await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden);
  const selection=await page.locator('.circuit-component.is-selected').getAttribute('data-object-id');
  const camera=await page.locator('#circuitCanvas').getAttribute('viewBox');
  await page.locator('#projectInfo').click();await shot('01-current-project');
  assert.equal(await page.locator('#projectFileName').innerText(),'stage6-if-id.circ');
  assert.equal(await page.locator('#projectSource').innerText(),folder);
  assert.match(await page.locator('#projectContents').innerText(),/14 个电路 · 有未保存的改动/);
  assert.match(await page.locator('#projectRuntime').innerText(),/^Logisim-ITA 2\.15\.0\.2$/);
  assert.match(await page.locator('#projectLibraries').innerText(),/cs3410.jar/);assert.match(await page.locator('#projectLibraries').innerText(),/riscv-probe.jar/);
  assert.equal(await page.locator('#projectIssue').isVisible(),false);
  assert.equal(await page.locator('#projectDialog details,#capabilityPlate,#revisionReadout').count(),0);
  await page.locator('#projectCopyPath').click();
  assert.equal(await app.evaluate(async ({clipboard},source)=>(await clipboard.readText())===source,source),true);
  await page.locator('#exportProject').click();
  const downloaded=await waitUntil(()=>app.evaluate(()=>global.__infoDownloads[0]),{timeout:30000});assert.equal(downloaded.state,'completed');assert.equal(downloaded.name,'stage6-if-id.zip');
  const extraction=root+'/重新打开';
  const archive=JSON.parse(execFileSync('python',['-c',`import json,sys,zipfile,pathlib,hashlib
z=zipfile.ZipFile(sys.argv[1]); z.extractall(sys.argv[2]); print(json.dumps({'files':z.namelist(),'circuitSha':hashlib.sha256(z.read('project/stage6-if-id.circ')).hexdigest()}))`,downloaded.path,extraction],{encoding:'utf8'}));
  assert.equal(archive.circuitSha,edited.revision.artifactSha256);
  assert.ok(fs.readFileSync(extraction+'/project/stage6-if-id.circ','utf8').includes('DECODE.PC'));
  for(const name of ['cs3410.jar','riscv-probe.jar'])assert.deepEqual(fs.readFileSync(extraction+'/project/'+name),fs.readFileSync(folder+'/'+name));
  assert.deepEqual(fs.readFileSync(source),original,'Export must not save over the original');
  // Recoverable HTTP failure must leave the workspace, dialog and binding intact.
  await page.route('**/api/project/download?*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'验收注入：打包暂时失败'}})}));
  await page.locator('#exportProject').click();await page.locator('#projectInfoError').waitFor();assert.match(await page.locator('#projectInfoError').innerText(),/验收注入/);await shot('02-export-retry');
  assert.equal((await session()).workspace.id,initial.workspace.id);
  await page.unroute('**/api/project/download?*');await page.locator('#exportProject').click();await waitUntil(()=>app.evaluate(()=>global.__infoDownloads.length===2));assert.equal(await page.locator('#projectInfoError').isVisible(),false);
  // Closing while packaging cancels the pending response. Reopening gets no old
  // download/error, and can immediately export again.
  let releaseDownload;
  const blocked=new Promise(resolve=>{releaseDownload=resolve;});
  await page.route('**/api/project/download?*',async route=>{const response=await route.fetch();await blocked;await route.fulfill({response}).catch(()=>{});});
  const pendingRequest=page.waitForRequest('**/api/project/download?*');
  await page.locator('#exportProject').click();await pendingRequest;
  await page.keyboard.press('Escape');await page.locator('#projectInfo').click();
  releaseDownload();await page.unrouteAll({behavior:'wait'});
  await page.waitForFunction(()=>!document.querySelector('#exportProject').disabled);
  assert.equal(await page.locator('#projectInfoError').isVisible(),false);
  assert.equal(await app.evaluate(()=>global.__infoDownloads.length),2);
  // Focus containment, resize/long path and both native/custom dismissal.
  await page.locator('#projectInfoClose').focus();await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'exportProject');
  await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'projectInfoClose');
  await page.setViewportSize({width:800,height:640});await shot('03-compact');
  assert.equal(await page.locator('#projectDialog').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#projectDialog').isVisible(),false);assert.equal(await page.evaluate(()=>document.activeElement.id),'projectInfo');
  await page.setViewportSize({width:1500,height:960});await page.locator('#projectInfo').click();await page.mouse.click(20,200);assert.equal(await page.locator('#projectDialog').isVisible(),false);
  assert.equal(await page.locator('#circuitCanvas').getAttribute('viewBox'),camera);assert.equal(await page.locator('.circuit-component.is-selected').getAttribute('data-object-id'),selection);
  assert.equal(await page.locator('#questionInput').inputValue(),'保持这个想法：先整理 IF_ID 的控制信号。');
  assert.equal((await session()).revision.id,edited.revision.id);
  // Reopen the actual exported circuit, with native runtime + libraries.
  await open(extraction+'/project/stage6-if-id.circ');await ifid();
  await page.locator('#projectInfo').click();assert.equal(await page.locator('#projectSource').innerText(),extraction+'/project');assert.equal(await page.locator('#projectIssue').isVisible(),false);await shot('04-export-reopened');await page.keyboard.press('Escape');
  assert.equal((await session()).revision.artifactSha256,edited.revision.artifactSha256);
  // Real missing libraries, no fabricated capability payload.
  const missing=root+'/缺少组件库';fs.mkdirSync(missing);const incomplete=missing+'/未配齐的课设.circ';fs.writeFileSync(incomplete,original);
  await open(incomplete);await page.waitForFunction(()=>document.querySelector('#canvasStatus').textContent.includes('缺少组件库'));
  await page.locator('#projectInfo').click();await page.locator('#projectIssue').waitFor();assert.match(await page.locator('#projectIssue').innerText(),/cs3410.jar/);assert.equal(await page.locator('#exportProject').isDisabled(),true);assert.equal(await page.locator('#projectRuntime').innerText(),'尚未成功载入');await shot('05-missing-libraries');await page.keyboard.press('Escape');
  // Repair the same incomplete project: supply the real libraries, then use the
  // existing external-change/reload action. Merely reopening keeps its snapshot.
  const brokenProject=await session();
  for(const name of ['cs3410.jar','riscv-probe.jar'])fs.copyFileSync(folder+'/'+name,missing+'/'+name);
  await page.locator('#reloadRevisionButton').waitFor({timeout:15000});
  await page.locator('#reloadRevisionButton').click();
  await page.waitForFunction(()=>!document.querySelector('#reloadRevisionButton').disabled);
  await ifid();
  await page.locator('#projectInfo').click();
  assert.equal(await page.locator('#projectIssue').isVisible(),false);
  assert.equal(await page.locator('#exportProject').isEnabled(),true);
  assert.match(await page.locator('#projectRuntime').innerText(),/^Logisim-ITA 2\.15\.0\.2$/);
  const repaired=await session();assert.equal(repaired.workspace.id,brokenProject.workspace.id);
  assert.equal(repaired.revision.artifactSha256,brokenProject.revision.artifactSha256);
  await shot('06-libraries-restored');await page.keyboard.press('Escape');
  // Returning to a healthy project must clear the old error and disabled export.
  await open(source);await ifid();await page.locator('#projectInfo').click();assert.equal(await page.locator('#projectIssue').isVisible(),false);assert.equal(await page.locator('#exportProject').isEnabled(),true);await page.keyboard.press('Escape');
  assert.deepEqual(fs.readFileSync(source),original);assert.deepEqual(errors,[]);
  Object.assign(result,{archive,clipboard:'exact source path copied',export:'real ZIP, unsaved edit, matching JAR bytes, unpacked native reopen',recovery:'labelled HTTP failure/retry, cancel pending export, real missing libraries repaired via disk reload without changing project identity or circuit bytes',interaction:'empty disabled, dialog focus, Escape/outside, long path, draft/selection/camera preserved',errors});
  fs.writeFileSync(out+'/acceptance.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){await page?.screenshot({path:out+'/failure.png'}).catch(()=>{});console.error('UI errors',errors);throw error;}finally{
  await app?.evaluate(async ({clipboard})=>{if(global.__infoClipboard)await clipboard.write(global.__infoClipboard);}).catch(()=>{});
  await app?.close();
}})().catch(e=>{console.error(e);process.exitCode=1});
