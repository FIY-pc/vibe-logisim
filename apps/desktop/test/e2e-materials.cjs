'use strict';
// Actual Electron, course PDF/image and local material operations. The native
// picker returns fixture paths; model response is explicitly labelled IPC replay.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {_electron}=require('playwright'),{waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-material-e2e-'));
const out=repo+'/apps/desktop/docs/product/evidence/2026-09-15-materials';fs.mkdirSync(out,{recursive:true});
for(const name of ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar'])fs.copyFileSync(repo+'/exports/interface-editing/'+name,root+'/'+name);
const source=root+'/stage6-if-id.circ',original=fs.readFileSync(source);
const pdf=repo+'/workspaces/hust-riscv/original/course-package/硬件综合训练课程设计任务书  2026-8-3修订版.pdf';
const picture=repo+'/workspaces/hust-riscv/original/course-package/电路框架-cpu21-riscv/正确封装图.png';
const pdfBefore=fs.readFileSync(pdf),imageBefore=fs.readFileSync(picture),note=root+'/设计讨论.md';
const noteText='# IF_ID 设计讨论\n\n这是一份界面验收资料，不是课程要求。\n\n暂停时保留寄存器的值，继续写入时在有效边沿采样。\n\n<script>window.materialInjected=true</script>';
fs.writeFileSync(note,noteText);
const env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const errors=[];
async function launch(){
  app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',source,'--no-sandbox'],env});
  page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1500,height:960});
  await page.locator('#circuitList .circuit-item').filter({has:page.locator('strong',{hasText:/^IF_ID$/})}).click({timeout:90000});
  await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden);
  await waitUntil(()=>page.evaluate(()=>window.vibeDesktop.agent.getState()).then(s=>s.status==='ready'),{timeout:90000});
}
async function picker(files){await app.evaluate(({dialog},files)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:files});},files);}
const list=projectId=>page.evaluate(projectId=>window.vibeDesktop.materials.list({projectId}),projectId);
const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
const emit=event=>app.evaluate(({BrowserWindow},event)=>BrowserWindow.getAllWindows()[0].webContents.send('vibe-logisim:agent-event',event),event);

