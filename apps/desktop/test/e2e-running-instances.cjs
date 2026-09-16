'use strict';
const {simulationMenu}=require('./support/simulation-menu.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const {_electron}=require('playwright'),{waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),out=repo+'/apps/desktop/docs/product/evidence/2026-09-15-running-instances';
fs.mkdirSync(out,{recursive:true});
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-running-instances-'));
  for(const name of ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar'])fs.copyFileSync(repo+'/exports/interface-editing/'+name,root+'/'+name);
  const source=root+'/stage6-if-id.circ',original=fs.readFileSync(source);
  const env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
  const app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',source,'--no-sandbox'],env});
  const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
  const simulation=()=>page.evaluate(()=>fetch('/api/simulation').then(r=>r.json()));
  const scene=name=>page.evaluate(name=>fetch('/api/circuit?name='+encodeURIComponent(name)).then(r=>r.json()).then(d=>d.circuit),name);
  async function circuit(name){
    await page.locator('#circuitList .circuit-item').filter({has:page.locator('strong',{hasText:new RegExp('^'+name+'$')})}).click({timeout:90000});
    await page.waitForFunction(name=>document.querySelector('#currentCircuitName').textContent===name&&document.querySelector('#canvasStatus').hidden,name,{timeout:90000});
  }
  async function find(query){await page.locator('#findObject').click();await page.locator('#finderInput').fill(query);await page.locator('#finderInput').press('Enter');}
  async function live(name,depth){
    return waitUntil(async()=>{
      const sim=await simulation();
      return sim.observation?.circuit===name&&sim.observation.instancePath.length===depth&&sim.observation.commandSequence>=sim.commandSequence&&
        await page.locator('#canvasStatus').isHidden()&&
        await page.locator('#runtimeLayer').getAttribute('data-observation-id')===sim.observation.id&&sim;
    },{timeout:60000,label:`visible instance ${name} depth ${depth}`});
  }
  async function enter(query,name,depth){await find(query);await page.getByRole('button',{name:'进入子电路',exact:true}).click();return live(name,depth);}
  const pin=(frame,label)=>frame.components.find(c=>c.factory==='Pin'&&c.label===label);
  async function input(label,value){
    await find(label+' Pin');const field=page.getByRole('textbox',{name:'输入值',exact:true});await field.fill(String(value));await field.press('Enter');
    await waitUntil(()=>simulation().then(s=>pin(s.observation,label)?.ports[0].value===value),{label:`input ${label}`});
  }
  try{
    await page.setViewportSize({width:1500,height:960});await circuit('◇气泡流水线');const initial=await session();
    await simulationMenu(page,'simulationStart');await live('◇气泡流水线',0);
    await simulationMenu(page,'simulationSettings');await page.locator('#simulationFrequency').fill('32');await page.locator('#simulationFrequency').press('Enter');
    await simulationMenu(page,'simulationPlay');await waitUntil(()=>simulation().then(s=>s.ticks>=30),{timeout:60000,label:'course clock advances'});
    await simulationMenu(page,'simulationPlay');const parent=await live('◇气泡流水线',0);assert.equal(parent.running,false);
    const parentScene=await scene('◇气泡流水线'),instance=parentScene.components.find(c=>c.factory==='IF_ID');
    const symbol=await page.evaluate(ref=>fetch('/api/interface?'+new URLSearchParams(ref)).then(r=>r.json()),{projectId:initial.workspace.id,revisionId:initial.revision.id,circuit:'IF_ID'});
    await find('IF_ID');const parentViewport=await page.locator('#circuitCanvas').getAttribute('viewBox');
    await page.locator('#questionInput').fill('这个 IF_ID 当前保存了什么？它与父图中同一个模块的信号如何对应？');
    await page.getByRole('button',{name:'进入子电路',exact:true}).click();const child=await live('IF_ID',1);
    assert.equal(child.session.id,parent.session.id);assert.equal(child.observation.ticks,parent.observation.ticks);
    const use=symbol.uses.find(u=>u.circuit==='◇气泡流水线');
    const parentPorts=parent.observation.components.find(c=>c.componentId===instance.componentId).ports;
    for(const p of symbol.ports)assert.equal(pin(child.observation,p.label).ports[0].bits,parentPorts[use.ports[p.id].index].bits,p.label+' matches containing instance');
    await find('IF.PC Pin');assert.equal(await page.getByRole('textbox',{name:'输入值',exact:true}).count(),0);
    assert.match(await page.locator('#objectInspector').textContent(),/父电路驱动/);
    await find('DECODE.PC Pin');await page.getByRole('button',{name:'观察端口 0',exact:true}).click();
    await find('ID.IR Pin');await page.getByRole('button',{name:'观察端口 0',exact:true}).click();
    await page.locator('#fitButton').click();
    await page.screenshot({path:out+'/01-inside-running-if-id.png'});
    // Resolve the actual conversation context, then stop before any model request.
    await app.evaluate((_,repo)=>{
      const requireModule=process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');
      requireModule(repo+'/apps/desktop/electron/codex-backend.cjs').CodexBackend.prototype.ask=async function(request){
        global.__instanceAsk=request;
        if(global.__deferInstanceFailure)await new Promise(resolve=>global.__releaseInstanceFailure=resolve);
        throw new Error('本次检查停在模型入口，未调用模型');
      };
    },repo);
    await page.locator('#askButton').click();const ask=await waitUntil(()=>app.evaluate(()=>global.__instanceAsk));
    assert.equal(ask.context.displayedSimulation.sessionId,parent.session.id);
    assert.equal(ask.context.displayedSimulation.instancePath[0].componentId,instance.componentId);
    assert.equal(ask.context.displayedSimulation.circuit,'IF_ID');
    await simulationMenu(page,'simulationTick');const advanced=await waitUntil(()=>simulation().then(s=>s.observation?.ticks>child.observation.ticks&&s));
    assert.equal(advanced.session.id,parent.session.id);
    await page.locator('#circuitBack').click();const back=await live('◇气泡流水线',0);
    assert.equal(back.observation.ticks,advanced.observation.ticks);assert.equal(back.session.id,parent.session.id);
    assert.equal(await page.locator('#circuitCanvas').getAttribute('viewBox'),parentViewport);
    await page.screenshot({path:out+'/02-returned-to-running-cpu.png'});
    // A direct sidebar definition is distinct from this running copy, even if its name matches.
    await enter('IF_ID','IF_ID',1);await circuit('IF_ID');
    assert.equal(await page.locator('#documentKind').textContent(),'电路定义');
    assert.equal(await page.locator('#runtimeLayer').getAttribute('data-observation-id'),'');
    await page.locator('#simulationReturn').click();await live('IF_ID',1);
    assert.equal(await page.locator('.signal-watch').count(),2,'returning to an instance restores its watches');
    assert.equal(await page.locator('.breadcrumb-parent').count(),1);
    await simulationMenu(page,'simulationStop');await waitUntil(()=>simulation().then(s=>!s.session));
    assert.equal((await session()).revision.id,initial.revision.id);assert.deepEqual(fs.readFileSync(source),original);
    // An independent ordinary circuit exposes accidental mixing of same-definition copies.
    const pair=root+'/pair.circ';fs.writeFileSync(pair,execFileSync('python',['-c',"import runpy; print(runpy.run_path('apps/desktop/test/simulation-instances.py')['fixture']())"],{cwd:repo}));
    await page.locator('#agentNotice').waitFor({state:'visible'});
    await app.evaluate(()=>{global.__deferInstanceFailure=true;});
    await page.locator('#askButton').click();
    await waitUntil(()=>app.evaluate(()=>Boolean(global.__releaseInstanceFailure)));
    await page.locator('#fileInput').setInputFiles(pair);await circuit('Root');const pairSession=await session();
    await page.locator('#agentNotice').waitFor({state:'hidden'});
    await app.evaluate(()=>{global.__releaseInstanceFailure();});
    await waitUntil(()=>page.locator('#askButton').isEnabled());
    assert.equal(await page.locator('#agentNotice').isHidden(),true,'late failure from the previous project stays out of this workspace');
    await simulationMenu(page,'simulationStart');await live('Root',0);await input('A',1);await input('B',0);
    await enter('LEFT','Wrapper',1);const left=await enter('Cell','Cell',2);assert.equal(pin(left.observation,'Q').ports[0].value,1);
    await simulationMenu(page,'momentCapture');
    await waitUntil(()=>page.locator('#momentCapture').isEnabled());
    await page.screenshot({path:out+'/03-left-instance.png'});
    await page.locator('.breadcrumb-parent').filter({hasText:/^Root$/}).click();await live('Root',0);
    await enter('RIGHT','Wrapper',1);const right=await enter('Cell','Cell',2);assert.equal(pin(right.observation,'Q').ports[0].value,0);
    assert.equal(right.session.id,left.session.id);assert.notDeepEqual(right.observation.instancePath,left.observation.instancePath);
    assert.equal(pin(right.observation,'Q').componentId,pin(left.observation,'Q').componentId);
    await page.screenshot({path:out+'/04-right-instance.png'});
    await simulationMenu(page,'momentOpen');await page.locator('.moment-signal-link').filter({hasText:/^Q$/}).click();
    const referred=await live('Cell',2);
    assert.deepEqual(referred.observation.instancePath,left.observation.instancePath,'saved signal returns to its original instance');
    assert.equal(pin(referred.observation,'Q').ports[0].value,1);
    await simulationMenu(page,'simulationStop');await waitUntil(()=>simulation().then(s=>!s.session));
    assert.equal((await session()).revision.id,pairSession.revision.id);assert.deepEqual(errors,[]);
    fs.writeFileSync(out+'/result.json',JSON.stringify({root,course:{revision:initial.revision.id,sessionId:parent.session.id,
      ticks:[parent.observation.ticks,child.observation.ticks,back.observation.ticks],matchedPorts:symbol.ports.length,
      observationId:ask.context.displayedSimulation.id,instancePath:ask.context.displayedSimulation.instancePath},
      pair:{left:1,right:0,sessionId:left.session.id,depth:2},sourceUnchanged:true,modelTurns:0,conversationContext:'resolved before model entry'},null,2));
    console.log(root);
  }catch(error){console.error(errors);console.error((await simulation()).reason);await page.screenshot({path:out+'/failure.png'});throw error;}
  finally{await app.close();}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
