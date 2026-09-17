'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{test}=require('node:test');
const {FolderWorkspace}=require('./folder-workspace.cjs'),{FolderHistory}=require('./folder-history.cjs');
const {moveEntry,trashEntry,undoEntry}=require('./folder-operations.cjs');
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'folder-operations-unit-')),source=root+'/workspace';fs.mkdirSync(source);fs.mkdirSync(source+'/nested');fs.writeFileSync(source+'/notes.md','original');
 const folder=new FolderWorkspace(root+'/state');await folder.open(source);const history=new FolderHistory(folder);await history.open();const events=[];
 const workspace={folder,history,error:'',backend:{movePath:async(id,from,to)=>{fs.renameSync(source+'/'+from,source+'/'+to);return{documentChanged:false};},setFolder:async()=>{},session:async()=>({})},snapshot:()=>({folder:folder.snapshot()}),emit:(_,event)=>events.push(event),refresh:async()=>{}};
 t.after(()=>{folder.close();fs.rmSync(root,{recursive:true,force:true});});return{workspace,folder,source,events};
}
test('references follow moves and undo without retargeting references to reused paths',async t=>{
 const {workspace:w,folder,source}=await fixture(t),folderId=folder.current.id;
 const ref=folder.reference({id:'notes.md',pathVersion:0});await moveEntry(w,{folderId,from:'notes.md',to:'nested/notes.md'});
 assert.equal(folder.reference(ref).path,'nested/notes.md');fs.writeFileSync(source+'/notes.md','different');
 const newRef=folder.reference({id:'notes.md',pathVersion:1});assert.equal(newRef.path,'notes.md');
 const move=w.history.record.entries[0];await assert.rejects(undoEntry(w,{folderId,id:move.id}),/同名文件/);assert.equal(fs.readFileSync(source+'/notes.md','utf8'),'different');
 fs.unlinkSync(source+'/notes.md');await undoEntry(w,{folderId,id:move.id});assert.equal(folder.reference(ref).path,'notes.md');assert.equal(fs.readFileSync(source+'/notes.md','utf8'),'original');
});
test('empty directories can be moved and undone; failed trash never permanently deletes',async t=>{
 const {workspace:w,folder,source}=await fixture(t),folderId=folder.current.id;fs.mkdirSync(source+'/empty');
 await moveEntry(w,{folderId,from:'empty',to:'nested/empty'});assert.ok(w.history.record.entries[0].operation);await undoEntry(w,{folderId,id:w.history.record.entries[0].id});assert.ok(fs.statSync(source+'/empty').isDirectory());assert.equal(fs.existsSync(source+'/nested/empty'),false);
 await assert.rejects(trashEntry(w,{folderId,path:'notes.md'},{trashItem:async()=>{throw new Error('unsupported');}}),/回收站/);assert.equal(fs.readFileSync(source+'/notes.md','utf8'),'original');
 await assert.rejects(moveEntry(w,{folderId,from:'nested',to:'nested/child'}),/自身/);
});
