'use strict';
// Real Electron view controls and native circuit/simulation, without model turns.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require('playwright'),{waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),root=fs.mkdtempSync('/tmp/vibe-grid-'),folder=root+'/workspace';
fs.mkdirSync(folder);
const circuit=`<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><lib desc="#Gates" name="1"/><main name="main"/><circuit name="main">
<comp lib="0" name="Pin" loc="(100,100)"><a name="label" val="A"/><a name="tristate" val="false"/></comp>
<comp lib="0" name="Pin" loc="(100,200)"><a name="label" val="B"/><a name="tristate" val="false"/></comp>
<comp lib="1" name="AND Gate" loc="(300,150)"/><comp lib="0" name="Pin" loc="(400,150)"><a name="label" val="Q"/><a name="output" val="true"/><a name="facing" val="west"/></comp>
<wire from="(100,100)" to="(200,100)"/><wire from="(200,100)" to="(200,130)"/><wire from="(200,130)" to="(250,130)"/>
<wire from="(100,200)" to="(200,200)"/><wire from="(200,200)" to="(200,170)"/><wire from="(200,170)" to="(250,170)"/><wire from="(300,150)" to="(400,150)"/>
</circuit></project>`;
fs.writeFileSync(folder+'/main.circ',circuit);
fs.writeFileSync(folder+'/long.circ','<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><main name="Long"/><circuit name="Long"><comp lib="0" name="Pin" loc="(100,100)"/><comp lib="0" name="Pin" loc="(30000,100)"/></circuit></project>');
const env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state',VIBE_LOGISIM_CODEX:root+'/no-agent'};delete env.ELECTRON_RUN_AS_NODE;
let app,page,phase='launch';const errors=[];
const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
const pressed=()=>page.locator('#gridToggle').getAttribute('aria-pressed');
async function launch(){
 app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',folder+'/main.circ','--no-sandbox'],env});
 page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));await page.setViewportSize({width:1500,height:960});
 await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='main'&&document.querySelector('#canvasStatus').hidden);
}
async function world(x,y){return page.locator('#circuitCanvas').evaluate((svg,{x,y})=>{const p=new DOMPoint(x,y).matrixTransform(svg.getScreenCTM());return {x:p.x,y:p.y};},{x,y});}
async function geometry(){return page.locator('#circuitCanvas').evaluate(svg=>{
 const m=svg.getScreenCTM(),r=svg.getBoundingClientRect(),inv=m.inverse(),plane=svg.querySelector('#gridPlane');
 const left=new DOMPoint(r.left,r.top).matrixTransform(inv),right=new DOMPoint(r.right,r.bottom).matrixTransform(inv);
 return {scale:m.a,step:Number(svg.querySelector('#minorGrid').getAttribute('width')),origin:svg.querySelector('#minorGrid').getAttribute('x'),bounds:{x:plane.x.baseVal.value,y:plane.y.baseVal.value,width:plane.width.baseVal.value,height:plane.height.baseVal.value},left:{x:left.x,y:left.y},right:{x:right.x,y:right.y}};
 });}
function covers(g){assert.ok(g.bounds.x<=g.left.x&&g.bounds.y<=g.left.y&&g.bounds.x+g.bounds.width>=g.right.x&&g.bounds.y+g.bounds.height>=g.right.y);assert.equal(g.origin,'0');assert.ok(g.step*g.scale>=8);}
async function pixel(image,point){return app.evaluate(({nativeImage},{image,point})=>{
 const value=nativeImage.createFromPath(image),size=value.getSize(),bytes=value.toBitmap(),at=(Math.floor(point.y)*size.width+Math.floor(point.x))*4;
 return [...bytes.subarray(at,at+3)];
 },{image,point});}
(async()=>{try{
 await launch();const before=await session();assert.equal(await pressed(),'false');
 phase='toggle and native white image';await page.screenshot({path:root+'/off.png'});await page.locator('#gridToggle').click();assert.equal(await pressed(),'true');assert.ok(await page.locator('#gridToggle svg path, #gridToggle svg rect').count());covers(await geometry());
 await page.screenshot({path:root+'/on.png'});
 // In the native PNG bounds, empty background must show guides while black
 // wires retain their dark color. Grid is multiplied over opaque native images.
 const blank=await world(170,120),wire=await world(150,100);
 const [offBlank,onBlank,offWire,onWire]=await Promise.all([pixel(root+'/off.png',blank),pixel(root+'/on.png',blank),pixel(root+'/off.png',wire),pixel(root+'/on.png',wire)]);
 assert.ok(onBlank.some((v,i)=>v<offBlank[i]-2),JSON.stringify({offBlank,onBlank}));assert.ok(onWire.every((v,i)=>v<=offWire[i]+1));
 phase='pan zoom and resize';const canvas=await page.locator('#circuitCanvas').boundingBox();await page.locator('#panTool').click();await page.mouse.move(canvas.x+canvas.width*.6,canvas.y+canvas.height*.55);await page.mouse.down();await page.mouse.move(canvas.x+canvas.width*.4,canvas.y+canvas.height*.65,{steps:12});await page.mouse.up();covers(await geometry());
 await page.locator('#zoomInButton').click();covers(await geometry());await page.locator('#toggleReview').click();await waitUntil(async()=>{try{covers(await geometry());return true;}catch{return false;}});await page.locator('#toggleReview').click();
 phase='typing and keyboard toggle';await page.locator('#questionInput').press('g');assert.equal(await page.locator('#questionInput').inputValue(),'g');assert.equal(await pressed(),'true');await page.locator('#circuitCanvas').focus();await page.keyboard.press('g');assert.equal(await pressed(),'false');await page.keyboard.press('g');assert.equal(await pressed(),'true');await page.locator('#fitButton').click();
 const after=await session();assert.equal(after.revision.id,before.revision.id);assert.deepEqual(after.workspace.history,before.workspace.history);assert.equal(fs.readFileSync(folder+'/main.circ','utf8'),circuit);
 phase='grid does not intercept simulation input';await page.locator('#pokeTool').click();const input=await world(90,100);await page.mouse.click(input.x,input.y);await waitUntil(async()=>{const state=await page.evaluate(()=>fetch('/api/simulation').then(r=>r.json()));return state.observation?.components.some(c=>c.label==='A'&&c.ports[0]?.value===1);});assert.equal(await pressed(),'true');await page.screenshot({path:root+'/simulation-grid.png'});
 phase='long circuit density';await page.locator('.file-row[data-path="long.circ"]').click();await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='Long'&&document.querySelector('#canvasStatus').hidden);const long=await geometry();covers(long);assert.ok(long.step>10);assert.ok(long.bounds.x+long.bounds.width>30000);await page.screenshot({path:root+'/long-grid.png'});
 phase='reopen remembers view preference';await app.close();app=null;await launch();await waitUntil(async()=>await pressed()==='true');assert.equal((await session()).revision.id,before.revision.id);assert.equal(fs.readFileSync(folder+'/main.circ','utf8'),circuit);await page.locator('#gridToggle').click();await waitUntil(async()=>!(await page.evaluate(()=>window.vibeDesktop.canvasPreferences.read())).gridVisible);assert.equal(await pressed(),'false');assert.deepEqual(errors,[]);
 console.log(JSON.stringify({root,success:true,modelTurns:0,viewOnly:true,aligned:true,adaptiveDensity:true,realInputWorks:true,persistsAcrossRestart:true,pixels:{offBlank,onBlank,offWire,onWire}},null,2));
}catch(error){console.error({root,phase},error);await page?.screenshot({path:root+'/failure.png'}).catch(()=>{});process.exitCode=1;}finally{await app?.close();}})();
