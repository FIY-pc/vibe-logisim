'use strict';
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {Readable, Transform} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const runFile = promisify(execFile);
const ACTIVE = new Set(['downloading', 'verifying', 'extracting']);

// Owns only the pinned optional runtime, never account profiles or conversations.
class RuntimeInstaller extends EventEmitter {
  constructor({spec, directory, python, fetch = globalThis.fetch, extract, timeoutMs = 20 * 60 * 1000}) {
    super();
    if (!/^[a-f0-9]{64}$/.test(spec.sha256) || !Array.isArray(spec.programs) || !spec.programs.length || spec.programs.some(p => p.includes('..') || path.isAbsolute(p))) throw new Error('运行时清单无效');
    Object.assign(this, {spec, directory, python, fetch, timeoutMs});
    this.extract = extract || ((archive, target, signal) => runFile(python, [path.join(__dirname, 'extract-runtime.py'), archive, target], {
      signal, timeout:180000, windowsHide:true, maxBuffer:16384,
      env:{...process.env, PYTHONNOUSERSITE:'1', PYTHONDONTWRITEBYTECODE:'1', PYTHONUTF8:'1', PYTHONHOME:'', PYTHONPATH:''},
    }));
    this.state = {phase:this.ready()?'ready':'missing', received:0, total:null, error:null};
  }
  ready() {
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(this.directory, 'installed.json'), 'utf8'));
      return receipt.sha256 === this.spec.sha256 && this.spec.programs.every(name => {
        const file = path.join(this.directory, name);
        fs.accessSync(file, process.platform==='win32'?fs.constants.F_OK:fs.constants.X_OK);
        return fs.statSync(file).isFile();
      });
    } catch { return false; }
  }
  snapshot() { return {...this.state, version:this.spec.version, busy:ACTIVE.has(this.state.phase)}; }
  update(patch) { Object.assign(this.state, patch); this.emit('change', this.snapshot()); }
  ensure() {
    if (this.pending) return this.pending;
    if (this.ready()) { this.update({phase:'ready',error:null}); return Promise.resolve(this.directory); }
    this.controller = new AbortController();
    this.update({phase:'downloading',received:0,total:null,error:null});
    this.pending = this.install(this.controller.signal).finally(() => { this.pending=null;this.controller=null; });
    return this.pending;
  }
  async cancel() { this.controller?.abort(); await this.pending?.catch(() => {}); }
  async install(signal) {
    let staging=null;
    const timer = setTimeout(() => this.controller?.abort(new Error('下载超时，请重试')), this.timeoutMs);
    try {
      await fsp.mkdir(path.dirname(this.directory), {recursive:true,mode:0o700});
      staging=await fsp.mkdtemp(path.join(path.dirname(this.directory), '.install-'));
      const response = await this.fetch(this.spec.url, {signal,redirect:'follow'});
      if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}）`);
      const total=Number(response.headers.get('content-length')) || null;
      if (total > 512*1024*1024) throw new Error('运行时文件超出预期大小');
      this.update({total});
      const hash=createHash('sha256'), archive=path.join(staging,'runtime.archive');let received=0,last=0;
      const meter=new Transform({transform:(chunk,_encoding,done)=>{
        received+=chunk.length;
        if(received>512*1024*1024)return done(new Error('运行时文件超出预期大小'));
        hash.update(chunk);
        if(Date.now()-last>200){last=Date.now();this.update({received});}
        done(null,chunk);
      }});
      await pipeline(Readable.fromWeb(response.body),meter,fs.createWriteStream(archive,{flags:'wx',mode:0o600}),{signal});
      this.update({phase:'verifying',received});
      if(hash.digest('hex')!==this.spec.sha256)throw new Error('下载文件校验失败，请重试');
      signal.throwIfAborted();this.update({phase:'extracting'});
      const target=path.join(staging,'runtime');await fsp.mkdir(target);
      await this.extract(archive,target,signal);
      for(const name of this.spec.programs){const file=path.join(target,name);const stat=await fsp.lstat(file);if(!stat.isFile())throw new Error('运行时文件不完整');await fsp.access(file,process.platform==='win32'?fs.constants.F_OK:fs.constants.X_OK);}
      signal.throwIfAborted();
      await fsp.writeFile(path.join(target,'installed.json'),JSON.stringify({sha256:this.spec.sha256,version:this.spec.version}),{mode:0o600});
      // A damaged managed copy is replaced only after the new copy is complete.
      let previous=null;
      try{await fsp.rename(this.directory,path.join(staging,'previous'));previous=path.join(staging,'previous');}catch(e){if(e.code!=='ENOENT')throw e;}
      try{await fsp.rename(target,this.directory);}catch(e){if(previous)await fsp.rename(previous,this.directory);throw e;}
      this.update({phase:'ready',error:null});return this.directory;
    } catch(error) {
      const message=signal.aborted?(signal.reason?.message==='下载超时，请重试'?'下载超时，请重试':'已取消下载'):error.message;
      this.update({phase:signal.aborted?'cancelled':'error',error:message});
      throw new Error(message);
    } finally { clearTimeout(timer);if(staging)await fsp.rm(staging,{recursive:true,force:true}); }
  }
}
module.exports={RuntimeInstaller};
