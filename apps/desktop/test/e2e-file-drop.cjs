'use strict';
// Native-backed drag payloads exercise File -> preload -> host copy -> file tree.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require('playwright'),{waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),root=fs.mkdtempSync('/tmp/vibe-file-drop-'),folder=root+'/workspace',external=root+'/external';
fs.mkdirSync(folder+'/资料',{recursive:true});fs.mkdirSync(external+'/参考图/嵌套',{recursive:true});
fs.copyFileSync(repo+'/apps/desktop/electron/templates/blank.circ',folder+'/main.circ');
fs.copyFileSync(folder+'/main.circ',external+'/第二份.circ');fs.writeFileSync(external+'/说明.md','外部原稿');fs.writeFileSync(folder+'/说明.md','原有内容');fs.writeFileSync(external+'/参考图/嵌套/notes.txt','完整目录');
const out=repo+'/apps/desktop/docs/product/evidence/2026-09-16-editing-interactions';fs.mkdirSync(out,{recursive:true});
const env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
let app,page,cdp,phase='launch';const errors=[];
async function point(selector){const b=await page.locator(selector).boundingBox();return{x:b.x+b.width/2,y:b.y+Math.min(14,b.height/2)};}
async function drag(files,selector,{hoverOnly=false}={}){const p=await point(selector),data={items:[],files,dragOperationsMask:1};for(const type of ['dragEnter','dragOver',...(hoverOnly?[]:['drop'])])await cdp.send('Input.dispatchDragEvent',{type,...p,data});}
const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
(async()=>{try{
 app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',folder+'/main.circ','--no-sandbox'],env});page=await app.firstWindow();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1500,height:960});
 await app.evaluate((_,repo)=>{const req=process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');req('./codex-backend.cjs').CodexBackend.prototype.ask=async()=>{throw new Error('No model turns during drag acceptance');};},repo);
 await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='main'&&document.querySelector('#canvasStatus').hidden);const original=await session();cdp=await page.context().newCDPSession(page);
 phase='local target and same-name copy';await drag([external+'/说明.md'],'#fileExplorer .file-heading',{hoverOnly:true});
 assert.equal(await page.locator('#dropCurtain').isVisible(),false);assert.equal(await page.locator('.file-drop-hint').count(),0);assert.equal(await page.locator('#fileExplorer.is-file-drop').count(),0);assert.equal(await page.locator('#fileExplorer .is-drop-target').count(),1);assert.match(await page.locator('#fileExplorer .file-heading').getAttribute('class'),/is-drop-target/);
 await page.screenshot({path:out+'/file-drop-target.png'});await drag([external+'/说明.md'],'#fileExplorer .file-heading');
 await waitUntil(()=>fs.existsSync(folder+'/说明 (2).md'));await page.locator('.file-row[data-path="说明 (2).md"]').waitFor();assert.equal(fs.readFileSync(folder+'/说明.md','utf8'),'原有内容');assert.equal(fs.readFileSync(external+'/说明.md','utf8'),'外部原稿');
 phase='nested directory and multiple files';await drag([external+'/参考图',external+'/第二份.circ'],'.file-row[data-path="资料"]',{hoverOnly:true});
 await page.locator('.file-empty-branch[data-path="资料"]').waitFor();
 await drag([external+'/参考图',external+'/第二份.circ'],'.file-empty-branch[data-path="资料"]',{hoverOnly:true});
 assert.equal(await page.locator('#fileExplorer .is-drop-target').count(),1);assert.match(await page.locator('.file-row[data-path="资料"]').getAttribute('class'),/is-drop-target/);assert.doesNotMatch(await page.locator('#fileExplorer .file-heading').getAttribute('class'),/is-drop-target/);
 await page.screenshot({path:out+'/file-drop-folder-target.png'});await drag([external+'/参考图',external+'/第二份.circ'],'.file-empty-branch[data-path="资料"]');
 await waitUntil(()=>fs.existsSync(folder+'/资料/参考图/嵌套/notes.txt')&&fs.existsSync(folder+'/资料/第二份.circ'));
 await page.locator('.file-row[data-path="资料/第二份.circ"]').waitFor();assert.equal(fs.readFileSync(folder+'/资料/参考图/嵌套/notes.txt','utf8'),'完整目录');assert.ok(fs.existsSync(external+'/参考图/嵌套/notes.txt'));
 const after=await session();assert.equal(after.folder.id,original.folder.id);assert.equal(after.folder.activeFile,'main.circ');assert.equal(after.revision.id,original.revision.id);
 phase='outside drop does not open';await drag([external+'/参考图'],'#circuitCanvas');assert.equal(await page.locator('#dropCurtain').isVisible(),false);assert.equal((await session()).folder.id,original.folder.id);
 phase='component tab accepts root drop';await page.locator('#componentsTab').click();await drag([external+'/第二份.circ'],'#fileExplorer .file-heading');await page.locator('.file-row[data-path="第二份.circ"]').waitFor();assert.equal(await page.locator('#filesTab').getAttribute('aria-selected'),'true');
 phase='text drag remains native';const prevented=await page.locator('#questionInput').evaluate(input=>{const d=new DataTransfer();d.setData('text/plain','正常文字');const e=new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:d});input.dispatchEvent(e);return e.defaultPrevented;});assert.equal(prevented,false);
 assert.deepEqual(errors,[]);const result={root,success:true,modelTurns:0,nativeFilePaths:true,directories:true,sourcePreserved:true,noOverwrite:true,activeDocumentPreserved:true};fs.writeFileSync(out+'/file-drop.json',JSON.stringify(result,null,2));console.log(result);
}catch(e){console.error({root,phase},e);if(page){console.error(await page.locator('#fileExplorer').innerText().catch(()=>''));await page.screenshot({path:out+'/file-drop-failure.png'}).catch(()=>{});}process.exitCode=1;}finally{if(app)await app.close();}})();
