'use strict';
// Real desktop and native runtime. File writes stand in for an external editor;
// no model generation is used to prove the folder/document contract.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require('playwright');
const {waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),root=fs.mkdtempSync('/tmp/vibe-folder-');
const folder=root+'/我的电路',empty=root+'/新工作区',out=repo+'/apps/desktop/docs/product/evidence/2026-09-16-folder-workspace';
fs.mkdirSync(folder);fs.mkdirSync(empty);fs.mkdirSync(out,{recursive:true});
for(const name of ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar'])fs.copyFileSync(repo+'/exports/interface-editing/'+name,folder+'/'+name);
fs.copyFileSync(folder+'/stage6-if-id.circ',folder+'/第二份.circ');
fs.writeFileSync(folder+'/任务说明.md','# 本次构建\n\n先理解 IF_ID，再修改控制信号。');
const original=fs.readFileSync(folder+'/stage6-if-id.circ');
const env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const errors=[],requests=[];let phase='launch';
const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
async function openFolder(file){await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.locator('#openButton').click();await waitUntil(()=>session().then(s=>s.folder?.root===file&&s));const active=await session();await page.waitForFunction(id=>document.querySelector('#questionInput').dataset.workspaceId===id&&!document.querySelector('#questionInput').disabled,active.folder.id);}
async function select(file){await page.locator('.file-row').filter({hasText:file}).click();await waitUntil(()=>session().then(s=>s.source?.path===folder+'/'+file&&s));await page.waitForFunction(()=>document.querySelectorAll('#circuitList button').length>0);}
async function launch(){app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop','--no-sandbox'],env});page=await app.firstWindow();page.on('response',async r=>{if(/\/api\/(session|circuit|selection)(\?|$)/.test(r.url())){try{const b=await r.json();requests.push({url:r.url(),status:r.status(),body:r.request().postData(),revision:b.revision,source:b.source?.path});}catch{}}});page.on('pageerror',e=>{errors.push(e.stack);console.error(e.stack);});await page.setViewportSize({width:1500,height:960});await app.evaluate(({app},repo)=>{const require=process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');require('./codex-backend.cjs').CodexBackend.prototype.ask=async()=>{throw new Error('Generation disabled for folder acceptance');};},repo);}
(async()=>{try{
 await launch();phase='open folder';await openFolder(folder);
 assert.equal((await session()).workspace??null,null);assert.equal(await page.locator('.file-row').count(),5);
 await page.locator('#questionInput').fill('先理解输入输出，再一起修改。');
 phase='select circuit';await select('stage6-if-id.circ');
 const first=await session();assert.ok(first.revision.id); // verified below against actual runtime payload
 await page.locator('#circuitList button').filter({has:page.locator('strong',{hasText:/^IF_ID$/})}).click();
 await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden);
 await page.screenshot({path:out+'/01-folder-circuit.png'});
 phase='resize and menu';const oldHeight=await page.locator('#fileExplorer').evaluate(e=>e.offsetHeight);await page.locator('#filesResize').focus();await page.keyboard.press('ArrowDown');assert.ok(await page.locator('#fileExplorer').evaluate(e=>e.offsetHeight)>oldHeight);await page.locator('#collapseFiles').click();assert.equal(await page.locator('#fileTree').isVisible(),false);await page.locator('#collapseFiles').click();await page.locator('.file-row').filter({hasText:'任务说明.md'}).click({button:'right'});await page.getByRole('menuitem',{name:'打开',exact:true}).click();
 phase='preview';await page.locator('.material-text').waitFor();assert.match(await page.locator('.material-text').innerText(),/先理解 IF_ID/);await page.locator('#materialQuote').click();
 assert.equal(await page.locator('.material-chip').count(),1);
 phase='switch document';await select('第二份.circ');assert.equal((await session()).folder.conversationKey,first.folder.conversationKey);assert.equal(await page.locator('#questionInput').inputValue(),'先理解输入输出，再一起修改。');assert.equal(await page.locator('.material-chip').count(),1);
 phase='external file';fs.writeFileSync(folder+'/新增资料.txt','从文件管理器放入的资料');await page.locator('.file-row').filter({hasText:'新增资料.txt'}).waitFor({timeout:10000});
 phase='disk edit';const before=await session();fs.writeFileSync(folder+'/第二份.circ',original.toString().replace('ID.PC','DECODE.PC'));
 await waitUntil(()=>session().then(s=>s.revision?.id!==before.revision.id&&s),{timeout:30000});
 await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden);
 phase='undo';await page.locator('#fileOptions').click();await page.locator('#showFileChanges').click();await page.getByRole('button',{name:/修改\s+第二份.circ/}).first().click();await page.waitForFunction(()=>document.querySelector('#fileDiff').textContent.includes('DECODE.PC'));await page.screenshot({path:out+'/02-file-changes.png'});
 await page.locator('.file-change-group').filter({hasText:'第二份.circ'}).first().getByRole('button',{name:'撤销这次改动'}).click();await waitUntil(()=>Promise.resolve(fs.readFileSync(folder+'/第二份.circ').equals(original)));await page.waitForFunction(()=>!document.querySelector('#askButton').disabled);await page.keyboard.press('Escape');
 phase='human canvas write through';
 await page.locator('#findObject').click();await page.locator('#finderInput').fill('ID.PC');await page.locator('#finderInput').press('Enter');
 const label=page.getByRole('textbox',{name:'标签',exact:true});await label.fill('HUMAN.PC');await label.press('Enter');
 await waitUntil(()=>Promise.resolve(fs.readFileSync(folder+'/第二份.circ','utf8').includes('HUMAN.PC')));
 await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden&&!document.querySelector('#askButton').disabled);
 assert.equal((await session()).workspace.dirty,false);assert.ok(fs.readFileSync(folder+'/stage6-if-id.circ').equals(original));
 phase='agent entry replay';
 await app.evaluate((_,{repo})=>{
   const require=process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');
   require('./codex-backend.cjs').CodexBackend.prototype.ask=async function(request){
     const binds=require('node:child_process').execFileSync('systemctl',['--user','show',this.isolationUnit,'-p','BindPaths','--value'],{encoding:'utf8'});
     global.__folderProbe={cwd:this.workDir,workspaceKey:request.workspaceKey,context:request.context,realFolderMounted:binds.includes(this.workDir+':/tmp/workspace')};
     const binding=await this.agentWorkspace.prepare(request.context.revisionId);
     require('node:fs').writeFileSync(require('node:path').join(this.workDir,'协作记录.md'),'已连接真实工作目录。');
     if(!request.context.revisionId){
       const xml='<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/><circuit name="main"><comp lib="0" name="Clock" loc="(100,100)"/><comp lib="0" name="Pin" loc="(300,100)"><a name="facing" val="west"/><a name="output" val="true"/><a name="label" val="Q"/></comp><wire from="(100,100)" to="(300,100)"/></circuit></project>';
       const target=request.context.folder.activeFile||'新电路.circ';
       require('node:fs').writeFileSync(require('node:path').join(this.workDir,target),xml);
       await this.agentWorkspace.synchronize(binding,target);
     }
     await this.agentWorkspace.finish(binding,{isCurrent:()=>true,completed:true});
     return {threadId:'labelled-transport-replay',turnId:'no-generation',revisionId:request.context.revisionId};
   };
 },{repo});
 await page.locator('#fileChanges').evaluate(e=>{if(e.open)e.close();});
 await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden);
 await page.locator('#askButton').click();
 await waitUntil(()=>Promise.resolve(fs.existsSync(folder+'/协作记录.md')),{timeout:5000});
 const probe=await app.evaluate(()=>global.__folderProbe);assert.equal(probe.cwd,folder);assert.equal(probe.realFolderMounted,true);assert.equal(probe.workspaceKey,first.folder.conversationKey);assert.equal(probe.context.materials[0].path,'任务说明.md');
 await page.waitForFunction(()=>document.querySelector('#questionInput').value==='');
 await page.locator('#questionInput').fill('先理解输入输出，再一起修改。');
 // Reattach reference after the submitted draft was correctly acknowledged.
 await page.locator('.file-row').filter({hasText:'任务说明.md'}).click();await page.locator('.material-text').waitFor();await page.locator('#materialQuote').click();
 phase='empty workspace';await openFolder(empty);assert.equal((await session()).workspace??null,null);assert.equal(await page.locator('#questionInput').inputValue(),'');await page.locator('#questionInput').fill('在这里新建一个全加器');await page.screenshot({path:out+'/03-empty-folder.png'});
 await page.locator('#askButton').click();await waitUntil(()=>session().then(s=>s.folder?.activeFile==='新电路.circ'&&s));
 await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden&&document.querySelector('#currentCircuitName').textContent==='main');
 assert.equal((await app.evaluate(()=>global.__folderProbe)).cwd,empty);
 // This is an actual native clock simulation of the newly created on-disk document.
 await page.locator('#simulationMenuButton').focus();await page.keyboard.press('Control+t');
 const running=await waitUntil(()=>page.evaluate(()=>fetch('/api/simulation').then(r=>r.json())).then(s=>s.observation?.ticks>=1&&s),{timeout:30000});
 await page.screenshot({path:out+'/04-created-and-running.png'});
 phase='kept observation across documents';
 await page.keyboard.press('F6');const keptProject=(await session()).workspace.id;
 await waitUntil(()=>page.evaluate(id=>fetch('/api/moments?projectId='+id).then(r=>r.json()),keptProject).then(items=>items.length));
 await page.locator('#simulationMenuButton').click();await page.locator('#momentOpen').click();await page.locator('.moment-title').first().click();await page.locator('#momentAttach').click();
 fs.copyFileSync(empty+'/新电路.circ',empty+'/另一个.circ');await page.locator('.file-row').filter({hasText:'另一个.circ'}).waitFor();await page.locator('.file-row').filter({hasText:'另一个.circ'}).click();
 await waitUntil(()=>session().then(s=>s.folder?.activeFile==='另一个.circ'&&s));await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden);
 await page.locator('.moment-chip button').first().click();await page.locator('#momentViewer img').first().waitFor();await page.locator('#momentClose').click();
 await page.locator('#questionInput').fill('对照刚才留存的信号继续讨论');await page.locator('#askButton').click();await page.waitForFunction(()=>document.querySelector('#questionInput').value==='');
 assert.equal((await app.evaluate(()=>global.__folderProbe)).context.keptMoments[0].projectId,keptProject);
 phase='repair invalid file through chat';fs.writeFileSync(empty+'/另一个.circ','<broken');await page.locator('#folderError').waitFor();await page.locator('#questionInput').fill('修复当前电路文件');await page.locator('#askButton').click();await page.waitForFunction(()=>document.querySelector('#questionInput').value==='');assert.ok(fs.readFileSync(empty+'/另一个.circ','utf8').includes('<circuit'));
 phase='return folder';await openFolder(folder);assert.equal(await page.locator('#questionInput').inputValue(),'先理解输入输出，再一起修改。');assert.equal((await session()).folder.activeFile,'第二份.circ');
 phase='restart';await app.close();app=null;await launch();await page.waitForFunction(()=>document.querySelector('#questionInput').value==='先理解输入输出，再一起修改。');assert.equal((await session()).folder.root,folder);assert.equal(await page.locator('.material-chip').count(),1);
 assert.deepEqual(errors,[]);assert.ok(fs.readFileSync(folder+'/stage6-if-id.circ').equals(original));
 console.log(JSON.stringify({root,modelTurns:0,success:true}));
}catch(e){console.error('FAILED',phase,root,e);if(page)console.error(await page.locator('#agentNoticeDetails').textContent());fs.writeFileSync(root+'/requests.json',JSON.stringify(requests,null,2));if(page)await page.screenshot({path:out+'/failure.png'}).catch(()=>{});process.exitCode=1;}finally{if(app)await app.close();}})();
