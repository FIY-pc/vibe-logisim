'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'runtime-paths.cjs'),'utf8');
function setup(platform,override) {
  const paths=platform==='win32'?path.win32:path.posix;
  const base=platform==='win32'?'C:\\native-profile':'/native-profile',created=[];
  const state={appData:base},environment={APPDATA:paths.join(base,'ignored-env'),PATH:'',...(override===undefined?{}:{VIBE_LOGISIM_USER_DATA_DIR:override})};
  const app={isPackaged:true,setName(){},getPath:key=>state[key],setPath:(key,value)=>{state[key]=value;}};
  const module={exports:{}};
  vm.runInNewContext(source,{module,__dirname,process:{platform,arch:'x64',resourcesPath:paths.join(base,'application/resources'),env:environment},require:name=>name==='node:path'?paths:{existsSync:()=>true,readFileSync:()=>JSON.stringify({target:platform+'-x64',sha256:'a'.repeat(64)}),mkdirSync:value=>created.push(value),accessSync(){},constants:{F_OK:0,X_OK:1}}});
  return {run:()=>module.exports.configureRuntime(app),state,created,paths,base,environment};
}
for(const platform of ['win32','linux']) {
  test(`${platform}: default profile stays at the OS application directory`,()=>{
    const h=setup(platform);h.run();assert.equal(h.state.userData,h.paths.join(h.base,'vibe-logisim'));
    assert.equal(h.state.appData,h.base,'native application directory is unchanged');
  });
  test(`${platform}: explicit profile isolates configuration and optional runtimes`,()=>{
    const isolated=platform==='win32'?'D:\\test-root\\profile':'/test-root/profile';
    const h=setup(platform,isolated),result=h.run();assert.equal(h.state.userData,isolated);assert.deepEqual(h.created,[isolated]);assert.equal(result.codexRoot,h.paths.join(isolated,'runtimes','codex','a'.repeat(16)));
  });
  test(`${platform}: relative overrides fail before touching any profile`,()=>{
    const h=setup(platform,'relative/profile');assert.throws(h.run,/必须是绝对路径/);assert.deepEqual(h.created,[]);assert.equal(h.state.userData,undefined);
  });
}
