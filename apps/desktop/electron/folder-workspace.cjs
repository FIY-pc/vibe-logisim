'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const ignored=new Set(['.git','node_modules','.venv','__pycache__','.codex','.ssh','.config','.local','codex-home','circuit-agent']);
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temp,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}}

// A folder is the collaboration identity. Document identities and revisions
// remain with Circuit Lens; this owner never rewrites existing user files.
class FolderWorkspace extends EventEmitter {
  constructor(stateRoot){super();this.stateRoot=path.resolve(stateRoot);this.current=null;this.watcher=null;this.timer=null;this.poller=null;this.listed=new Set(['']);this.lastSignature='';}
  recordFile(id){return path.join(this.stateRoot,id,'workspace.json');}
  async open(directory,{activeFile,conversationKey}={}){
    const root=await fs.promises.realpath(directory);
    if(!(await fs.promises.stat(root)).isDirectory())throw new Error('请选择文件夹');
    const id='folder-'+hash(root).slice(0,16);let record;
    try{record=JSON.parse(await fs.promises.readFile(this.recordFile(id),'utf8'));if(record.root!==root)throw new Error('工作区记录与文件夹不匹配');}
    catch(error){if(error.code!=='ENOENT')throw error;record={id,root,name:path.basename(root),activeFile:null,conversationKey:conversationKey||'folder:'+hash(root)};}
    if(activeFile){const relative=path.relative(root,path.resolve(activeFile));if(!relative.startsWith('..')&&!path.isAbsolute(relative))record.activeFile=relative;}
    if(record.activeFile&&!fs.existsSync(path.join(root,record.activeFile)))record.activeFile=null;
    this.close();this.current=record;this.listed=new Set(['']);this.persist();
    atomic(path.join(this.stateRoot,'recent.json'),{root});
    this.watch();return this.snapshot();
  }
  recent(){try{return JSON.parse(fs.readFileSync(path.join(this.stateRoot,'recent.json'),'utf8')).root;}catch{return null;}}
  snapshot(){return this.current?{...this.current}:null;}
  persist(){if(this.current)atomic(this.recordFile(this.current.id),this.current);}
  assert(id){if(!this.current||id!==this.current.id)throw new Error('工作区已切换，请重试');return this.current;}
  resolve(relative,{exists=true}={}){
    if(!this.current)throw new Error('请先打开文件夹');
    if(typeof relative!=='string'||relative.includes('\0')||path.isAbsolute(relative))throw new Error('文件路径无效');
    const target=path.resolve(this.current.root,relative),root=this.current.root;
    if(target!==root&&!target.startsWith(root+path.sep))throw new Error('文件不在当前工作区内');
    const base=exists?target:path.dirname(target);const real=fs.realpathSync(base);
    if(real!==root&&!real.startsWith(root+path.sep))throw new Error('链接指向工作区之外，请单独打开所在文件夹');
    return target;
  }
  select(relative){this.resolve(relative);if(path.extname(relative).toLowerCase()!=='.circ')throw new Error('请选择 .circ 电路文件');this.current.activeFile=relative;this.persist();return this.snapshot();}
  clearDocument(){if(this.current){this.current.activeFile=null;this.persist();}}
  list(relative='',hidden=false){
    const folder=this.resolve(relative);this.listed.add(relative);
    const entries=fs.readdirSync(folder,{withFileTypes:true}).filter(e=>hidden||!e.name.startsWith('.')).map(e=>({name:e.name,path:path.join(relative,e.name),kind:e.isDirectory()?'directory':e.isSymbolicLink()?'link':'file'}));
    return entries.sort((a,b)=>(a.kind==='directory'?0:1)-(b.kind==='directory'?0:1)||a.name.localeCompare(b.name,'zh-CN',{numeric:true}));
  }
  read(relative,max=32*1024*1024){const file=this.resolve(relative),stat=fs.statSync(file);if(!stat.isFile())throw new Error('请选择文件');if(stat.size>max)throw new Error('文件较大，请使用系统应用打开');return {item:{id:relative,name:path.basename(file),path:relative,size:stat.size,modifiedAt:stat.mtimeMs},bytes:fs.readFileSync(file)};}
  saveExplorer(value) {
    const valid=p=>typeof p==='string'&&p.length<4096&&!path.isAbsolute(p)&&!p.split('/').includes('..')&&!p.includes('\0');
    this.current.explorer={expanded:[...new Set((Array.isArray(value.expanded)?value.expanded:[]).filter(valid))].slice(0,2000),selected:valid(value.selected)?value.selected:'',showHidden:value.showHidden===true};
    this.persist();return this.current.explorer;
  }
  create(relative,directory){
    const file=this.resolve(relative,{exists:false});if(file===this.current.root)throw new Error('不能覆盖工作区');
    try {
      if(directory)fs.mkdirSync(file);
      else {
        const contents=path.extname(relative).toLowerCase()==='.circ'?fs.readFileSync(path.join(__dirname,'templates/blank.circ')):'';
        fs.writeFileSync(file,contents,{flag:'wx'});
      }
    } catch(error) {
      if(error.code==='EEXIST')throw new Error('同名文件或文件夹已存在，请换一个名称');
      if(error.code==='EACCES')throw new Error('无法在此文件夹中新建，请检查写入权限');
      throw error;
    }
    this.changed();
  }
  rename(relative,name){if(!name||name!==path.basename(name)||name==='.'||name==='..')throw new Error('请输入有效名称');const from=this.resolve(relative),to=this.resolve(path.join(path.dirname(relative),name),{exists:false});if(from===this.current.root||fs.existsSync(to))throw new Error('目标名称已存在');fs.renameSync(from,to);if(this.current.activeFile===relative)this.current.activeFile=path.relative(this.current.root,to);this.persist();this.changed();return path.relative(this.current.root,to);}
  changed(){clearTimeout(this.timer);this.timer=setTimeout(()=>this.emit('changed',this.snapshot()),200);this.timer.unref?.();}
  watch(){
    try{this.watcher=fs.watch(this.current.root,{recursive:true},(_,filename)=>{if(filename&&!filename.toString().split(path.sep).some(p=>ignored.has(p)))this.changed();});this.watcher.on('error',()=>{});}catch{/* Poll listed directories on systems without recursive watching. */}
    this.poller=setInterval(()=>{if(!this.current)return;let signature='';for(const folder of this.listed){try{signature+=fs.readdirSync(this.resolve(folder),{withFileTypes:true}).filter(e=>!ignored.has(e.name)).map(e=>{try{const s=fs.statSync(path.join(this.current.root,folder,e.name));return `${folder}/${e.name}:${s.size}:${s.mtimeMs}`;}catch{return e.name;}}).join('|');}catch{}}
      if(signature!==this.lastSignature){this.lastSignature=signature;this.changed();}},1500);this.poller.unref?.();
  }
  close(){this.watcher?.close();clearTimeout(this.timer);clearInterval(this.poller);this.watcher=null;this.current=null;}
}
module.exports={FolderWorkspace,atomic,hash,ignored};
