'use strict';
// Public metadata is not an account inventory or a transport configuration.
// Only exact, locally declared endpoints can borrow provider-scoped metadata.
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {atomic}=require('./builtin-provider.cjs');
const {discoverModels}=require('./provider-probe.cjs');
const {EFFORTS}=require('./custom-provider.cjs');
const URL='https://models.dev/api.json';
const VERSION=2;
const TTL=6*60*60*1000;
const MAX_BYTES=12*1024*1024;
const ENDPOINTS={
  'https://api.openai.com/v1':'openai',
  'https://api.anthropic.com':'anthropic',
  'https://api.anthropic.com/v1':'anthropic',
  'https://api.deepseek.com':'deepseek',
  'https://api.deepseek.com/v1':'deepseek',
  'https://openrouter.ai/api/v1':'openrouter',
  'https://api.moonshot.ai/v1':'moonshotai',
  'https://api.moonshot.cn/v1':'moonshotai-cn',
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1':'alibaba',
  'https://dashscope.aliyuncs.com/compatible-mode/v1':'alibaba-cn',
  'https://api.z.ai/api/paas/v4':'zai',
  'https://open.bigmodel.cn/api/paas/v4':'zhipuai',
  'https://api.minimax.io/anthropic':'minimax',
  'https://api.minimaxi.com/anthropic':'minimax-cn',
};
const providerFor=c=>ENDPOINTS[String(c?.baseUrl||'').replace(/\/+$/,'')]||null;
const modelId=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/.test(id);
const finite=n=>Number.isSafeInteger(n)&&n>0&&n<=10000000?n:null;
function normalize(data){
  if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('模型目录格式无效');
  const providers={};
  for(const id of new Set(Object.values(ENDPOINTS))){
    const source=data[id]?.models;
    if(!source||typeof source!=='object'||Array.isArray(source))continue;
    const rows=Object.create(null);
    for(const [key,m] of Object.entries(source).slice(0,10000)){
      if(!modelId(key)||!m||m.id!==key||typeof m.name!=='string'||m.name.length>160)continue;
      rows[key]={id:key,name:m.name,contextWindow:finite(m.limit?.context),maxOutput:finite(m.limit?.output),
        vision:Array.isArray(m.modalities?.input)?m.modalities.input.includes('image'):null,
        reasoning:typeof m.reasoning==='boolean'?m.reasoning:null,toolCall:typeof m.tool_call==='boolean'?m.tool_call:null,
        // Preserve advertised effort values; a reasoning boolean alone does not
        // prove that the API accepts low/medium/high.
        efforts:EFFORTS.filter(value=>value!=='none'&&(Array.isArray(m.reasoning_options)?m.reasoning_options:[]).some(option=>option?.type==='effort'&&Array.isArray(option.values)&&option.values.includes(value))),
        budgetThinking:Array.isArray(m.reasoning_options)&&m.reasoning_options.some(option=>option?.type==='budget_tokens'),
        status:['deprecated','retired'].includes(m.status)?m.status:null};
    }
    if(Object.keys(rows).length)providers[id]=rows;
  }
  if(!Object.keys(providers).length)throw new Error('模型目录没有可识别的数据');
  return providers;
}
function read(file){try{if(fs.statSync(file).size>MAX_BYTES)return null;return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
function inventoryKey(c){return createHash('sha256').update(JSON.stringify([c.id,c.baseUrl,c.api,c.apiKey])).digest('hex');}
class ModelCatalog {
  constructor({profileDir,fetchMetadata=async()=>globalThis.fetch,fetchProvider=async()=>globalThis.fetch,onUpdate=()=>{},timeoutMs=12000}){
    Object.assign(this,{profileDir,fetchMetadata,fetchProvider,onUpdate,timeoutMs});
    this.file=path.join(profileDir,'model-metadata.json');
    const bundled=require('./model-catalog.snapshot.json'),cached=read(this.file);
    // Cache uses the same public schema as the bundled snapshot and is validated
    // again before use. A partial/corrupt write cannot replace the fallback.
    this.metadata=normalize(bundled.providers);this.updatedAt=0;this.version=0;this.error=null;this.lastAttempt=0;
    // v1 removed extended effort values, so it cannot override the complete
    // bundled catalog while waiting for the next successful refresh.
    if(cached?.version===VERSION){try{this.metadata=normalize(cached.providers);this.updatedAt=Number(cached.updatedAt)||0;}catch{}}
    this.inventories=new Map();this.refreshes=new Map();
  }
  metadataFor(c,id){const rows=this.metadata[providerFor(c)];return rows&&Object.hasOwn(rows,id)?rows[id]:null;}
  inventory(c){
    const key=inventoryKey(c);
    if(!this.inventories.has(key)){
      const saved=read(path.join(this.profileDir,'model-lists',key+'.json'));
      this.inventories.set(key,{models:Array.isArray(saved?.models)?saved.models.filter(modelId).slice(0,400):[],error:null});
    }
    return this.inventories.get(key);
  }
  rows(c,selected=c){
    if(!c)return [];
    return [...new Set([selected?.model,...(c.models||[]),...this.inventory(c).models].filter(Boolean))].map(id=>{
      const metadata=this.metadataFor(c,id);
      // Missing metadata (including reasoning models without advertised effort
      // values) is not evidence that the service rejects manual thinking levels.
      // Keep the runtime's existing controls; only explicit metadata can narrow
      // them. These fallback options do not become claimed model capabilities.
      const manual=c.api==='anthropic-messages'&&metadata?.budgetThinking?['low','medium','high']:EFFORTS.filter(value=>value!=='none');
      const levels=metadata?.efforts?.length?metadata.efforts:metadata?.reasoning===false?[]:manual;
      const effort=id===selected.model?selected.effort:levels.includes(c.effort)?c.effort:'none';
      // Preserve saved overrides even when a later catalog disagrees.
      const choices=[...new Set(['none',...levels,...(effort&&effort!=='none'?[effort]:[])])];
      return {model:id,name:metadata?.name||id,description:'',metadata:metadata?{...metadata,source:'models.dev'}:null,
        isDefault:id===selected.model,defaultEffort:effort||'none',efforts:choices.map(value=>({value}))};
    });
  }
  status(c){return {version:this.version,status:c&&(this.refreshes.has(inventoryKey(c))||providerFor(c)&&this.pending)?'refreshing':'ready',error:c?this.inventory(c).error||(providerFor(c)?this.error:null):null};}
  async refreshMetadata(force=false){
    if(this.pending)return this.pending;
    if(!force&&(Date.now()-this.updatedAt<TTL||Date.now()-this.lastAttempt<60000))return;
    this.lastAttempt=Date.now();
    this.pending=(async()=>{
      try{
        const fetch=await this.fetchMetadata();
        const response=await fetch(URL,{signal:AbortSignal.timeout(this.timeoutMs),redirect:'error',headers:{Accept:'application/json'}});
        if(!response.ok)throw new Error('模型资料刷新失败');
        const reader=response.body?.getReader();if(!reader)throw new Error('模型目录为空');
        const chunks=[];let bytes=0;
        for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BYTES){await reader.cancel();throw new Error('模型目录过大');}chunks.push(Buffer.from(value));}
        const providers=JSON.parse(Buffer.concat(chunks).toString('utf8')),metadata=normalize(providers);
        const snapshot={version:VERSION,updatedAt:Date.now(),providers:compact(providers)};
        atomic(this.file,snapshot);this.metadata=metadata;this.updatedAt=snapshot.updatedAt;this.error=null;
      }catch{this.error='模型资料未更新，仍使用已有目录。';}
      finally{this.pending=null;this.version++;this.onUpdate();}
    })();
    return this.pending;
  }
  async refresh(c){
    if(!c)return;
    const key=inventoryKey(c);if(this.refreshes.has(key))return this.refreshes.get(key);
    const task=(async()=>{
      const inventory=this.inventory(c);
      try{
        const fetch=await this.fetchProvider(c),deadline=AbortSignal.timeout(this.timeoutMs);
        // Include body reads in the deadline, even when /models sends headers
        // promptly and then stalls halfway through the JSON response.
        const result=await discoverModels({...c,timeoutMs:this.timeoutMs,fetch:(url,options)=>fetch(url,{...options,signal:AbortSignal.any([deadline,options.signal])})});
        if(result?.models){
          const models=result.models.filter(modelId).slice(0,400);
          atomic(path.join(this.profileDir,'model-lists',key+'.json'),{models});inventory.models=models;
        }
        inventory.error=result===null?'此服务不提供模型列表，可在 AI 设置中填写模型 ID。':null;
      }catch(e){inventory.error='模型列表未更新：'+e.message;}
      await (providerFor(c)?this.refreshMetadata(true):Promise.resolve());
    })().finally(()=>{this.refreshes.delete(key);this.version++;this.onUpdate();});
    this.refreshes.set(key,task);return task;
  }
}
// Keep only display/capability fields. Transport URLs, headers, pricing and
// marketing descriptions from the feed never enter the saved snapshot.
function compact(data){
  const normalized=normalize(data),providers={};
  for(const [id,rows] of Object.entries(normalized))providers[id]={models:Object.fromEntries(Object.entries(rows).map(([key,m])=>[key,{id:key,name:m.name,
    limit:{context:m.contextWindow,output:m.maxOutput},modalities:m.vision===null?undefined:{input:m.vision?['text','image']:['text']},
    reasoning:m.reasoning,tool_call:m.toolCall,status:m.status,reasoning_options:[...(m.efforts.length?[{type:'effort',values:m.efforts}]:[]),...(m.budgetThinking?[{type:'budget_tokens'}]:[])]}]))};
  return providers;
}
module.exports={ModelCatalog,normalize,compact,providerFor,URL,VERSION};
