'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');

const bounded=(v,max)=>typeof v==='string'&&v.length<=max;
function validateDraft(value) {
  const bad=()=>{throw new Error('草稿格式无效，已保存的内容没有改变');};
  if(!value||JSON.stringify(value).length>128*1024||!bounded(value.text,4000))bad();
  for(const [kind,max] of [['materials',8],['moments',2]]) {
    if(!Array.isArray(value[kind])||value[kind].length>max)bad();
    for(const ref of value[kind]) {
      if(!bounded(ref.id,4096)||!ref.id||!bounded(ref.token,100)||!ref.token)bad();
      if(kind==='materials'&&(!bounded(ref.name,1000)||!bounded(ref.quote,2000)||(ref.page!=null&&(!Number.isSafeInteger(ref.page)||ref.page<1))))bad();
      if(kind==='moments'&&(!bounded(ref.title,100)||!bounded(ref.revisionId,100)))bad();
    }
    if(new Set(value[kind].map(r=>r.token)).size!==value[kind].length)bad();
  }
  if(value.focus!=null) {
    const f=value.focus;
    if(!bounded(f.projectId,100)||!bounded(f.revisionId,100)||!bounded(f.circuit,1000))bad();
    for(const k of ['componentIds','netIds','wireIds'])if(!Array.isArray(f[k])||f[k].length>2000||f[k].some(id=>!bounded(id,200)))bad();
    if(f.rectangle!=null&&['x','y','width','height'].some(k=>!Number.isFinite(f.rectangle[k])))bad();
  }
  return structuredClone({text:value.text,materials:value.materials,moments:value.moments,focus:value.focus||null});
}

// Unsent human intent is separate from circuit revisions, chat history and the
// model's writable workspace. Each open renderer gets a sequenced writer lease.
class ConversationDraftStore {
  constructor(root){this.root=path.resolve(root);this.writers=new Map();}
  file(projectId) {
    if(!/^(project|folder)-[a-f0-9]{16}$/.test(projectId||''))throw new Error('请先打开工程');
    fs.mkdirSync(this.root,{recursive:true});
    if(fs.realpathSync(this.root)!==this.root)throw new Error('草稿目录发生了重定向');
    return path.join(this.root,projectId+'.json');
  }
  open(projectId,owner) {
    const file=this.file(projectId);let draft=null;
    try {
      const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try {
        const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>512*1024)throw new Error('invalid file');
        const record=JSON.parse(fs.readFileSync(fd,'utf8'));
        if(record.version!==1)throw new Error('unknown version');
        draft=validateDraft(record.draft);
      }finally{fs.closeSync(fd);}
    }catch(error){if(error.code!=='ENOENT')throw new Error('无法恢复草稿，原记录仍保留。请重试');}
    const writer=randomUUID();this.writers.set(projectId,{writer,owner,sequence:0});
    return {projectId,writer,draft};
  }
  save(request,owner) {
    const {projectId,writer,sequence}=request||{},lease=this.writers.get(projectId);
    if(!lease||lease.writer!==writer||lease.owner!==owner)throw new Error('草稿窗口已变化，请重新打开工程');
    if(!Number.isSafeInteger(sequence)||sequence<1)throw new Error('草稿顺序无效');
    if(sequence<=lease.sequence)return {sequence:lease.sequence};
    const draft=validateDraft(request.draft),file=this.file(projectId),tmp=file+'.'+randomUUID()+'.tmp';
    try {
      fs.writeFileSync(tmp,JSON.stringify({version:1,draft}),{flag:'wx',mode:0o600});
      fs.renameSync(tmp,file);lease.sequence=sequence;
    }catch{throw new Error('草稿暂未存到本机，当前窗口里的内容仍在');}
    finally{fs.rmSync(tmp,{force:true});}
    return {sequence};
  }
}
module.exports={ConversationDraftStore,validateDraft};
