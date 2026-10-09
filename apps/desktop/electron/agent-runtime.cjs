'use strict';
const {EventEmitter}=require('node:events');
const fs=require('node:fs');
const path=require('node:path');
const {CodexBackend}=require('./codex-backend.cjs');
const {BuiltinBackend}=require('./builtin-backend.cjs');
const {ConversationStore}=require('./conversation-store.cjs');
const {atomic}=require('./builtin-provider.cjs');

// One desktop-facing interface; each persisted conversation owns its runtime.
// A record without runtime and with a native thread is always legacy Codex.
class AgentRuntime extends EventEmitter {
  constructor(options) {
    super();this.options=options;this.store=new ConversationStore(options.sessionStorePath);
    this.settingsFile=path.join(options.profileDir,'runtime-selection.json');
    this.defaultRuntime='builtin';
    try {const settings=JSON.parse(fs.readFileSync(this.settingsFile,'utf8'));if(['builtin','codex'].includes(settings.runtime))this.defaultRuntime=settings.runtime;}
    catch(e){if(e.code!=='ENOENT')throw new Error('运行时设置无法读取，原文件已保留');}
    this.backends={builtin:new BuiltinBackend(options),codex:new CodexBackend(options)};
    this.kind=this.defaultRuntime;this.workspaceKey=null;this.switching=false;
    for(const [kind,backend] of Object.entries(this.backends)){
      backend.on('log',message=>this.emit('log',message));
      backend.on('event',event=>{if(this.kind===kind)this.emit('event',event.type==='status'?{...event,...this.snapshot()}:event);});
    }
  }
  get active(){return this.backends[this.kind];}
  get status(){return this.active.status;}
  get workDir(){return this.active.workDir;}
  set workDir(value){for(const b of Object.values(this.backends))b.workDir=value;}
  set currentCwd(value){for(const b of Object.values(this.backends))b.currentCwd=value;}
  get profileDir(){return this.options.profileDir;}
  get threadId(){return this.active.threadId;}
  snapshot(){return {...this.active.snapshot(),runtime:this.kind,defaultRuntime:this.defaultRuntime,busy:this.switching||this.active.snapshot().busy};}
  emitStatus(){this.emit('event',{type:'status',...this.snapshot()});}
  async start(){await this.active.start();return this.snapshot();}
  async stop(){await Promise.all(Object.values(this.backends).map(b=>b.stop()));}
  async activate(kind){if(this.kind===kind)return;await this.active.stop();this.kind=kind;}
  recordRuntime(record){return record.runtime||(record.threadId||record.messages?.length?'codex':this.defaultRuntime);}
  async resumeWorkspace(info){
    const record=this.store.ensure(info.workspaceKey),kind=this.recordRuntime(record);
    if(!['builtin','codex'].includes(kind))throw new Error('这条对话的运行时不可用');
    this.workspaceKey=info.workspaceKey;this.revisionId=info.revisionId;
    await this.activate(kind);
    if(!record.runtime)this.store.runtimeData(info.workspaceKey,{runtime:kind},record.id);
    // Hydrate local history before starting the process. A missing CLI must
    // prevent sending, not hide the conversation the user just opened.
    const result=await this.active.resumeWorkspace(info);
    await this.active.start();return result;
  }
  conversationState(key){this.store.ensure(key);return {workspaceKey:key,...this.store.state(key)};}
  async changeConversation(key,action,request){
    if(this.snapshot().busy)throw new Error('请先停止当前回答');
    if(action==='fork')return this.active.changeConversation(key,action,request);
    const before=this.store.active(key),next=this.store.change(key,action,request);
    if(action==='new'&&!next.conversation.threadId&&!next.conversation.messages.length)this.store.runtimeData(key,{runtime:this.defaultRuntime},next.activeId);
    if(next.activeId!==before?.id||this.workspaceKey!==key||this.kind!==this.recordRuntime(this.store.active(key))){await this.active.resetWorkspace('conversation-changed');await this.resumeWorkspace({workspaceKey:key,revisionId:this.revisionId});}
    const result=this.conversationState(key);this.emit('event',{type:'conversations-changed',activate:next.activeId!==before?.id,...result});return result;
  }
  setDefaultRuntime(kind){
    if(!['builtin','codex'].includes(kind))throw new Error('未知运行时');
    atomic(this.settingsFile,{runtime:kind});this.defaultRuntime=kind;this.emitStatus();return this.snapshot();
  }
  async newRuntimeConversation(kind){
    if(!['builtin','codex'].includes(kind))throw new Error('未知运行时');
    if(this.snapshot().busy)throw new Error('请先停止当前回答');
    this.switching=true;this.emitStatus();
    try {
      if(this.workspaceKey){
        const saved=this.store.ensure(this.workspaceKey);
        if(saved.threadId||saved.messages?.length)this.store.change(this.workspaceKey,'new');
        const current=this.store.ensure(this.workspaceKey);this.store.runtimeData(this.workspaceKey,{runtime:kind},current.id);
        await this.active.resetWorkspace('runtime-changed');
        await this.activate(kind);await this.active.resumeWorkspace({workspaceKey:this.workspaceKey,revisionId:this.revisionId});
      }else await this.activate(kind);
      await this.active.start();
    }finally{this.switching=false;this.emitStatus();}
    return this.snapshot();
  }
  async ask(request){await this.resumeForAsk(request);return this.active.ask(request);}
  async resumeForAsk(request){const record=this.store.ensure(request.workspaceKey);if(this.recordRuntime(record)!==this.kind||this.active.workspaceKey!==request.workspaceKey)await this.resumeWorkspace({workspaceKey:request.workspaceKey,revisionId:request.context?.revisionId});}
  async resetWorkspace(reason){await this.active.resetWorkspace(reason);this.workspaceKey=null;}
  async login(){if(this.kind!=='codex')await this.newRuntimeConversation('codex');return this.active.login();}
  async cancelLogin(){return this.backends.codex.cancelLogin();}
  async logout(){if(this.kind!=='codex')throw new Error('请先切换到 Codex 运行时');return this.active.logout();}
}
for(const method of ['listModels','selectModel','bindProvider','defaultProvider','reconnect','canReconnect','networkStatus','probeCustomProvider','configureCustomProvider','clearCustomProvider','capabilityReport','invalidateRevision','setChangeMode','answer','interrupt']){
  AgentRuntime.prototype[method]=function(...args){return this.active[method](...args);};
}
module.exports={AgentRuntime};
