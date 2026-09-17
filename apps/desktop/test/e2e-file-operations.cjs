'use strict';
// Real Electron mouse drags, context menu, disk moves/trash and draft stores.
// No model process is launched and no generated answer is used as evidence.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require('playwright'),{waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),base=path.join(require('node:os').homedir(),'.cache/vibe-logisim-e2e');
fs.mkdirSync(base,{recursive:true});
// The OS refuses trash on /tmp's internal tmpfs mount. Use the user's filesystem
// and a private XDG trash, while keeping every circuit an isolated fixture.
const root=fs.mkdtempSync(base+'/file-operations-'),folder=root+'/工作区';
fs.mkdirSync(folder+'/子目录',{recursive:true});fs.mkdirSync(folder+'/归档');
const original=fs.readFileSync(repo+'/apps/desktop/electron/templates/blank.circ');
fs.writeFileSync(folder+'/main.circ',original);fs.writeFileSync(folder+'/说明.md','请说明进位如何产生。');fs.writeFileSync(folder+'/待删除.txt','可以从回收站恢复');
fs.writeFileSync(root+'/外部说明.txt','来自系统文件管理器');
const env={...process.env,XDG_CONFIG_HOME:root+'/config',XDG_DATA_HOME:root+'/data',VIBE_LOGISIM_STATE_DIR:root+'/state',VIBE_LOGISIM_CODEX:root+'/no-agent'};delete env.ELECTRON_RUN_AS_NODE;
let app,page,phase='launch';const errors=[];
const file=relative=>page.locator('.file-row[data-path='+JSON.stringify(relative)+']');
const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
async function launch(){
 app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',folder+'/main.circ','--no-sandbox'],env});
 page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1500,height:960});
 await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden&&!document.querySelector('#questionInput').disabled&&document.querySelector('#questionInput').dataset.conversationId);
}
async function drag(source,target,{hover=0}={}){
 let a,b;await waitUntil(async()=>{a=await source.boundingBox();b=await target.boundingBox();return a&&b;});
 await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(a.x+a.width/2+8,a.y+a.height/2,{steps:4});
 await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:12});
 if(hover){await new Promise(resolve=>setTimeout(resolve,hover));assert.equal(await target.getAttribute('aria-expanded'),'true');assert.match(await target.getAttribute('class'),/is-drop-target/);assert.equal(await page.locator('#fileExplorer .is-drop-target').count(),1);assert.equal(await page.locator('#fileExplorer.is-file-drop,.file-drop-hint').count(),0);await page.screenshot({path:root+'/directory-drag.png'});}
 await page.mouse.move(b.x+b.width/2+1,b.y+b.height/2,{steps:2});await page.mouse.up();
}
async function preview(text){await page.locator('.material-chip-label').first().click();await waitUntil(async()=> (await page.locator('#materialsPreview').innerText()).includes(text));await page.locator('#materialsClose').click();}
async function changes(){await page.locator('#fileOptions').click();await page.getByRole('menuitem',{name:'文件改动',exact:true}).click();}
(async()=>{try{
 await launch();const before=await session(),conversation=await page.locator('#questionInput').getAttribute('data-conversation-id');
 phase='drag file to assistant';await drag(file('说明.md'),page.locator('#questionInput'));await page.locator('.material-chip-label').waitFor();assert.equal(await page.locator('#materialsDialog').evaluate(el=>el.open),false);await preview('请说明进位');
 await drag(file('说明.md'),page.locator('#questionInput'));assert.equal(await page.locator('.material-chip').count(),1);
 phase='move referenced file';await drag(file('说明.md'),file('子目录'));await waitUntil(()=>fs.existsSync(folder+'/子目录/说明.md'));assert.equal(fs.existsSync(folder+'/说明.md'),false);await preview('请说明进位');
 phase='hover expand and move directory';await drag(file('子目录'),file('归档'),{hover:850});await waitUntil(()=>fs.existsSync(folder+'/归档/子目录/说明.md'));assert.equal(fs.existsSync(folder+'/子目录'),false);await file('归档/子目录/说明.md').waitFor();await preview('请说明进位');
 phase='reject descendant move';await drag(file('归档'),file('归档/子目录'));assert.ok(fs.existsSync(folder+'/归档/子目录/说明.md'));
 phase='edit before moving circuit';
 await page.locator('#addComponentTool').click();await page.locator('#componentSearch').fill('与门');await page.getByRole('button',{name:'与门',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#objectInspector [data-attribute]')&&!document.querySelector('#placementToolbar .placement-loading'));
 const canvas=await page.locator('#circuitCanvas').boundingBox();await page.mouse.click(canvas.x+canvas.width*.5,canvas.y+canvas.height*.4);await page.keyboard.press('Escape');
 await waitUntil(async()=>(await session()).revision.id!==before.revision.id);await page.waitForFunction(()=>document.querySelector('#appShell').getAttribute('aria-busy')!=='true'&&!document.querySelector('[data-optimistic=true]'));
 await waitUntil(async()=>!(await session()).workspace.dirty);const edited=await session(),editedBytes=fs.readFileSync(folder+'/main.circ');await page.locator('#filesTab').click();
 phase='move active circuit';await drag(file('main.circ'),file('归档'));await waitUntil(async()=>(await session()).folder.activeFile==='归档/main.circ');
 const after=await session();assert.equal(after.workspace.id,before.workspace.id);assert.equal(after.revision.id,edited.revision.id);assert.equal(after.workspace.dirty,edited.workspace.dirty);assert.deepEqual(after.workspace.history,edited.workspace.history);assert.equal(after.folder.id,before.folder.id);assert.equal(await page.locator('#questionInput').getAttribute('data-conversation-id'),conversation);assert.deepEqual(fs.readFileSync(folder+'/归档/main.circ'),editedBytes);
 phase='edit saves at moved location';await page.locator('#addComponentTool').click();await page.locator('#componentSearch').fill('或门');await page.getByRole('button',{name:'或门',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('#placementToolbar .placement-loading'));
 await page.mouse.click(canvas.x+canvas.width*.7,canvas.y+canvas.height*.6);await page.keyboard.press('Escape');
 await waitUntil(async()=>{const s=await session();return s.revision.id!==edited.revision.id&&!s.workspace.dirty;});await page.waitForFunction(()=>document.querySelector('#appShell').getAttribute('aria-busy')!=='true');await page.locator('#filesTab').click();const saved=fs.readFileSync(folder+'/归档/main.circ');assert.match(saved.toString(),/AND Gate/);assert.match(saved.toString(),/OR Gate/);assert.equal(fs.existsSync(folder+'/main.circ'),false);
 phase='undo move from file history';await changes();const group=page.locator('.file-change-group').filter({has:page.getByText('移动 main.circ',{exact:true})});await group.getByRole('button',{name:'撤销这次改动'}).click();await waitUntil(()=>fs.existsSync(folder+'/main.circ'));await page.locator('#fileChangesClose').click();assert.equal((await session()).workspace.id,before.workspace.id);
 phase='collision never overwrites';fs.writeFileSync(folder+'/归档/main.circ','同名文件原稿');await file('归档/main.circ').waitFor();await drag(file('main.circ'),file('归档'));await waitUntil(async()=> (await page.locator('#toast').innerText()).includes('同名文件'));assert.deepEqual(fs.readFileSync(folder+'/main.circ'),saved);assert.equal(fs.readFileSync(folder+'/归档/main.circ','utf8'),'同名文件原稿');
 phase='context trash and restore';await file('待删除.txt').click({button:'right'});await page.getByRole('menuitem',{name:'删除（移到回收站）',exact:true}).click();await waitUntil(()=>!fs.existsSync(folder+'/待删除.txt'));await file('待删除.txt').waitFor({state:'detached'});assert.ok(fs.readdirSync(root+'/data/Trash/files').some(name=>name.startsWith('待删除.txt')));
 await changes();await page.locator('.file-change-group').filter({has:page.getByText('移到回收站：待删除.txt',{exact:true})}).getByRole('button',{name:'撤销这次改动'}).click();await waitUntil(()=>fs.existsSync(folder+'/待删除.txt'));await page.locator('#fileChangesClose').click();assert.equal(fs.readFileSync(folder+'/待删除.txt','utf8'),'可以从回收站恢复');
 phase='delete by keyboard';await file('待删除.txt').click({button:'right'});await page.keyboard.press('Escape');await page.keyboard.press('Backspace');await waitUntil(()=>!fs.existsSync(folder+'/待删除.txt'));
 phase='external file to assistant';const cdp=await page.context().newCDPSession(page),b=await page.locator('#questionInput').boundingBox();for(const type of ['dragEnter','dragOver','drop'])await cdp.send('Input.dispatchDragEvent',{type,x:b.x+20,y:b.y+20,data:{items:[],files:[root+'/外部说明.txt'],dragOperationsMask:1}});
 await waitUntil(async()=>await page.locator('.material-chip').count()===2);assert.equal(fs.readFileSync(folder+'/外部说明.txt','utf8'),'来自系统文件管理器');assert.ok(fs.existsSync(root+'/外部说明.txt'));
 phase='draft remains per conversation';await page.locator('#questionInput').fill('根据这些资料继续');await page.locator('#conversationNew').click();await waitUntil(async()=>(await page.locator('#questionInput').getAttribute('data-conversation-id'))!==conversation);assert.equal(await page.locator('.material-chip').count(),0);await page.locator('#conversationPicker').click();await page.locator('.conversation-row[data-conversation-id='+JSON.stringify(conversation)+'] .conversation-open').click();await waitUntil(async()=>(await page.locator('#questionInput').getAttribute('data-conversation-id'))===conversation);assert.equal(await page.locator('.material-chip').count(),2);
 phase='reopen preserves references and document identity';await app.close();app=null;await launch();assert.equal((await session()).workspace.id,before.workspace.id);await waitUntil(async()=>await page.locator('.material-chip').count()===2);await preview('请说明进位');assert.equal(await page.locator('#questionInput').inputValue(),'根据这些资料继续');
 await page.screenshot({path:root+'/file-operations.png'});assert.deepEqual(errors,[]);
 console.log(JSON.stringify({root,success:true,modelTurns:0,realMouseDrags:true,activeIdentityPreserved:true,moveUndo:true,trashAndRestore:true,referenceFollowsMove:true,externalSourcePreserved:true},null,2));
}catch(error){console.error({root,phase},error);if(page){console.error(await page.locator('#toast').innerText().catch(()=>''));console.error(await page.locator('#fileExplorer').innerText().catch(()=>''));await page.screenshot({path:root+'/failure.png'}).catch(()=>{});}process.exitCode=1;}finally{await app?.close();}})();
