'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {FolderWorkspace}=require('./folder-workspace.cjs');
const {FolderHistory}=require('./folder-history.cjs');
const {ConversationDraftStore}=require('./conversation-drafts.cjs');
const {migrateReferences,migrateDraft}=require('./folder-migration.cjs');

async function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-file-contract-')),project=path.join(root,'project');fs.mkdirSync(project);const folder=new FolderWorkspace(path.join(root,'state'));await folder.open(project);t.after(()=>{folder.close();fs.rmSync(root,{recursive:true,force:true});});return {root,project,folder};}

test('undo refuses later human edits and restores a mixed file change atomically',async t=>{
 const {project,folder}=await fixture(t);fs.writeFileSync(project+'/existing.md','before');
 const history=new FolderHistory(folder);await history.open();
 fs.writeFileSync(project+'/existing.md','after');fs.mkdirSync(project+'/new');fs.writeFileSync(project+'/new/result.txt','created');const change=history.checkpoint('AI 修改');
 fs.writeFileSync(project+'/existing.md','human followup');assert.throws(()=>history.undo(change.id),/之后又有改动/);
 assert.equal(fs.readFileSync(project+'/new/result.txt','utf8'),'created');assert.equal(fs.readFileSync(project+'/existing.md','utf8'),'human followup');
 fs.writeFileSync(project+'/existing.md','after');history.undo(change.id);
 assert.equal(fs.readFileSync(project+'/existing.md','utf8'),'before');assert.equal(fs.existsSync(project+'/new/result.txt'),false);
});

test('folder identities persist and links cannot redirect file preview or undo outside the folder',async t=>{
 const {root,project,folder}=await fixture(t);const first=folder.snapshot();fs.writeFileSync(project+'/x.txt','before');const history=new FolderHistory(folder);await history.open();fs.writeFileSync(project+'/x.txt','after');const entry=history.checkpoint();
 fs.writeFileSync(root+'/outside.txt','private');fs.rmSync(project+'/x.txt');fs.symlinkSync(root+'/outside.txt',project+'/x.txt');
 assert.throws(()=>folder.read('x.txt'),/工作区之外/);assert.throws(()=>folder.read('../outside.txt'),/工作区内/);assert.throws(()=>history.undo(entry.id));assert.equal(fs.readFileSync(root+'/outside.txt','utf8'),'private');
 await folder.open(project);assert.equal(folder.current.id,first.id);assert.equal(folder.current.conversationKey,first.conversationKey);
});

test('old references and draft migrate once without replacing a human file or deleting originals',async t=>{
 const {root,project,folder}=await fixture(t);fs.mkdirSync(project+'/参考资料');fs.writeFileSync(project+'/参考资料/需求.md','human');
 const id='material-1234567890abcdef',projectId='project-1234567890abcdef';
 const bytes=Buffer.from('old imported document');const sha=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
 migrateReferences(folder,{list:()=>[{id,name:'需求.md',sha256:sha}],read:()=>({bytes})},projectId);
 assert.equal(fs.readFileSync(project+'/参考资料/需求.md','utf8'),'human');assert.equal(fs.readFileSync(folder.resolve(folder.current.legacyReferences[id]),'utf8'),'old imported document');
 const store=new ConversationDraftStore(root+'/drafts'),opened=store.open(projectId,1);
 store.save({projectId,writer:opened.writer,sequence:1,draft:{text:'旧想法',materials:[{id,name:'需求.md',quote:'',page:null,token:'ref-1'}],moments:[],focus:null}},1);
 migrateDraft(store,folder.current);assert.equal(store.open(folder.current.id,2).draft.materials[0].id,folder.current.legacyReferences[id]);assert.equal(store.open(projectId,3).draft.text,'旧想法');
});
