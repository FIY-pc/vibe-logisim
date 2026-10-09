'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn,execFile}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const referenceRoot=path.resolve(__dirname,'../circuit-knowledge');
const inside=(root,target)=>target===root||target.startsWith(root+path.sep);
const result=text=>({content:[{type:'text',text}],details:null});
async function resolveFile(root,value,write=false) {
  const target=path.resolve(root,value);
  const allowed=inside(root,target) || (!write&&inside(referenceRoot,target));
  if(!allowed)throw new Error('路径不在工作区或内置参考目录中');
  const base=inside(root,target)?await fs.realpath(root):await fs.realpath(referenceRoot);
  const parent=await fs.realpath(path.dirname(target));
  if(!inside(base,parent))throw new Error('链接指向工作区之外');
  try { if(!inside(base,await fs.realpath(target)))throw new Error('链接指向工作区之外'); }
  catch(e) { if(e.code!=='ENOENT'||!write)throw e; }
  return target;
}
function command(commandText,{root,runtimeRoot,signal,timeout=120}) {
  if(process.platform!=='linux')throw new Error('当前系统尚不支持内置运行时的隔离命令执行，请使用文件和电路工具或选择 Codex');
  const unit=`vibe-builtin-${randomUUID()}.service`;
  const bind=(source,target)=>`${JSON.stringify(source)}:${JSON.stringify(target)}`;
  const readOnly=[bind(referenceRoot,'/tmp/vibe-circuit-reference')];
  if(runtimeRoot)readOnly.push(bind(runtimeRoot,'/tmp/vibe-runtime'));
  const args=['--user','--pipe','--quiet','--collect','--service-type=exec',`--unit=${unit}`,
    '--property=ProtectSystem=strict','--property=ProtectHome=tmpfs','--property=PrivateTmp=yes',
    '--property=PrivateDevices=yes','--property=PrivateIPC=yes','--property=ProtectProc=invisible','--property=ProcSubset=pid',
    '--property=InaccessiblePaths=/run /var -/opt -/srv -/media -/mnt -/boot -/sys -/.snapshots',
    `--property=BindPaths=${bind(root,'/tmp/workspace')}`,`--property=BindReadOnlyPaths=${readOnly.join(' ')}`,
    '--property=NoNewPrivileges=yes','--property=CapabilityBoundingSet=','--property=RestrictSUIDSGID=yes',
    `--property=RuntimeMaxSec=${Math.min(300,Math.max(1,timeout))+2}`,'--property=UMask=0077','--property=MemoryMax=6442450944','--property=TasksMax=512',
    '--working-directory=/tmp/workspace','/usr/bin/env','-i','HOME=/tmp',
    `PATH=${runtimeRoot?'/tmp/vibe-runtime/python/bin:/tmp/vibe-runtime/java/bin:':''}/usr/bin:/bin`,
    'LANG=C.UTF-8','/bin/bash','--noprofile','--norc','-c',commandText];
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(new Error('已停止'));
    const child=spawn('systemd-run',args,{cwd:'/',env:{PATH:process.env.PATH,XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR,DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS},stdio:['ignore','pipe','pipe']});
    let output='',stopped=false,stopTimer=null;
    const append=chunk=>{output=(output+chunk.toString()).slice(-64000);};
    child.stdout.on('data',append);child.stderr.on('data',append);
    const kill=()=>execFile('systemctl',['--user','kill','--signal=SIGKILL',unit],()=>{});
    const stop=()=>{stopped=true;kill();stopTimer ||= setInterval(kill,100);};
    const timer=setTimeout(stop,Math.min(300,Math.max(1,timeout))*1000);
    signal?.addEventListener('abort',stop,{once:true});
    const cleanup=()=>{clearTimeout(timer);clearInterval(stopTimer);signal?.removeEventListener('abort',stop);};
    child.on('error',e=>{cleanup();reject(e);});
    child.on('close',code=>{cleanup();stopped?reject(new Error('命令已停止或超时')):resolve(result(JSON.stringify({exitCode:code,output})));});
  });
}
function workspaceTools({root,runtimeRoot,assertCurrent}) {
  const schema=properties=>({type:'object',properties,required:Object.keys(properties).filter(x=>x!=='timeout'),additionalProperties:false});
  const string={type:'string'};
  const tools=[
    {name:'read_file',label:'读取文件',description:'Read UTF-8 text from a workspace-relative path or the bundled reference directory. Use shell commands for large files.',parameters:schema({path:string}),execute:async(_id,args,signal)=>{assertCurrent();signal?.throwIfAborted();const file=await resolveFile(root,args.path);if((await fs.stat(file)).size>512000)throw new Error('文件超过 512 KB，请用命令按段读取');return result(await fs.readFile(file,'utf8'));}},
    {name:'write_file',label:'写入文件',description:'Write UTF-8 text to a workspace-relative file. Parent directory must exist.',parameters:schema({path:string,content:string}),execute:async(_id,args,signal)=>{assertCurrent();signal?.throwIfAborted();const file=await resolveFile(root,args.path,true);if(Buffer.byteLength(args.content)>2*1024*1024)throw new Error('单次写入超过 2 MB');await fs.writeFile(file,args.content,'utf8');return result('已写入 '+args.path);}},
    {name:'list_files',label:'列出文件',description:'List entries of a workspace-relative directory (use . for workspace root).',parameters:schema({path:string}),execute:async(_id,args,signal)=>{assertCurrent();signal?.throwIfAborted();const requested=path.resolve(root,args.path);const file=requested===root?await fs.realpath(root):await resolveFile(root,args.path);const entries=await fs.readdir(file,{withFileTypes:true});return result(JSON.stringify(entries.slice(0,500).map(e=>({name:e.name,directory:e.isDirectory()}))));}},
  ];
  if(process.platform==='linux')tools.push({name:'exec_command',label:'执行命令',description:'Run bash in an isolated writable workspace at /tmp/workspace. Bundled references are read-only at /tmp/vibe-circuit-reference. No model credentials or user home access. Output is limited to the last 64000 characters.',parameters:schema({command:string,timeout:{type:'number'}}),execute:async(_id,args,signal)=>{assertCurrent();return command(args.command,{root,runtimeRoot,signal,timeout:args.timeout});}});
  return tools;
}
module.exports={workspaceTools,resolveFile,command,referenceRoot};
