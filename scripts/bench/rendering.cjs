'use strict';

// Diagnostic, not a pass/fail test. Uses real Electron input and native drawing.
// Run: node scripts/bench/rendering.cjs /path/to/file.circ [circuit-name]
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const repo=path.resolve(__dirname,'../..'),desktop=path.join(repo,'apps/desktop');
const {_electron}=require(path.join(desktop,'node_modules/playwright'));
if(!process.argv[2])throw new Error('Usage: node scripts/bench/rendering.cjs file.circ [circuit-name]');
const source=path.resolve(process.argv[2]),name=process.argv[3];
const original=fs.readFileSync(source),hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const root=fs.mkdtempSync('/tmp/vibe-render-bench-'),folder=path.join(root,'workspace');
fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,path.basename(source)),original);
for(const entry of fs.readdirSync(path.dirname(source),{withFileTypes:true})){
  if(entry.isFile()&&entry.name.endsWith('.jar'))fs.copyFileSync(path.join(path.dirname(source),entry.name),path.join(folder,entry.name));
}
const env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state',VIBE_LOGISIM_CODEX:root+'/no-agent'};
delete env.ELECTRON_RUN_AS_NODE;
const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))]:null;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let app,page,phase='launch';
(async()=>{try{
  app=await _electron.launch({executablePath:require(path.join(desktop,'node_modules/electron')),args:[desktop,path.join(folder,path.basename(source)),'--no-sandbox'],env});
  page=await app.firstWindow();page.setDefaultTimeout(60000);await page.setViewportSize({width:1500,height:960});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>document.querySelector('.circuit-item')&&document.querySelector('#canvasStatus').hidden);
  if(name&&(await page.locator('#currentCircuitName').innerText())!==name){
    await page.locator('#circuitSearch').fill(name);await page.getByRole('button',{name,exact:true}).click();
    await page.waitForFunction(name=>document.querySelector('#currentCircuitName').textContent===name&&document.querySelector('#canvasStatus').hidden,name);
  }
  const scene=await page.evaluate(async()=>{
    const name=document.querySelector('#currentCircuitName').textContent;
    const payload=await fetch('/api/circuit?name='+encodeURIComponent(name)).then(r=>r.json());
    const svg=document.querySelector('#circuitCanvas');
    return {name,payload,domNodes:svg.querySelectorAll('*').length,componentNodes:svg.querySelectorAll('.circuit-component').length,wireNodes:svg.querySelectorAll('.wire-group').length,fitScale:svg.getScreenCTM().a,dpr:devicePixelRatio};
  });
  const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable');
  const geometry=()=>page.locator('#circuitCanvas').evaluate(svg=>({scale:svg.getScreenCTM().a,viewBox:svg.getAttribute('viewBox')}));
  phase='zoom to readable scale';const box=await page.locator('#circuitCanvas').boundingBox();
  await page.mouse.move(box.x+box.width*.45,box.y+box.height*.45);
  const targetScale=Math.max(1.5,(scene.payload.circuit.render?.scale||1)*1.5);
  for(let i=0;i<60&&(await geometry()).scale<targetScale;i++)await page.mouse.wheel(0,-120);
  await page.locator('#detailLayer image').waitFor();await sleep(500);
  await page.locator('#panTool').click();
  await page.evaluate(()=>{
    window.renderBench={frames:[],commits:[],events:[],longTasks:[],running:true};
    new MutationObserver(()=>window.renderBench.commits.push(performance.now())).observe(document.querySelector('#detailLayer'),{childList:true});
    new PerformanceObserver(list=>window.renderBench.longTasks.push(...list.getEntries().map(x=>({start:x.startTime,duration:x.duration})))).observe({type:'longtask'});
    for(const type of ['pointerdown','pointermove','pointerup'])document.querySelector('#circuitCanvas').addEventListener(type,e=>window.renderBench.events.push({type,at:performance.now()}));
    const frame=t=>{if(window.renderBench.running){window.renderBench.frames.push(t);requestAnimationFrame(frame);}};requestAnimationFrame(frame);
    performance.clearResourceTimings();
  });
  const metricsBefore=await cdp.send('Performance.getMetrics');
  const pans=[];
  for(let trial=0;trial<5;trial++){
    phase='pan '+trial;
    const startX=box.x+box.width*(trial%2?.35:.65),endX=box.x+box.width*(trial%2?.65:.35),y=box.y+box.height*.5;
    await page.mouse.move(startX,y);await page.mouse.down();
    for(let step=1;step<=45;step++){await page.mouse.move(startX+(endX-startX)*step/45,y);await sleep(16);}
    await page.mouse.up();
    const up=await page.evaluate(()=>window.renderBench.events.filter(x=>x.type==='pointerup').at(-1).at);
    // Wait for the FINAL camera, not an intermediate response from mid-gesture.
    await page.waitForFunction(()=>{
      const svg=document.querySelector('#circuitCanvas'),m=svg.getScreenCTM(),r=svg.getBoundingClientRect();
      const p=new DOMPoint(r.left,r.top).matrixTransform(m.inverse()),img=document.querySelector('#detailLayer image');
      return img&&Number(img.getAttribute('x'))===Math.floor(p.x-64/m.a)&&Number(img.getAttribute('y'))===Math.floor(p.y-64/m.a);
    });
    const committed=await page.evaluate(()=>window.renderBench.commits.at(-1));
    pans.push({trial,releaseToDetailCommitMs:committed-up});await sleep(120);
  }
  const metricsAfter=await cdp.send('Performance.getMetrics');
  const log=await page.evaluate(()=>{
    window.renderBench.running=false;
    return {...window.renderBench,requests:performance.getEntriesByType('resource').filter(x=>x.name.includes('/api/render/viewport')).map(x=>({url:x.name,start:x.startTime,duration:x.duration,bytes:x.encodedBodySize}))};
  });
  const frames=log.frames.slice(1).map((t,i)=>t-log.frames[i]);
  const metricDelta=Object.fromEntries(metricsAfter.metrics.filter(x=>['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration'].includes(x.name)).map(x=>[x.name,x.value-metricsBefore.metrics.find(y=>y.name===x.name).value]));
  const result={root,circuit:scene.name,sourceSha256:hash(original),sourceUnchanged:hash(fs.readFileSync(source))===hash(original),modelTurns:0,
    scene:{domNodes:scene.domNodes,components:scene.componentNodes,wires:scene.wireNodes,fitScale:scene.fitScale,dpr:scene.dpr},
    readableView:await geometry(),gpu:await app.evaluate(({app})=>app.getGPUFeatureStatus()),
    animationCallbackIntervalMs:{median:percentile(frames,.5),p95:percentile(frames,.95),max:Math.max(...frames)},
    detailCommitMs:{median:percentile(pans.map(x=>x.releaseToDetailCommitMs),.5),p95:percentile(pans.map(x=>x.releaseToDetailCommitMs),.95)},
    viewportRequests:log.requests.length,requestIncludingServerMs:{median:percentile(log.requests.map(x=>x.duration),.5),p95:percentile(log.requests.map(x=>x.duration),.95)},longTasks:log.longTasks,metricDelta,errors,
    limitations:['Animation callbacks are not presented-frame or GPU timings.','Five pans at one viewport and DPR; no claim about all circuits or high-DPI monitors.','Resource timing includes server queue/drawing/encoding/transport.']};
  fs.writeFileSync(root+'/scene.json',JSON.stringify(scene.payload));fs.writeFileSync(root+'/trace.json',JSON.stringify({pans,...log},null,2));fs.writeFileSync(root+'/result.json',JSON.stringify(result,null,2));
  await page.screenshot({path:root+'/readable.png'});console.log(JSON.stringify(result,null,2));
}catch(error){console.error({root,phase},error);await page?.screenshot({path:root+'/failure.png'}).catch(()=>{});process.exitCode=1;}finally{await app?.close();}})();
