'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {test}=require('node:test');
const {registerShortcutPreferences}=require('./shortcut-preferences.cjs');

function setup(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-shortcuts-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const connect=()=>{
    const handlers={};
    registerShortcutPreferences({userData:root,trusted:e=>e==='trusted',ipcMain:{handle:(name,handler)=>handlers[name]=handler}});
    return {read:event=>handlers['vibe-logisim:shortcuts-read'](event??'trusted'),write:(value,event)=>handlers['vibe-logisim:shortcuts-write'](event??'trusted',value)};
  };
  return {root,connect};
}
test('shortcuts survive a new renderer/server lifecycle independently of canvas preferences',t=>{
  const {root,connect}=setup(t),first=connect();
  fs.writeFileSync(path.join(root,'canvas-preferences.json'),'{"gridVisible":true}');
  assert.deepEqual(first.read(),{});
  first.write({wire:'W',poke:null});
  assert.deepEqual(connect().read(),{wire:'W',poke:null});
  assert.equal(fs.readFileSync(path.join(root,'canvas-preferences.json'),'utf8'),'{"gridVisible":true}');
  connect().write({});assert.deepEqual(first.read(),{});
});
test('invalid or untrusted writes cannot replace working preferences',t=>{
  const {connect}=setup(t),api=connect();api.write({select:'5'});
  assert.throws(()=>api.read('other'),/Untrusted/);
  assert.throws(()=>api.write({select:'6'},'other'),/Untrusted/);
  assert.throws(()=>api.write({select:{key:'6'}}),/格式/);
  assert.throws(()=>api.write({'../../circuit':'6'}),/格式/);
  assert.throws(()=>api.write(new Array(3)),/格式/);
  assert.deepEqual(api.read(),{select:'5'});
});
test('a damaged preference file is reported, not silently overwritten',t=>{
  const {root,connect}=setup(t),file=path.join(root,'shortcut-preferences.json');
  fs.writeFileSync(file,'{broken');assert.throws(()=>connect().read());
  assert.equal(fs.readFileSync(file,'utf8'),'{broken');
});
