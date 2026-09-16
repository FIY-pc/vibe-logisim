'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {ConversationDraftStore}=require('./conversation-drafts.cjs');
const A='project-aaaaaaaaaaaaaaaa',B='project-bbbbbbbbbbbbbbbb';
const draft=text=>({text,materials:[],moments:[],focus:null});
test('independent project drafts reject out-of-order, stale-window and malformed writes',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'conversation-drafts-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new ConversationDraftStore(root),a=store.open(A,1),b=store.open(B,1);
  const write=(lease,sequence,text,owner=1)=>store.save({...lease,sequence,draft:draft(text)},owner);
  write(a,2,'A 的新草稿');write(a,1,'A 的旧草稿');write(b,1,'B 的草稿');
  assert.throws(()=>write(a,3,'错误窗口',2));
  assert.throws(()=>write(a,3,'x'.repeat(4001)));
  assert.throws(()=>store.open('../escape',1));
  const next=store.open(A,1);assert.equal(next.draft.text,'A 的新草稿');assert.throws(()=>write(a,4,'旧窗口回包'));
  assert.equal(new ConversationDraftStore(root).open(B,2).draft.text,'B 的草稿');
});
test('unreadable records are preserved and cannot be silently replaced with an empty draft',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'conversation-drafts-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new ConversationDraftStore(root),file=path.join(root,A+'.json');fs.writeFileSync(file,'broken draft');
  assert.throws(()=>store.open(A,1),/原记录仍保留/);assert.equal(fs.readFileSync(file,'utf8'),'broken draft');
  assert.throws(()=>store.save({projectId:A,writer:'not-issued',sequence:1,draft:draft('')},1));
});
