'use strict';
// Real Electron, filesystem and native circuit loading. No model turns.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require('playwright');
const {waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),root=fs.mkdtempSync('/tmp/vibe-explorer-');
const folder=root+'/处理器设计',other=root+'/另一个项目';
const out=repo+'/apps/desktop/docs/product/evidence/2026-09-16-file-explorer';
fs.mkdirSync(folder+'/电路/流水线',{recursive:true});fs.mkdirSync(folder+'/参考资料');fs.mkdirSync(folder+'/测试程序');fs.mkdirSync(folder+'/.notes');fs.mkdirSync(other);fs.mkdirSync(out,{recursive:true});
for(const name of ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar'])fs.copyFileSync(repo+'/exports/interface-editing/'+name,folder+'/电路/流水线/'+name);
fs.renameSync(folder+'/电路/流水线/stage6-if-id.circ',folder+'/电路/流水线/处理器.circ');
fs.writeFileSync(folder+'/参考资料/任务说明.md','# 任务说明\n\n理解流水级之间的控制信号。');
fs.writeFileSync(folder+'/测试程序/add.S','addi x1, x0, 1');fs.writeFileSync(folder+'/README.md','# 处理器设计');fs.writeFileSync(folder+'/.notes/思路.md','讨论记录');
const source=folder+'/电路/流水线/处理器.circ',original=fs.readFileSync(source);
const env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
let app,page,phase='launch';const errors=[];
const row=file=>page.locator('.file-row').filter({has:page.locator('.file-name',{hasText:new RegExp('^'+file.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')})});
const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
async function launch(){app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop','--no-sandbox'],env});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.stack));await page.setViewportSize({width:1500,height:960});await app.evaluate((_,repo)=>{const require=process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');require('./codex-backend.cjs').CodexBackend.prototype.ask=async()=>{throw new Error('No model generation during explorer acceptance');};},repo);}
async function openFolder(root){await app.evaluate(({dialog},root)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[root]});},root);await page.locator('#openButton').click();await waitUntil(()=>session().then(s=>s.folder?.root===root&&s));await page.waitForFunction(()=>!document.querySelector('#questionInput').disabled);}
async function option(name){await page.locator('#fileOptions').click();await page.getByRole('menuitem',{name,exact:true}).click();}
async function newItem(name){await page.locator('#newFileMenu').click();await page.getByRole('menuitem',{name,exact:true}).click();}
(async()=>{try{
 await launch();phase='browse';await openFolder(folder);
 assert.equal(await page.locator('#collapseNavigator').innerText(),'当前电路');
 await row('电路').click();await row('流水线').click();await row('处理器.circ').click();
 await waitUntil(()=>session().then(s=>s.folder?.activeFile==='电路/流水线/处理器.circ'&&s));
 await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden);
 await page.locator('#circuitList button').filter({has:page.locator('strong',{hasText:/^IF_ID$/})}).click();
 await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden);
 await row('参考资料').click();await row('测试程序').click();
 // Give the file pane practical room through its real resize control.
 await page.locator('#filesResize').focus();for(let i=0;i<2;i++)await page.keyboard.press('Shift+ArrowDown');
 await page.locator('#locateCurrentFile').click();
 await page.screenshot({path:out+'/01-workspace.png'});
 phase='keyboard';await row('参考资料').focus();await page.keyboard.press('ArrowRight');
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.path),'参考资料/任务说明.md');
 await page.keyboard.press('ArrowLeft');assert.equal(await page.evaluate(()=>document.activeElement.dataset.path),'参考资料');
 await page.keyboard.press('ArrowLeft');await waitUntil(()=>row('参考资料').getAttribute('aria-expanded').then(v=>v==='false'));
 await page.keyboard.press('ArrowRight');await waitUntil(()=>row('参考资料').getAttribute('aria-expanded').then(v=>v==='true'));
 await page.keyboard.press('ArrowRight');await page.keyboard.press('Enter');
 await page.locator('.material-text').waitFor();assert.match(await page.locator('.material-text').innerText(),/控制信号/);await page.locator('#materialsClose').click();
 await page.locator('#findObject').click();await page.locator('#finderInput').fill('ID.PC');await page.locator('#finderInput').press('Enter');await page.waitForFunction(()=>!document.querySelector('#deleteSelectionButton').disabled);await row('README.md').focus();await page.keyboard.press('Delete');await page.keyboard.press('Control+z');assert.ok(fs.readFileSync(source).equals(original));
 assert.equal(await page.locator('.file-row[tabindex="0"]').count(),1);
 phase='context and narrow layout';await row('任务说明.md').click({button:'right'});await page.screenshot({path:out+'/02-file-menu.png'});await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.dataset.path),'参考资料/任务说明.md');
 await page.locator('#railResize').focus();await page.keyboard.press('Home');await page.keyboard.press('Shift+ArrowLeft');
 const size=await page.locator('.file-heading').evaluate(e=>({scroll:e.scrollWidth,width:e.clientWidth}));assert.ok(size.scroll<=size.width);
 phase='new nested folder';await row('参考资料').click({button:'right'});await page.getByRole('menuitem',{name:'新建文件夹',exact:true}).click();
 const name=page.getByRole('textbox',{name:'文件夹名称',exact:true});await name.fill('设计记录');await name.press('Enter');await row('设计记录').waitFor();assert.ok(fs.statSync(folder+'/参考资料/设计记录').isDirectory());
 phase='new file collision and edit continuity';await row('设计记录').focus();await newItem('新建文件');
 const file=page.getByRole('textbox',{name:'文件名称',exact:true});await file.fill('分析.md');
 fs.writeFileSync(folder+'/外部新增.txt','外部编辑');await page.waitForTimeout(600);assert.equal(await file.inputValue(),'分析.md');await file.press('Enter');await row('分析.md').waitFor();assert.equal(fs.readFileSync(folder+'/参考资料/设计记录/分析.md','utf8'),'');
 await row('设计记录').focus();await newItem('新建文件');await file.fill('分析.md');await file.press('Enter');await page.getByRole('alert').filter({hasText:'同名'}).waitFor();assert.equal(await file.inputValue(),'分析.md');
 await page.screenshot({path:out+'/03-inline-create.png'});await file.press('Escape');
 phase='create usable circuit';await row('流水线').focus();await newItem('新建电路');await file.fill('算术逻辑单元');await file.press('Enter');
 await waitUntil(()=>session().then(s=>s.folder?.activeFile==='电路/流水线/算术逻辑单元.circ'&&s));await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden);
 assert.match(fs.readFileSync(folder+'/电路/流水线/算术逻辑单元.circ','utf8'),/<circuit name="main"/);
 assert.equal(await row('算术逻辑单元.circ').getAttribute('aria-current'),'true');assert.equal((await session()).workspace.dirty,false);
 phase='collapse and reveal';await option('折叠所有文件夹');assert.equal(await row('算术逻辑单元.circ').count(),0);await page.locator('#locateCurrentFile').click();await row('算术逻辑单元.circ').waitFor();
 phase='hidden files';await page.locator('#fileOptions').click();await page.getByRole('menuitemcheckbox',{name:'显示隐藏文件',exact:true}).click();await row('.notes').waitFor();await row('.notes').click();await row('思路.md').waitFor();
 phase='file changes';await option('文件改动');await page.getByRole('button',{name:/新增.*算术逻辑单元.circ/}).first().click();await page.waitForFunction(()=>document.querySelector('#fileDiff').textContent.includes('main'));await page.locator('#fileChangesClose').click();
 phase='folder-bound state';await page.locator('#questionInput').fill('我们一起理解控制信号。');await openFolder(other);assert.equal(await row('思路.md').count(),0);assert.match(await page.locator('.file-empty').innerText(),/还没有文件\s+新建电路/);await openFolder(folder);await row('思路.md').waitFor();
 await page.waitForFunction(()=>document.querySelector('#questionInput').value==='我们一起理解控制信号。');
 phase='restart';await app.close();app=null;await launch();await row('思路.md').waitFor({timeout:30000});await page.waitForFunction(()=>document.querySelector('#questionInput').value==='我们一起理解控制信号。');
 assert.equal((await session()).folder.activeFile,'电路/流水线/算术逻辑单元.circ');assert.ok(fs.readFileSync(source).equals(original));assert.deepEqual(errors,[]);
 const result={root,success:true,modelTurns:0,nativeCreatedCircuit:true,sourcePreserved:true};fs.writeFileSync(out+'/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(e){console.error('FAILED',phase,root,e);if(page){await page.screenshot({path:out+'/failure.png'}).catch(()=>{});console.error((await page.locator('#fileExplorer').innerText().catch(()=>'')),errors);}process.exitCode=1;}finally{if(app)await app.close();}})();
