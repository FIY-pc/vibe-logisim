'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {atomic,hash,ignored}=require('./folder-workspace.cjs');

// File history is outside the model-writable folder. Undo is conditional on the
// exact after-state, so a later human edit can never be silently overwritten.
class FolderHistory {
  constructor(folder){this.folder=folder;this.record=null;this.cache=new Map();}
  get directory(){return path.join(this.folder.stateRoot,this.folder.current.id,'history');}
  get index(){return path.join(this.directory,'index.json');}
  async open(){this.cache.clear();try{this.record=JSON.parse(fs.readFileSync(this.index,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;this.record={head:this.scan(true),entries:[]};this.persist();}this.checkpoint('重新打开工作区');}
  persist(){atomic(this.index,this.record);}
  scan(force=false){
    const manifest={},root=this.folder.current.root;let count=0,storedBytes=0;
    const walk=directory=>{for(const entry of fs.readdirSync(path.join(root,directory),{withFileTypes:true})){
      if(ignored.has(entry.name)||['codex-home','circuit-agent'].includes(entry.name)||entry.isSymbolicLink())continue;
      const relative=path.join(directory,entry.name),file=path.join(root,relative);
      if(entry.isDirectory()){walk(relative);continue;}if(!entry.isFile())continue;
      if(++count>20000)throw new Error('工作区文件过多，请打开更具体的项目文件夹');
      const stat=fs.statSync(file),cached=this.cache.get(relative),signature=`${stat.size}:${stat.mtimeMs}:${stat.ino}`;
      if(!force&&cached?.signature===signature){manifest[relative]=cached.value;if(cached.value.stored)storedBytes+=cached.value.size;continue;}
      // Large binaries remain visible and usable, but are not copied into history.
      let value;if(stat.size>32*1024*1024||storedBytes+stat.size>256*1024*1024)value={size:stat.size,stamp:signature,stored:false};
      else {storedBytes+=stat.size;const bytes=fs.readFileSync(file),sha=hash(bytes),blob=path.join(this.directory,'blobs',sha);fs.mkdirSync(path.dirname(blob),{recursive:true});if(!fs.existsSync(blob))fs.writeFileSync(blob,bytes,{flag:'wx',mode:0o600});value={sha,size:bytes.length,mode:stat.mode&0o777,stored:true};}
      manifest[relative]=value;this.cache.set(relative,{signature,value});
    }};walk('');return manifest;
  }
  checkpoint(title='文件改动',{force=false,document=null}={}){
    const next=this.scan(force),previous=this.record.head,files=[];
    for(const file of new Set([...Object.keys(previous),...Object.keys(next)])){
      if(JSON.stringify(previous[file])===JSON.stringify(next[file]))continue;
      files.push({path:file,before:previous[file]||null,after:next[file]||null,kind:!previous[file]?'added':!next[file]?'deleted':'modified'});
    }
    if(!files.length)return null;
    const entry={id:'file-change-'+crypto.randomUUID(),title,at:new Date().toISOString(),files,document};
    const record={head:next,entries:[entry,...this.record.entries]};
    atomic(this.index,record);this.record=record;return entry;
  }
  list(){return this.record.entries.slice(0,100).map(({files,...entry})=>({...entry,files:files.map(({path,kind,before,after})=>({path,kind,binary:!isText(path),undoable:(!before||before.stored)&&(!after||after.stored)}))}));}
  entry(id){const e=this.record.entries.find(e=>e.id===id);if(!e)throw new Error('这项改动不存在');return e;}
  detail(id,relative) {
    const entry=this.entry(id),file=entry.files.find(f=>f.path===relative);
    if(!file)throw new Error('文件不属于这项改动');
    const read=value=>!value?Buffer.alloc(0):!value.stored?null:fs.readFileSync(path.join(this.directory,'blobs',value.sha));
    const before=read(file.before),after=read(file.after);
    const text=isText(relative)&&before!==null&&after!==null&&!before.includes(0)&&!after.includes(0);
    const result={path:relative,kind:file.kind,before:'',after:'',binary:!text,limited:false,undoable:(!file.before||file.before.stored)&&(!file.after||file.after.stored)};
    if(text){
      const left=before.toString('utf8').split('\n'),right=after.toString('utf8').split('\n');
      let start=0,end=0;
      while(start<Math.min(left.length,right.length)&&left[start]===right[start])start++;
      while(end<Math.min(left.length,right.length)-start&&left[left.length-1-end]===right[right.length-1-end])end++;
      const from=Math.max(0,start-8),tail=Math.max(0,end-8);
      const a=left.slice(from,left.length-tail).join('\n'),b=right.slice(from,right.length-tail).join('\n');
      result.before=a.slice(0,200000);result.after=b.slice(0,200000);result.startLine=from+1;result.limited=a.length>200000||b.length>200000;
    }
    return result;
  }
  undo(id){
    const entry=this.entry(id),current=this.scan(true);
    for(const file of entry.files){if((file.before&&!file.before.stored)||(file.after&&!file.after.stored))throw new Error('这项改动包含未留存的大文件，无法整体撤销');if(JSON.stringify(current[file.path]||null)!==JSON.stringify(file.after))throw new Error(`「${file.path}」在此之后又有改动，未覆盖当前内容`);}
    // Validate every destination before changing the first one.
    for(const file of entry.files){let parent=path.dirname(file.path);while(parent!=='.'&&!fs.existsSync(path.join(this.folder.current.root,parent)))parent=path.dirname(parent);this.folder.resolve(parent);if(fs.existsSync(path.join(this.folder.current.root,file.path)))this.folder.resolve(file.path);}
    const written=[];
    try{for(const file of entry.files){this.restoreFile(file.path,file.before);written.push(file);}}
    catch(error){for(const file of written.reverse())this.restoreFile(file.path,file.after);throw error;}
    this.cache.clear();return this.checkpoint('撤销：'+entry.title,{force:true});
  }
  restoreFile(relative,value){const file=path.join(this.folder.current.root,relative);if(!value){fs.rmSync(file,{force:true});return;}fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.vibe-'+crypto.randomUUID()+'.tmp';try{fs.copyFileSync(path.join(this.directory,'blobs',value.sha),temp,fs.constants.COPYFILE_EXCL);fs.chmodSync(temp,value.mode);fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}}
}
function isText(file){return /\.(md|txt|json|xml|circ|py|js|cjs|mjs|ts|tsx|css|html|csv|yaml|yml|v|sv|asm|s|hex|c|h|log)$/i.test(file)||!path.extname(file);}
module.exports={FolderHistory};