(async()=>{
 try {
  await launch();const initial=await session(),projectId=initial.workspace.id;
  await page.locator('#agentMaterials').click();await page.locator('.material-welcome').waitFor();await page.screenshot({path:out+'/01-empty.png'});
  await picker([note,pdf,picture]);await page.locator('#materialsAdd').click();
  await waitUntil(()=>page.locator('.material-row').count().then(n=>n===3),{timeout:30000});
  await page.locator('.material-text').waitFor();assert.equal(await page.evaluate(()=>window.materialInjected),undefined);
  const records=(await list(projectId)).items,noteItem=records.find(i=>i.name==='设计讨论.md'),pdfItem=records.find(i=>i.name.endsWith('.pdf')),imageItem=records.find(i=>i.name.endsWith('.png'));
  await page.screenshot({path:out+'/02-text.png'});
  await page.locator('.material-row[data-id="'+pdfItem.id+'"]').click();
  await page.locator('.material-image').waitFor({timeout:40000});
  await page.locator('#materialNext').click();await page.waitForFunction(()=>document.querySelector('#materialPage').textContent.startsWith('2 /'));
  await page.screenshot({path:out+'/03-pdf.png'});
  await page.locator('#materialTextMode').click();await page.locator('.material-text').waitFor();
  assert.ok((await page.locator('.material-text').textContent()).length>100);
  await page.locator('#materialQuote').click();await page.locator('.material-chip-label').getByText('第 2 页',{exact:false}).waitFor();
  await page.locator('#questionInput').fill('我先保留电路结构。请结合这两份引用一起讨论。');
  await page.locator('#agentMaterials').click();await page.locator('#materialsSearch').fill('设计讨论');assert.equal(await page.locator('.material-row').count(),1);
  await page.locator('.material-row').click();await page.locator('.material-text').waitFor();
  const quote='暂停时保留寄存器的值';
  await page.locator('.material-text').evaluate((node,text)=>{const start=node.firstChild.textContent.indexOf(text),range=document.createRange();range.setStart(node.firstChild,start);range.setEnd(node.firstChild,start+text.length);const selected=window.getSelection();selected.removeAllRanges();selected.addRange(range);},quote);
  await page.locator('#materialQuote').click();assert.equal(await page.locator('.material-chip').count(),2);
  assert.equal(await page.locator('#questionInput').inputValue(),'我先保留电路结构。请结合这两份引用一起讨论。');
  await page.screenshot({path:out+'/04-references.png'});
  await app.evaluate((_,repo)=>{
    const r=process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');
    const C=r('./codex-backend.cjs').CodexBackend;
    C.prototype.ask=async function(request){
      global.__materialRequest=request;global.__materialBackend=this;this.turnStarting=true;
      this.emit('event',{type:'user-message',id:'material-replay-user',text:request.question,context:request.context});
      this.emit('event',{type:'turn-started',turnId:'material-replay-turn'});
      return {};
    };
  },repo);
  await page.locator('#questionInput').press('Enter');
  const captured=await waitUntil(()=>app.evaluate(()=>global.__materialRequest),{timeout:60000});
  assert.equal(captured.context.materials.length,2);assert.equal(captured.context.materials[1].quote,quote);assert.equal(captured.context.materials[0].page,2);
  const stage=await app.evaluate(async()=>{const b=global.__materialBackend,work=await b.agentWorkspace.prepare(global.__materialRequest.context.revisionId);return work.directory;});
  for(const ref of captured.context.materials)assert.ok(fs.existsSync(path.join(stage,ref.path)));
  assert.deepEqual(fs.readFileSync(path.join(stage,pdfItem.path)),pdfBefore);
  await page.locator('#questionInput').fill('下一条草稿保留在这里');
  await page.locator('#agentMaterials').click();assert.equal(await page.locator('#materialsAdd').isEnabled(),false);
  const locked=await page.evaluate(({projectId,id})=>window.vibeDesktop.materials.remove({projectId,id}).then(()=>false,()=>true),{projectId,id:noteItem.id});assert.equal(locked,true);
  await page.locator('#materialsClose').click();
  await app.evaluate(()=>{global.__materialBackend.turnStarting=false;});
  const reply={type:'assistant-completed',itemId:'material-replay-answer',phase:'final_answer',text:`界面验收回放，不是模型回答：请查看 [任务书第 2 页](${captured.context.materials[0].reference}) 和 [设计讨论](${captured.context.materials[1].reference})。`};
  await emit(reply);await emit({type:'turn-completed',status:'completed'});
  assert.equal(await page.locator('#questionInput').inputValue(),'下一条草稿保留在这里');
  await page.locator('.material-reference').filter({hasText:'任务书第 2 页'}).click();
  await page.waitForFunction(()=>document.querySelector('#materialPage').textContent.startsWith('2 /'));
  await page.locator('#materialsSearch').fill('');await page.locator('.material-row[data-id="'+imageItem.id+'"]').click();
  await page.locator('.material-image').waitFor();await page.screenshot({path:out+'/05-image.png'});
  await page.locator('.material-row[data-id="'+noteItem.id+'"]').click();await page.locator('.material-text').waitFor();
  await page.locator('#materialsRemove').click();await page.locator('#materialsUndoBar').waitFor();
  assert.equal(fs.existsSync(path.join(stage,noteItem.path)),false);assert.equal(fs.readFileSync(note,'utf8'),noteText);
  await page.screenshot({path:out+'/06-removed.png'});
  await page.locator('#materialsUndo').click();await waitUntil(()=>list(projectId).then(r=>!r.items.find(i=>i.id===noteItem.id).removedAt));
  assert.equal(fs.readFileSync(path.join(stage,noteItem.path),'utf8'),noteText);
  await picker([note]);await page.locator('#materialsAdd').click();await waitUntil(()=>page.locator('#materialsAdd').isEnabled());assert.equal((await list(projectId)).items.length,3);
  fs.writeFileSync(note,noteText+'\n第二个版本');await picker([note]);await page.locator('#materialsAdd').click();await waitUntil(()=>list(projectId).then(r=>r.items.length===4));
  assert.equal((await list(projectId)).items.filter(i=>i.name==='设计讨论.md').length,2);
  await page.locator('.material-row[data-id="'+noteItem.id+'"]').click();await page.locator('.material-text').waitFor();
  await page.locator('#materialsRemove').click();await waitUntil(()=>list(projectId).then(r=>r.items.find(i=>i.id===noteItem.id).removedAt));
  await page.locator('#materialsClose').click();
  await app.close();app=null;await launch();
  assert.equal((await list(projectId)).items.length,4);
  assert.ok((await list(projectId)).items.find(i=>i.id===noteItem.id).removedAt);
  await emit(reply);await page.locator('.material-reference').filter({hasText:'设计讨论'}).click();await page.locator('.material-text').waitFor();
  assert.match(await page.locator('#materialsMeta').textContent(),/已移除/);assert.equal(await page.locator('#materialQuote').isEnabled(),false);
  await page.locator('#materialsRemove').click();await waitUntil(()=>list(projectId).then(r=>!r.items.find(i=>i.id===noteItem.id).removedAt));
  await page.locator('#materialsClose').click();
  await emit({type:'assistant-completed',itemId:'invalid-page-replay',text:`界面验收回放：[不存在的页](${pdfItem.reference}&page=9999)`});
  await page.locator('.material-reference').filter({hasText:'不存在的页'}).click();await page.locator('#materialsError').waitFor();
  assert.match(await page.locator('#materialsError').textContent(),/9999 页不存在/);assert.doesNotMatch(await page.locator('#materialsError').textContent(),/remote method|vibe-logisim:/);
  await page.screenshot({path:out+'/08-preview-error.png'});await page.getByRole('button',{name:'从第一页打开',exact:true}).click();await page.locator('.material-image').waitFor();await page.locator('#materialsClose').click();
  await page.locator('#agentMaterials').click();await page.locator('.material-row[data-id="'+pdfItem.id+'"]').click();await page.locator('.material-image').waitFor({timeout:40000});
  await page.setViewportSize({width:1100,height:760});await page.screenshot({path:out+'/07-compact.png'});
  assert.ok(await page.locator('#materialsDialog').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
  await page.keyboard.press('Escape');assert.equal(await page.locator('#agentMaterials').evaluate(n=>n===document.activeElement),true);
  const second=root+'/second.circ';fs.copyFileSync(source,second);await picker([second]);await page.locator('#openButton').click();
  await waitUntil(()=>session().then(s=>s.workspace.id!==projectId),{timeout:60000});
  const secondId=(await session()).workspace.id;assert.deepEqual((await list(secondId)).items,[]);
  const wrong=await page.evaluate(projectId=>window.vibeDesktop.materials.list({projectId}).then(()=>false,()=>true),projectId);assert.equal(wrong,true);
  assert.equal((await session()).revision.id,initial.revision.id);
  assert.deepEqual(fs.readFileSync(source),original);assert.deepEqual(fs.readFileSync(pdf),pdfBefore);assert.deepEqual(fs.readFileSync(picture),imageBefore);assert.deepEqual(errors,[]);
  fs.writeFileSync(out+'/result.json',JSON.stringify({root,projectId,materialCount:4,pdf:'real course task sheet, page 2, image and text',image:'real course packaging diagram',quotes:'host-resolved file identity, page and exact excerpt',modelTurns:0,response:'labelled IPC replay',modelWorkspace:'actual AgentWorkspace.prepare and file bytes',removal:'remove-undo and source unchanged',persistence:'actual Electron restart, archived reference readable and restored',previewFailure:'invalid page reported, then actual PDF reopened',isolation:'equal-content second circuit and rejected old-project request',sourceUnchanged:true},null,2));
  console.log(out);
 }catch(error){if(page)await page.screenshot({path:out+'/failure.png'}).catch(()=>{});throw error;}
 finally{if(app)await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
