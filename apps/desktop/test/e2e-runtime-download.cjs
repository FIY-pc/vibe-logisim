'use strict';
// Explicit opt-in: downloads the pinned public Codex package, starts its real
// App Server and requests/cancels a login URL. No credentials or model turns.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require('playwright');
const {waitUntil}=require('./support/wait-until.cjs');
const exe=path.resolve(process.argv[2]),root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-real-download-'));
const out=path.resolve(process.argv[3]||root);fs.mkdirSync(out,{recursive:true});
const env={...process.env,XDG_CONFIG_HOME:path.join(root,'config'),APPDATA:path.join(root,'config'),CODEX_HOME:path.join(root,'empty-codex'),VIBE_LOGISIM_NO_UPDATE_CHECK:'1'};
for(const k of ['ELECTRON_RUN_AS_NODE','VIBE_LOGISIM_STATE_DIR','VIBE_LOGISIM_CODEX','VIBE_LOGISIM_PYTHON','VIBE_LOGISIM_MODEL','VIBE_LOGISIM_EFFORT'])delete env[k];
let app,page;
const state=()=>page.evaluate(()=>window.vibeDesktop.agent.getState());
async function launch(){app=await _electron.launch({executablePath:exe,args:['--no-sandbox'],env,cwd:root});page=await app.firstWindow();page.setDefaultTimeout(45000);app.process().stderr.on('data',d=>fs.appendFileSync(path.join(out,'app.log'),d));await waitUntil(()=>state().catch(()=>null));await page.waitForFunction(()=>document.querySelector('#connectionClose svg')&&document.querySelector('#appShell').getAttribute('aria-busy')!=='true');}
(async()=>{try{
 await launch();await page.locator('#agentSettings').click();await page.locator('#settingsRuntime').click();await page.locator('#useCodexRuntime').click();
 let last=-1;
 await waitUntil(async()=>{const s=await state(),i=s.runtimeInstall;if(i?.phase==='error'||i?.phase==='cancelled')throw new Error(i.error);const mb=Math.floor((i?.received||0)/1e6);if(mb>=last+10){console.log('Codex download:',mb,'MB',i.phase);last=mb;}return i?.phase==='ready'&&['auth-required','ready','unavailable'].includes(s.status)&&s;},{timeout:600000,interval:500});
 let s=await state();const downloadBytes=s.runtimeInstall.received;assert.equal(s.runtimeInstall.phase,'ready');assert.equal(s.status,'auth-required',s.detail);
 await page.locator('#defaultRuntime').selectOption('codex');
 await waitUntil(()=>state().then(s=>s.defaultRuntime==='codex'));
 await page.locator('#settingsServices').click();await page.locator('#connectionTabChatgpt').click();
 await app.evaluate(({shell})=>{globalThis.loginHost=null;shell.openExternal=async url=>{globalThis.loginHost=new URL(url).hostname;};});
 await page.locator('#connectionLogin').click();await waitUntil(()=>app.evaluate(()=>globalThis.loginHost));
 assert.equal(await app.evaluate(()=>globalThis.loginHost),'auth.openai.com');await page.locator('#connectionLogin').click();
 await waitUntil(()=>state().then(s=>!s.signingIn));
 await page.screenshot({path:path.join(out,'installed.png')});
 await app.close();app=null;await launch();
 await waitUntil(()=>state().then(s=>s.runtime==='codex'&&s.status==='auth-required'&&s));s=await state();assert.equal(s.runtimeInstall.phase,'ready');assert.equal(s.runtimeInstall.received,0);
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({success:true,downloadBytes,verified:true,nativeStart:true,loginUrl:true,restartReuse:true,remoteModelTurns:0},null,2));
 console.log('OK: verified official download, real Codex startup/login cancellation and restart reuse');
}finally{await app?.close().catch(()=>{});}})().catch(e=>{console.error(e);process.exitCode=1;});
