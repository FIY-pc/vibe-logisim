'use strict';
// Real Electron clicks, production file services and native rendering. Chat is
// an explicit fixture; optionally copy a real delivered circuit into the fixture.
// No Codex process or model turn is started; authentication is not copied.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require('playwright'),{waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),root=fs.mkdtempSync('/tmp/vibe-delivery-links-');
const folder=root+'/original',other=root+'/other',xml=fs.readFileSync(repo+'/apps/desktop/electron/templates/blank.circ');
for(const dir of [folder,other]){fs.mkdirSync(dir);fs.writeFileSync(dir+'/start.circ',xml);fs.writeFileSync(dir+'/design.circ',xml);fs.writeFileSync(dir+'/说明 文件.md',dir===folder?'ORIGINAL REFERENCE':'WRONG WORKSPACE');}
const delivered=process.argv[2]?fs.readFileSync(path.resolve(process.argv[2])):xml;
fs.writeFileSync(folder+'/design.circ',delivered);fs.mkdirSync(folder+'/archive');
fs.writeFileSync(root+'/host-secret.txt','HOST SECRET');fs.symlinkSync(root+'/host-secret.txt',folder+'/escape.txt');
const env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state',VIBE_LOGISIM_CODEX:root+'/no-agent'};delete env.ELECTRON_RUN_AS_NODE;
let app,page,phase='launch';const errors=[];
const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
const send=event=>app.evaluate(({BrowserWindow},event)=>BrowserWindow.getAllWindows()[0].webContents.send('vibe-logisim:agent-event',event),event);
const link=name=>page.getByRole('button',{name,exact:true});
async function launch(){
  app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',folder+'/start.circ','--no-sandbox'],env});
  page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));await page.setViewportSize({width:1500,height:960});
  await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden&&!document.querySelector('#questionInput').disabled&&document.querySelector('#questionInput').dataset.conversationId);
}
async function history(text,context,id='answer'){
  await send({type:'history',messages:[{type:'user',id:'user-'+id,text:'查看交付文件',context},{type:'assistant',id,text}]});
}
async function preview(name,expected){await link(name).click();await waitUntil(async()=>(await page.locator('#materialsPreview').innerText()).includes(expected));}
async function openFolder(target){
  await app.evaluate(({dialog},target)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[target]});},target);
  await page.locator('#openButton').click();await waitUntil(async()=>(await session()).folder?.root===target);
  const id=(await session()).folder.id;await page.waitForFunction(id=>document.querySelector('#questionInput').dataset.workspaceId===id&&!document.querySelector('#questionInput').disabled,id);
}
(async()=>{try{
  await launch();const original=await session(),context={folderId:original.folder.id,projectId:original.workspace.id};
  const uri='workspace://file?'+new URLSearchParams({folderId:context.folderId,path:'说明 文件.md',pathVersion:0});
  const text=`[工作区资料](${uri})\n\n[design.circ](/tmp/workspace/design.circ)\n\n[旧资料](material://file?projectId=${context.projectId}&id=${encodeURIComponent('说明 文件.md')})\n\n[符号链接](/tmp/workspace/escape.txt)\n\n[外部文件](/etc/passwd) [目录遍历](/tmp/workspace/../host-secret.txt) [脚本](javascript:alert(1))`;
  phase='workspace URI preview';await history(text,context);
  await preview('工作区资料','ORIGINAL REFERENCE');await page.screenshot({path:root+'/workspace-preview.png'});await page.locator('#materialsClose').click();
  phase='native delivered circuit opens canvas';await link('design.circ').click();
  await waitUntil(async()=>(await session()).folder.activeFile==='design.circ');await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden);
  const opened=await session();assert.notEqual(opened.workspace.id,original.workspace.id);assert.equal(await page.locator('#materialsDialog').evaluate(node=>node.open),false);
  await page.screenshot({path:root+'/native-circuit.png'});assert.deepEqual(fs.readFileSync(folder+'/design.circ'),delivered);
  phase='legacy material and unsafe targets';await preview('旧资料','ORIGINAL REFERENCE');await page.locator('#materialsClose').click();
  for(const name of ['外部文件','目录遍历','脚本'])assert.equal(await link(name).count(),0);
  await link('符号链接').click();await waitUntil(async()=>(await page.locator('#toast').innerText()).includes('工作区之外'));assert.equal(await page.locator('#materialsDialog').evaluate(node=>node.open),false);

  phase='streaming answer keeps its original move version';
  await send({type:'user-message',id:'live-user',text:'保留文件引用',context});
  await send({type:'assistant-delta',itemId:'live-answer',delta:'[流式文件](/tmp/workspace/'});
  await send({type:'assistant-delta',itemId:'live-answer',delta:encodeURIComponent('说明 文件.md')+')'});
  await send({type:'assistant-completed',itemId:'live-answer',text:'[流式文件](/tmp/workspace/'+encodeURIComponent('说明 文件.md')+')'});
  await preview('流式文件','ORIGINAL REFERENCE');await page.locator('#materialsClose').click();
  // Move through the existing production service, then reuse the old name.
  await page.evaluate(({folderId})=>window.vibeDesktop.folder.move({folderId,from:'说明 文件.md',to:'archive/说明 文件.md'}),context);
  fs.writeFileSync(folder+'/说明 文件.md','REUSED PATH');
  await waitUntil(async()=>(await session()).folder.moves.length===1);
  await preview('流式文件','ORIGINAL REFERENCE');await page.locator('#materialsClose').click();
  await preview('工作区资料','ORIGINAL REFERENCE');await page.locator('#materialsClose').click();

  phase='old message cannot open a same-named file in another folder';
  await openFolder(other);const otherBefore=await session();
  await history(text,context,'foreign-answer');await link('design.circ').click();await waitUntil(async()=>(await page.locator('#toast').innerText()).includes('另一工作区'));
  assert.equal((await session()).folder.activeFile,otherBefore.folder.activeFile);assert.equal((await session()).workspace?.id,otherBefore.workspace?.id);
  await link('工作区资料').click();assert.equal(await page.locator('#materialsDialog').evaluate(node=>node.open),false);
  await page.screenshot({path:root+'/foreign-workspace-rejected.png'});

  phase='missing message context is not filled from current folder';
  await history('[无归属](/tmp/workspace/design.circ)',null,'unbound-answer');await link('无归属').click();await waitUntil(async()=>(await page.locator('#toast').innerText()).includes('无法确认'));
  assert.equal((await session()).folder.activeFile,otherBefore.folder.activeFile);
  phase='restored versioned URI still follows move, ambiguous raw history is refused';
  await openFolder(folder);await history(text,context,'restored-answer');await preview('工作区资料','ORIGINAL REFERENCE');await page.locator('#materialsClose').click();
  await history('[历史路径](/tmp/workspace/'+encodeURIComponent('说明 文件.md')+')',context,'ambiguous-answer');await link('历史路径').click();await waitUntil(async()=>(await page.locator('#toast').innerText()).includes('历史文件路径'));
  assert.equal(await page.locator('#materialsDialog').evaluate(node=>node.open),false);
  assert.deepEqual(errors,[]);assert.deepEqual(fs.readFileSync(folder+'/design.circ'),delivered);
  const result={root,success:true,modelTurns:0,chat:'synthetic history and streaming events',deliveredCircuit:process.argv[2]||'blank fixture',workspacePreview:true,nativeCircuitCanvas:true,foreignFolderRejected:true,unboundRejected:true,symlinkEscapeRejected:true,movesFollowed:true,ambiguousHistoryRejected:true,sourceUnchanged:true};
  fs.writeFileSync(root+'/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){console.error({root,phase,error,errors});await page?.screenshot({path:root+'/failure.png'}).catch(()=>{});process.exitCode=1;}
finally{await app?.close();}})();
