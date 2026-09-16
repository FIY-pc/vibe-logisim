'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {MaterialStore}=require('./material-store.cjs');
const {materialContext}=require('./conversation-context.cjs');
const project='project-0123456789abcdef',other='project-fedcba9876543210';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-material-unit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,store:new MaterialStore({root:path.join(root,'store'),workspaceRoot:path.join(root,'agent')})};}

test('references preserve original bytes, duplicate names, archive and restart across projects',t=>{
  const {root,store}=fixture(t),source=path.join(root,'任务书.md');fs.writeFileSync(source,'第一个要求');
  const first=store.import(project,[source]).added[0];
  assert.equal(store.import(project,[source]).added[0].id,first.id);
  fs.writeFileSync(source,'第二个要求');const second=store.import(project,[source]).added[0];assert.notEqual(first.id,second.id);
  assert.equal(store.read(project,first.id).bytes.toString(),'第一个要求');
  const projected=path.join(root,'agent',project,first.path);fs.writeFileSync(projected,'AI changed staging copy');
  store.sync(project);assert.equal(fs.readFileSync(projected,'utf8'),'第一个要求');
  store.setRemoved(project,first.id,true);assert.equal(fs.existsSync(projected),false);
  assert.throws(()=>store.references(project,[{id:first.id}]),/已移除/);
  const restarted=new MaterialStore({root:path.join(root,'store'),workspaceRoot:path.join(root,'agent')});
  assert.ok(restarted.list(project).find(i=>i.id===first.id).removedAt);
  restarted.setRemoved(project,first.id,false);assert.equal(fs.readFileSync(projected,'utf8'),'第一个要求');
  assert.deepEqual(restarted.list(other),[]);assert.throws(()=>restarted.read(other,first.id),/不属于/);
  const refs=restarted.references(project,[{id:first.id,page:2,quote:'第一个要求'}]);
  const context=materialContext({materials:refs});assert.equal(context['vibe-logisim.material-1'].kind,'untrusted');assert.match(context['vibe-logisim.material-1'].value,/第一个要求/);
  assert.equal(fs.readFileSync(source,'utf8'),'第二个要求');
});

test('legacy user attachments migrate once with stable names and reversible removal',t=>{
  const {root,store}=fixture(t),legacy=path.join(root,'agent',project,'materials');fs.mkdirSync(legacy,{recursive:true});
  const bytes=Buffer.from('legacy course reference'),name=crypto.createHash('sha256').update(bytes).digest('hex').slice(0,8)+'-任务书.txt';
  fs.writeFileSync(path.join(legacy,name),bytes);fs.writeFileSync(path.join(legacy,'agent-note.txt'),'agent note');
  const [item]=store.list(project);assert.equal(item.name,'任务书.txt');assert.equal(item.path,'materials/'+name);
  assert.equal(store.list(project).length,1);store.setRemoved(project,item.id,true);
  assert.equal(fs.existsSync(path.join(legacy,name)),false);assert.equal(fs.readFileSync(path.join(legacy,'agent-note.txt'),'utf8'),'agent note');
  assert.deepEqual(store.read(project,item.id).bytes,bytes);
});

test('bad paths and incomplete imports cannot publish or overwrite sources',t=>{
  const {root,store}=fixture(t),source=path.join(root,'source.txt');fs.writeFileSync(source,'protected');
  const linked=path.join(root,'linked.txt');fs.symlinkSync(source,linked);
  assert.throws(()=>store.import(project,[source,linked]));assert.deepEqual(store.list(project),[]);
  assert.throws(()=>store.list('../escape'),/打开工程/);
  const first=store.import(project,[source]).added[0],copy=path.join(root,'agent',project,first.path);
  fs.unlinkSync(copy);fs.linkSync(source,copy);store.sync(project);
  assert.equal(fs.readFileSync(source,'utf8'),'protected');assert.equal(fs.statSync(source).nlink,1);
  const long=path.join(root,'资料'.repeat(35)+'.txt');fs.writeFileSync(long,'long name');
  assert.equal(store.import(project,[long]).added[0].name,path.basename(long));
  assert.throws(()=>store.references(project,[{id:first.id,quote:'x'.repeat(2001)}]),/引用无效/);
});
