'use strict';
// Real Electron navigation + production CircuitPlugin calls. The caller is
// mechanical, not a model. No source edits or authentication copies.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {_electron}=require('playwright');
const {waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..');
const root=fs.mkdtempSync(path.join(os.homedir(),'.local/share/vibe-logisim-dev/runs/canvas-handoff-'));
const folder=path.join(root,'workspace');fs.mkdirSync(folder);
// A course package directory holding cpu21-riscv.circ, cs3410.jar and riscv-probe.jar; not part of the repository.
const source=process.env.VIBE_COURSE_PACKAGE||path.join(repo,'workspaces/hust-riscv/original/course-package/电路框架-cpu21-riscv');
if(!['cpu21-riscv.circ','cs3410.jar','riscv-probe.jar'].every(name=>fs.existsSync(path.join(source,name)))){console.log('SKIP: course package not present ('+source+'); set VIBE_COURSE_PACKAGE to a directory containing cpu21-riscv.circ, cs3410.jar, riscv-probe.jar');process.exit(0);}
for(const name of ['cpu21-riscv.circ','cs3410.jar','riscv-probe.jar'])fs.copyFileSync(path.join(source,name),path.join(folder,name));
const file=path.join(folder,'cpu21-riscv.circ'),original=fs.readFileSync(file);
const entry=path.join(root,'main.cjs');
fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'vibe-logisim-canvas-check',main:'main.cjs'}));
fs.writeFileSync(entry,`
global.handoffRequire=require;
const mod=require(${JSON.stringify(path.join(repo,'apps/desktop/electron/desktop-workspace.cjs'))});
const Base=mod.DesktopWorkspace;
mod.DesktopWorkspace=class extends Base {constructor(...args){super(...args);global.handoffWorkspace=this;}};
require(${JSON.stringify(path.join(repo,'apps/desktop/electron/main.cjs'))});
`);
const env={...process.env,XDG_CONFIG_HOME:path.join(root,'config'),VIBE_LOGISIM_STATE_DIR:path.join(root,'state')};
delete env.ELECTRON_RUN_AS_NODE;
const report={passed:false,modelCalls:0,receipts:[],errors:[]};
let app,page;
const get=url=>page.evaluate(async url=>(await fetch(url)).json(),url);
const call=args=>app.evaluate(async(_electron,{repo,args})=>{
 const {DirectAgentWorkspace}=global.handoffRequire(repo+'/apps/desktop/electron/direct-agent-workspace.cjs');
 const {CircuitPlugin}=global.handoffRequire(repo+'/apps/desktop/electron/circuit-plugin.cjs');
 const desktop=global.handoffWorkspace,workspace=new DirectAgentWorkspace(desktop),initial=await desktop.backend.session();
 const work={folderId:desktop.folder.current.id,projectId:initial.workspace.id,revisionId:initial.revision.id,sourceName:desktop.folder.current.activeFile};
 const plugin=new CircuitPlugin({workspace,invoke:p=>desktop.backend.circuitTool(p)});plugin.configure(await desktop.backend.circuitPlugin());
 const pending={work,projectId:work.projectId,revisionId:work.revisionId};
 return plugin.call({tool:'open_circuit',arguments:args,threadId:'mechanical',turnId:'canvas',callId:'open'},
  {pending,assertCurrent:()=>workspace.assert(work),emit(){},updateBinding(s){pending.projectId=s.workspace?.id;pending.revisionId=s.revision?.id;}});
},{repo,args});
const current=()=>page.locator('#currentCircuitName').innerText();
const choose=async name=>{await page.locator('#circuitList').getByRole('button',{name,exact:true}).click();await waitUntil(async()=>await current()===name,{timeout:30000});};
(async()=>{try{
 app=await _electron.launch({executablePath:require('electron'),args:[root,file],chromiumSandbox:true,env,timeout:30000});
 page=await app.firstWindow();page.setDefaultTimeout(30000);page.on('pageerror',e=>report.errors.push(e.message));
 await waitUntil(async()=>await page.locator('#circuitList button').count()===13,{timeout:90000});
 console.log('course opened');
 const initial=await get('/api/session');report.projectId=initial.workspace.id;report.revisionId=initial.revision.id;
 await choose('◆ALU');
 // Reopening without a named target preserves the human's chosen definition.
 let result=await call({path:'cpu21-riscv.circ'});report.receipts.push(result);
 assert.equal(result.activeCircuit,'◆ALU');assert.equal(result.canvas.status,'shown');assert.equal(await current(),'◆ALU');
 console.log('current view preserved');
 result=await call({path:'cpu21-riscv.circ',circuit:'◆单周期硬布线控制器'});report.receipts.push(result);
 assert.equal(result.activeCircuit,'◆单周期硬布线控制器');assert.equal(await current(),result.activeCircuit);
 console.log('controller opened through production plugin');
 await page.screenshot({path:path.join(root,'controller.png')});
 const folderId=initial.folder.id;
 await choose('◆Regifile');
 const view=await app.evaluate(async()=>{const w=global.handoffWorkspace;return w.canvas.snapshot(await w.backend.session());});
 assert.equal(view.circuit,'◆Regifile');assert.equal(view.folderId,folderId);
 // Hold the tool's session read, then let a later real mouse click win.
 let arrived,release;
 const reached=new Promise(r=>arrived=r),gate=new Promise(r=>release=r);let held=false;
 await page.route('**/api/session',async route=>{if(!held){held=true;arrived();await gate;}await route.continue();});
 const pending=call({path:'cpu21-riscv.circ',circuit:'◆单周期硬布线控制器'});
 await reached;await choose('◆ALU');release();
 result=await pending;report.receipts.push(result);await page.unroute('**/api/session');
 assert.equal(result.canvas.status,'superseded');assert.equal(result.activeCircuit,null);assert.equal(await current(),'◆ALU');
 await assert.rejects(call({path:'cpu21-riscv.circ',circuit:'missing-definition'}),/电路定义不存在/);
 await waitUntil(async()=>await current()==='◆ALU',{timeout:30000});
 const after=await get('/api/session');
 assert.equal(after.workspace.id,initial.workspace.id);assert.equal(after.revision.id,initial.revision.id);assert.equal(after.folder.conversationKey,initial.folder.conversationKey);
 assert.ok(fs.readFileSync(file).equals(original));assert.equal(after.selection,initial.selection);
 report.artifactSha256=createHash('sha256').update(original).digest('hex');
 report.humanNavigationWins=true;report.sourceAndIdentityUnchanged=true;
 await page.screenshot({path:path.join(root,'human-takeover.png')});assert.deepEqual(report.errors,[]);report.passed=true;
 }catch(error){report.error=error.stack;process.exitCode=1;if(page)await page.screenshot({path:path.join(root,'failure.png')}).catch(()=>{});}
 finally{fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n');if(app)await app.close();console.log(JSON.stringify({root,passed:report.passed,error:report.error}));}
})();
