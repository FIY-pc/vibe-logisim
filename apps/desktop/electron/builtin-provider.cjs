'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID,createHash} = require('node:crypto');
const {validate, maskKey, readCustomProvider, readStoredApiKey} = require('./custom-provider.cjs');
const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'];
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value), {mode:0o600, flag:'wx'}); fs.renameSync(temp,file); }
  finally { fs.rmSync(temp,{force:true}); }
}
// Stable service records own credentials; conversations hold only their IDs.
const serviceEndpoint = c => String(c?.baseUrl || '').replace(/\/+$/, '');
const matches = (a,b) => Boolean(a && b && serviceEndpoint(a) === serviceEndpoint(b) && a.api === b.api);
const publicService = c => { if(!c)return null; const {apiKey,...rest}=c; return {...rest,apiKeyHint:maskKey(apiKey)}; };
class BuiltinProvider {
  constructor(profileDir) { this.profileDir=profileDir; this.file=path.join(profileDir,'builtin-provider.json'); }
  registry() {
    let saved;
    try { saved=JSON.parse(fs.readFileSync(this.file,'utf8')); }
    catch(e) {
      if(e.code!=='ENOENT')throw new Error('模型服务配置无法读取，原文件已保留');
      const previous=readCustomProvider(this.profileDir);
      saved=previous?{...previous,api:'openai-responses',apiKey:readStoredApiKey(this.profileDir),effort:'none'}:null;
    }
    if(saved?.version===2){
      if(!Array.isArray(saved.services)||saved.services.some(c=>!c.id||!c.baseUrl||!c.api))throw new Error('模型服务配置无效，原文件已保留');
      return saved;
    }
    if(!saved)return {version:2,defaultId:null,services:[]};
    // Deterministic during read-only migration; written atomically on the next edit.
    const id='legacy-'+createHash('sha256').update(serviceEndpoint(saved)+'\n'+saved.api).digest('hex').slice(0,24);
    return {version:2,defaultId:id,services:[{...saved,id}]};
  }
  read(id) { const r=this.registry(); return r.services.find(c=>c.id===(id===undefined?r.defaultId:id))||null; }
  resolve(selection) {
    if(!selection)return this.read();
    if(selection.serviceId){const c=this.read(selection.serviceId);return matches(selection,c)?c:null;}
    const found=this.registry().services.filter(c=>matches(selection,c));
    return found.length===1?found[0]:null;
  }
  visible(id) { return publicService(this.read(id)); }
  visibleSelection(selection) { return publicService(this.resolve(selection)); }
  list() { return this.registry().services.map(publicService); }
  validate(input) {
    const old=input.id?this.read(input.id):null;
    const same=old && serviceEndpoint(input)===serviceEndpoint(old);
    const value=validate({...input,effort:input.effort||'none'}, {storedApiKey:same?old.apiKey:null});
    const api=input.api || 'openai-completions';
    if(!APIS.includes(api)) throw new Error('不支持这个接口协议');
    return {...value,api,vision:input.vision===true};
  }
  save(input) {
    const r=this.registry(),value=this.validate(input),old=r.services.find(c=>c.id===input.id);
    // An edited endpoint/protocol is a new destination, preserving old bindings.
    const id=matches(old,value)?old.id:randomUUID();
    const next={...value,id};
    const index=r.services.findIndex(c=>c.id===id);
    if(index<0)r.services.push(next);else r.services[index]=next;
    r.defaultId ||= id;
    atomic(this.file,r);return publicService(next);
  }
  setDefault(id) { const r=this.registry();if(!r.services.some(c=>c.id===id))throw new Error('模型服务不存在');r.defaultId=id;atomic(this.file,r); }
  clear(id) {
    const r=this.registry(),target=id===undefined?r.defaultId:id;
    r.services=r.services.filter(c=>c.id!==target);
    if(r.defaultId===target)r.defaultId=r.services[0]?.id||null;
    atomic(this.file,r);
  }
}
function modelFor(config,metadata=null) {
  // Pi otherwise clamps xhigh/max to high. Manual choices must reach the
  // service unchanged; an unsupported value should fail visibly there.
  const extended=config.effort==='xhigh'||config.effort==='max';
  const adaptive=config.api==='anthropic-messages'&&(extended||(metadata?.efforts?.length&&!metadata.budgetThinking));
  return {id:config.model,name:config.model,api:config.api,provider:'vibe-'+createHash('sha256').update((config.id||'')+'\n'+config.baseUrl.replace(/\/+$/,'')+'\n'+config.api).digest('hex').slice(0,24),baseUrl:config.baseUrl,
    reasoning:config.effort!=='none', input:config.vision?['text','image']:['text'],
    thinkingLevelMap:{xhigh:'xhigh',max:'max'},...(adaptive?{compat:{forceAdaptiveThinking:true}}:{}),
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:config.contextWindow,maxTokens:8192};
}
async function transport(api) {
  const sdk=await import('./builtin-sdk.mjs');
  if(api==='openai-responses')return {streamSimple:sdk.responses};
  if(api==='anthropic-messages')return {streamSimple:sdk.anthropic};
  if(api==='openai-completions')return {streamSimple:sdk.completions};
  throw new Error('不支持这个接口协议');
}
module.exports={BuiltinProvider,modelFor,transport,atomic,APIS};
