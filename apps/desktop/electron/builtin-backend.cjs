'use strict';
const {EventEmitter}=require('node:events');
const {randomUUID}=require('node:crypto');
const {ConversationStore}=require('./conversation-store.cjs');
const {BuiltinProvider,modelFor,transport}=require('./builtin-provider.cjs');
const {workspaceTools,referenceRoot}=require('./builtin-tools.cjs');
const {splitModelContent}=require('./model-tool-output.cjs');
const {projectModelResult}=require('./model-result-projection.cjs');
const {DEVELOPER_INSTRUCTIONS,REFERENCE_PATH_TOKEN}=require('./agent-instructions.cjs');
const {resolveSystemProxy,sessionConfig}=require('./system-proxy.cjs');
const {discoverModels}=require('./provider-probe.cjs');
const {selectionFor,sameService,configurationIssue,recoverHistory}=require('./builtin-session.cjs');

// Supply an error result for a call left unfinished by an application crash.
// Never re-execute recorded calls when restoring a conversation.
function recoverTranscript(messages) {
  const results=new Set(messages.filter(m=>m.role==='toolResult').map(m=>m.toolCallId));
  return messages.flatMap(m=>[m,...(m.role==='assistant'?(m.content||[]).filter(c=>c.type==='toolCall'&&!results.has(c.id)).map(c=>({role:'toolResult',toolCallId:c.id,toolName:c.name,content:[{type:'text',text:'应用在这次调用完成前退出，结果未知。请先检查工作区，不要直接重复有副作用的操作。'}],isError:true,timestamp:Date.now()})):[])]);
}
class BuiltinBackend extends EventEmitter {
  constructor(options) {
    super();Object.assign(this,options);
    this.provider=new BuiltinProvider(options.profileDir);
    this.conversations=new ConversationStore(options.sessionStorePath);
    this.status='idle';this.history=[];this.workspaceKey=null;this.conversationId=null;
    this.threadId=null;this.activeTurnId=null;this.changeMode='auto';this.pending=null;this.run=null;this.starting=false;
    this.selection=null;this.checkpoints={};this.raw=[];this.steers=new Map();this.transmission=null;
  }
  snapshot() {
    const config=this.provider.visibleSelection(this.selection), selected=this.selection||config;
    const issue=configurationIssue(this.selection,config,this.history.some(m=>m.type==='user'));
    return {runtime:'builtin',status:this.status,detail:this.detail||null,available:this.status==='ready'||this.status==='busy',
      busy:this.starting||Boolean(this.run)||Boolean(this.pending),canSteer:Boolean(this.agent&&this.activeTurnId&&!this.agent.signal?.aborted),
      threadId:this.threadId,conversationId:this.conversationId,turnId:this.activeTurnId,revisionId:this.revisionId||null,
      model:selected?.model||null,effort:selected?.effort==='none'?null:selected?.effort,
      customProvider:config,services:this.provider.list(),defaultServiceId:this.provider.registry().defaultId,account:null,accountMode:'application',signingIn:false,
      providerName:config?.name||'内置运行时',policy:this.workspaceHost?.mode||'workspace',messages:this.history,
      network:this.network||null,canReconnect:!this.starting&&!this.pending&&!this.run,transmission:this.transmission,
      modelConfigurationError:issue,conversationSelection:this.selection,canBindProvider:this.provider.list().length>0,modelSelection:null,inheritedModel:null,inheritedEffort:null,modelCatalog:{status:config?'ready':'unknown',error:null},isolation:process.platform==='linux'?'systemd-linux':'workspace-files-only'};
  }
  emitStatus() { this.emit('event',{type:'status',...this.snapshot()}); }
  async start() {this.status=this.provider.resolve(this.selection)?'ready':'auth-required';this.emitStatus();return this.snapshot();}
  capabilityReport(){return {runtime:'builtin',tools:this.toolHost?.tools.map(t=>t.name)||[],shell:process.platform==='linux'};}
  canReconnect(){return !this.snapshot().busy;}
  async reconnect(){if(!this.canReconnect())throw new Error('请先停止当前回答');return this.start();}
  async resolveNetwork(url){return resolveSystemProxy({targetUrl:url||this.provider.visible()?.baseUrl,env:process.env,resolver:this.resolveProxy});}
  async networkStatus(url){const current=await this.resolveNetwork(url);return {current,active:this.network||null,stale:false};}
  async requestFetch(config){this.network=await this.resolveNetwork(config.baseUrl);return this.probeFetch?await this.probeFetch(sessionConfig(this.network)):globalThis.fetch;}
  async probeCustomProvider(action,input) {
    try {
      const settings={...input,model:input.model||'probe'};
      const config=this.provider.validate(settings),fetch=await this.requestFetch(config);
      if(action==='discover') { const data=await discoverModels({...config,fetch,network:this.network});return {ok:true,models:data?.models||null}; }
      if(action!=='test')throw new Error('无效的接口检测操作');
      const api=await transport(config.api),started=Date.now();
      const output=api.streamSimple(modelFor(config),{messages:[{role:'user',content:'Reply OK.',timestamp:Date.now()}]},
        {apiKey:config.apiKey,fetch,signal:AbortSignal.timeout(30000),maxTokens:64});
      const response=await output.result();
      if(['error','aborted'].includes(response.stopReason))throw new Error(response.errorMessage||'连接检测失败');
      return {ok:true,elapsedMs:Date.now()-started};
    } catch(e){return {ok:false,code:'connection',message:e.message};}
  }
  async configureCustomProvider(settings){
    if(this.snapshot().busy)throw new Error('请先停止当前回答');
    const next=this.provider.save(settings);
    if(this.selection?.serviceId===next.id){this.selection={...this.selection,vision:next.vision,contextWindow:next.contextWindow};this.persist();}
    // A blank conversation can use the newly added service; existing history never moves.
    if(!this.history.some(m=>m.type==='user')&&this.workspaceKey){this.selection=selectionFor(this.provider.read(next.id));this.persist();}
    return this.start();
  }
  async clearCustomProvider(settings={}){if(this.snapshot().busy)throw new Error('请先停止当前回答');this.provider.clear(settings.id);return this.start();}
  async defaultProvider(settings){if(this.snapshot().busy)throw new Error('请先停止当前回答');this.provider.setDefault(settings.id);this.emitStatus();return this.snapshot();}
  async listModels(){const c=this.provider.visibleSelection(this.selection),selected=this.selection||c;return {state:this.snapshot(),models:this.snapshot().modelConfigurationError?[]:[...new Set([...(c?.models||[]),...(selected?.model?[selected.model]:[])])].map(model=>({model,name:model,description:'',isDefault:model===selected.model,defaultEffort:selected.effort==='none'?null:selected.effort,efforts:['none','low','medium','high'].map(value=>({value,description:''}))}))};}
  async selectModel(selection){
    if(this.snapshot().busy)throw new Error('请先停止当前回答');
    const c=this.provider.resolve(this.selection),issue=configurationIssue(this.selection,c,this.history.some(m=>m.type==='user'));
    if(issue)throw new Error(issue.message);
    if(!c||!(c.models||[]).includes(selection?.model)&&selection?.model!==this.selection?.model)throw new Error('请选择已配置模型');
    const next=({...this.provider.validate({...c,model:selection.model,effort:selection.effort||'none'}),id:c.id});
    if(this.workspaceKey){this.selection=selectionFor(next);this.persist();}else this.provider.save(next);
    this.emitStatus();return this.snapshot();
  }
  async bindProvider(request){
    if(this.snapshot().busy)throw new Error('请先停止当前回答');
    const c=this.provider.read(request?.id);
    if(!this.workspaceKey||request?.conversationId!==this.conversationId||!c||!sameService(request,c))throw new Error('会话或服务已变化，请重试');
    this.selection=selectionFor(c);this.persist();return this.start();
  }
  conversationState(key){this.conversations.ensure(key);return {workspaceKey:key,...this.conversations.state(key)};}
  async resumeWorkspace({workspaceKey,revisionId}) {
    const saved=this.conversations.ensure(workspaceKey);
    if(saved.runtime&&saved.runtime!=='builtin'||!saved.runtime&&saved.threadId)throw new Error('这条对话属于 Codex，请使用原运行时继续');
    if(this.snapshot().busy)throw new Error('请先停止当前回答');
    this.workspaceKey=workspaceKey;this.conversationId=saved.id;this.threadId=saved.threadId||null;this.revisionId=revisionId;
    this.selection=saved.runtimeSelection||null;
    const resolved=this.provider.resolve(this.selection);
    if(this.selection&&!this.selection.serviceId&&resolved)this.selection={...this.selection,serviceId:resolved.id};
    this.history=recoverHistory(saved.messages||[]);
    const lastTurn=this.history.findLast(m=>m.type==='turn');
    this.transmission=lastTurn&&lastTurn.status!=='completed'?{phase:lastTurn.status==='interrupted'?'interrupted':'failed',message:lastTurn.error||'上次回答没有完成'}:null;
    this.raw=recoverTranscript([...(saved.runtimeMessages||[]),...(saved.runtimeQueued||[])]);this.checkpoints=saved.runtimeCheckpoints||{};
    if(JSON.stringify(this.history)!==JSON.stringify(saved.messages||[])||this.selection?.serviceId!==saved.runtimeSelection?.serviceId)this.persist();
    this.emit('event',{type:'conversations-changed',activate:true,...this.conversationState(workspaceKey)});
    this.emitStatus();return {resumed:Boolean(this.threadId),threadId:this.threadId};
  }
  persist(){if(!this.workspaceKey)return;
    const active=this.history.find(m=>m.type==='turn'&&m.id===this.activeTurnId&&m.status==='running');
    if(active)active.elapsedMs=Date.now()-active.startedAt;
    this.conversations.remember(this.workspaceKey,{threadId:this.threadId,messages:this.history,expectedId:this.conversationId,
      runtimeData:{runtime:'builtin',runtimeSelection:this.selection,runtimeMessages:this.raw,runtimeQueued:[...this.steers.values()].map(s=>s.message),runtimeCheckpoints:this.checkpoints}});
  }
  async changeConversation(key,action,request) {
    if(this.snapshot().busy)throw new Error('请先停止当前回答');
    if(action==='fork') {
      const source=this.conversations.active(key),point=source.runtimeCheckpoints?.[request.messageId];
      if(!point||!source.messages.some(m=>m.id===request.messageId&&m.type==='assistant'))throw new Error('此回复没有可续接的运行记录');
      const next=this.conversations.fork(key,{sourceId:source.id,sourceThreadId:source.threadId,messageId:request.messageId,turnId:null,
        threadId:'builtin-'+randomUUID(),messages:source.messages.slice(0,point.history),messageContexts:{},toolContract:null});
      this.conversations.runtimeData(key,{runtime:'builtin',runtimeSelection:source.runtimeSelection||null,runtimeMessages:source.runtimeMessages.slice(0,point.raw),runtimeCheckpoints:Object.fromEntries(Object.entries(source.runtimeCheckpoints).filter(([,v])=>v.history<=point.history))},next.activeId);
    } else this.conversations.change(key,action,request);
    await this.resumeWorkspace({workspaceKey:key,revisionId:this.revisionId});return this.conversationState(key);
  }
  async resetWorkspace(){await this.interrupt();this.workspaceKey=null;this.threadId=null;this.conversationId=null;this.history=[];this.raw=[];this.checkpoints={};this.selection=null;this.transmission=null;}
  async invalidateRevision(){await this.interrupt();this.revisionId=null;this.emit('event',{type:'revision-changed'});return {invalidated:true};}
  setChangeMode(mode){if(this.snapshot().busy)throw new Error('请先停止当前回答');this.changeMode=mode;return this.snapshot();}
  answer(){throw new Error('当前没有等待回答的问题');}
  async stop(){await this.interrupt();this.status='stopped';this.emitStatus();}
  async interrupt(){this.cancelStarting=true;this.agent?.abort();if(this.preparing)await this.preparing;if(this.run)await this.run;return {interrupted:true};}
  async ask({question,context,workspaceKey,editMessageId=null,expectedTurnId=null}) {
    if(expectedTurnId!==null){
      if(!this.agent||!this.pending||expectedTurnId!==this.activeTurnId||workspaceKey!==this.workspaceKey||this.agent.signal?.aborted)throw new Error('回合已结束，请重新发送');
      const prepared=this.contextHost?.prepare(context);const user={role:'user',content:question+'\n\n'+JSON.stringify(this.contextHost?.additionalContext(prepared,{cwd:this.workDir})||{}),timestamp:Date.now(),vibeId:randomUUID()};
      this.steers.set(user.vibeId,{question,context:{...prepared?.frozenContext,turnContinuation:true},message:user});
      this.history.push({type:'user',id:user.vibeId,text:question,context:{...prepared?.frozenContext,turnContinuation:true}});
      this.emit('event',{type:'user-message',id:user.vibeId,text:question,context:{...prepared?.frozenContext,turnContinuation:true}});this.persist();this.agent.steer(user);return {threadId:this.threadId,turnId:this.activeTurnId};
    }
    if(this.snapshot().busy)throw new Error('请先等待或停止当前回答');
    if(!workspaceKey||!context?.folder)throw new Error('请先打开工作文件夹');
    if(this.workspaceKey!==workspaceKey||this.conversationId!==this.conversations.ensure(workspaceKey).id)await this.resumeWorkspace({workspaceKey,revisionId:context.revisionId});
    const provider=this.provider.resolve(this.selection),issue=configurationIssue(this.selection,provider,this.history.some(m=>m.type==='user'));
    if(issue)throw new Error(issue.message);
    if(!provider)throw new Error('请先添加模型服务');
    this.selection ||= selectionFor(provider);
    const config={...provider,...this.selection};
    this.starting=true;this.cancelStarting=false;this.preparing=new Promise(resolve=>{this.preparedDone=resolve;});this.emitStatus();
    let work;
    try {
      const {Agent}=await import('@earendil-works/pi-agent-core');
      const {createInitialSystemMessage,toToolDeclaration}=await import('@earendil-works/pi-ai');
      const api=await transport(config.api),fetch=await this.requestFetch(config);
      const prepared=this.contextHost?.prepare(context);
      work=await this.workspaceHost?.prepare(context.revisionId);
      await this.toolHost?.prepare({live:true});
      if(this.cancelStarting)throw new Error('已停止');
      if(editMessageId){const point=this.checkpoints[editMessageId];if(!point)throw new Error('这条消息没有可编辑的运行记录');this.raw=this.raw.slice(0,point.raw);this.history=this.history.slice(0,point.history);this.checkpoints=Object.fromEntries(Object.entries(this.checkpoints).filter(([,p])=>p.history<point.history));this.emit('event',{type:'history',messages:this.history});}
      this.threadId||='builtin-'+randomUUID();this.activeTurnId=randomUUID();this.revisionId=context.revisionId;
      const pending={threadId:this.threadId,turnId:this.activeTurnId,work,projectId:work?.projectId||context.projectId,revisionId:context.revisionId,observationId:context.displayedSimulation?.id||null};this.pending=pending;
      const current=()=>{if(this.pending!==pending||this.agent?.signal?.aborted)throw new Error('工具调用已停止或过期');};
      const tools=workspaceTools({root:this.workDir,runtimeRoot:this.runtimeRoot,assertCurrent:current});
      for(const tool of this.toolHost?.tools||[])tools.push({name:tool.name,label:this.toolHost.label(tool.name),description:tool.description,parameters:tool.inputSchema,
        execute:async(callId,args,signal)=>{current();signal?.throwIfAborted();const request={threadId:this.threadId,turnId:this.activeTurnId,callId,tool:tool.name,arguments:args};
          const scope={pending,assertCurrent:current,updateBinding:session=>{current();pending.projectId=session.workspace?.id;pending.revisionId=session.revision?.id;pending.observationId=null;this.revisionId=pending.revisionId;},emit:e=>this.emit('event',e)};
          try {const value=await this.toolHost.call(request,scope);current();const {publicResult,modelContentItems}=splitModelContent(value);
            return {content:[{type:'text',text:JSON.stringify(projectModelResult(publicResult))},...modelContentItems.map(i=>config.vision?{type:'image',data:i.imageData,mimeType:i.mimeType}:{type:'text',text:'工具返回了图片；当前模型服务未启用图片输入，不能声称已看图。'})],details:null};
          }catch(error){return {content:[{type:'text',text:JSON.stringify({error:this.toolHost.errorPayload(error,request,scope)})}],details:null,isError:true};}
        }});
      const instructions=DEVELOPER_INSTRUCTIONS.split(REFERENCE_PATH_TOKEN).join(referenceRoot).replace(/Tool result transport[\s\S]*?Running and historical state/,'Tool results contain JSON text and optional image blocks. Read them directly; no Code Mode wrapper is needed.\n\nRunning and historical state')+'\nRespond in the user language. Send concise progress messages before tool work. Use the provided tools directly. Shell cwd is /tmp/workspace; file tools use workspace-relative paths. Do not claim success without tool evidence.';
      if(this.raw[0]?.role==='system')this.raw=[createInitialSystemMessage(instructions,tools.map(toToolDeclaration)),...this.raw.slice(1)];
      const userId=randomUUID();this.checkpoints[userId]={raw:this.raw.length,history:this.history.length};
      this.history.push({type:'user',id:userId,text:question,context:prepared?.frozenContext});
      this.emit('event',{type:'user-message',id:userId,text:question,context:prepared?.frozenContext});
      this.transmission=null;
      this.history.push({type:'turn',id:this.activeTurnId,status:'running',startedAt:Date.now()});
      this.agent=new Agent({initialState:{model:modelFor(config),systemPrompt:instructions,messages:this.raw,tools,thinkingLevel:config.effort==='none'?'off':config.effort},
        toolExecution:'sequential',streamFn:this.streamFn||((model,ctx,opts)=>api.streamSimple(model,ctx,{...opts,apiKey:config.apiKey,fetch,maxTokens:8192,maxRetries:0})),
        prepareRequest:({context:requestContext})=>{if(JSON.stringify(requestContext).length>config.contextWindow*3)throw new Error('会话内容超过配置的上下文预算，请新建对话并携带工作笔记继续');}});
      this.agent.subscribe(e=>this.onAgentEvent(e));this.persist();
      this.status='busy';this.starting=false;this.emitStatus();this.emit('event',{type:'turn-started',turnId:this.activeTurnId});
      const prompt={role:'user',content:question+'\n\n<workspace_context>\n'+JSON.stringify(prepared?this.contextHost.additionalContext(prepared,{cwd:this.workDir,workspaceIndex:work?.workspaceIndex}):{})+'\n</workspace_context>',timestamp:Date.now()};
      this.run=this.runTurn(prompt,pending);
      this.preparedDone();this.preparing=null;
      return {threadId:this.threadId,turnId:this.activeTurnId,revisionId:this.revisionId};
    } catch(e){this.starting=false;this.pending=null;this.activeTurnId=null;try{if(work)await this.workspaceHost?.abort(work,{isCurrent:()=>true});}finally{this.status='ready';this.preparedDone();this.preparing=null;this.emitStatus();}throw e;}
  }
  onAgentEvent(e){
    const turnId=this.activeTurnId;
    if(e.type==='message_start'&&e.message.role==='assistant'){this.messageId=randomUUID();this.partialText='';this.lastPartialWrite=0;this.emit('event',{type:'assistant-started',itemId:this.messageId,turnId});}
    if(e.type==='message_update'){const delta=e.assistantMessageEvent;if(delta.type==='text_delta'){this.partialText+=delta.delta;let m=this.history.find(m=>m.id===this.messageId);if(!m){m={type:'assistant',id:this.messageId,text:'',phase:'commentary'};this.history.push(m);}m.text=this.partialText;if(Date.now()-this.lastPartialWrite>500){this.persist();this.lastPartialWrite=Date.now();}this.emit('event',{type:'assistant-delta',itemId:this.messageId,turnId,delta:delta.delta});}if(delta.type==='thinking_delta'){const id=this.messageId+':reasoning';let m=this.history.find(m=>m.id===id);if(!m){m={type:'reasoning',id,text:''};this.history.push(m);}m.text+=delta.delta;if(Date.now()-this.lastPartialWrite>500){this.persist();this.lastPartialWrite=Date.now();}this.emit('event',{type:'reasoning-delta',itemId:id,turnId,delta:delta.delta});}}
    if(e.type==='tool_execution_start'||e.type==='tool_execution_end'){
      const done=e.type==='tool_execution_end';
      const activity={type:'activity',id:turnId+':'+e.toolCallId,itemId:e.toolCallId,turnId,kind:'tool',label:({read_file:'读取文件',write_file:'写入文件',list_files:'列出文件',exec_command:'执行命令'}[e.toolName]||this.toolHost?.label(e.toolName)||e.toolName),activityKey:'tool:'+e.toolName,status:done?(e.isError?'failed':'completed'):'running',detail:(done?(e.result?.content||[]).map(c=>c.type==='text'?c.text:`[${c.mimeType||'image'}]`).join('\n'):JSON.stringify(e.args))?.slice(0,6000)};
      const existing=this.history.find(m=>m.type==='activity'&&m.id===activity.id);
      if(done&&existing?.input)activity.detail='参数：'+existing.input+'\n结果：'+activity.detail;
      if(!done)activity.input=activity.detail;
      if(existing)Object.assign(existing,activity);else this.history.push(activity);
      this.persist();this.emit('event',activity);
    }
    if(e.type==='turn_end'&&this.checkpoints[this.messageId]){this.checkpoints[this.messageId].raw=this.agent.state.messages.length;this.raw=this.agent.state.messages;this.persist();}
    if(e.type==='message_end'){
      if(e.message.role==='user'&&e.message.vibeId&&this.steers.has(e.message.vibeId)){this.checkpoints[e.message.vibeId]={raw:this.agent.state.messages.length-1,history:this.history.findIndex(m=>m.id===e.message.vibeId)};this.steers.delete(e.message.vibeId);}
      if(e.message.role==='assistant'){
        const thought=this.history.find(m=>m.id===this.messageId+':reasoning');if(thought)this.emit('event',{type:'assistant-completed',itemId:thought.id,turnId,text:thought.text,phase:'commentary'});
        const text=(e.message.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('');
        const phase=(e.message.content||[]).some(c=>c.type==='toolCall')?'commentary':'final';
        if(text){const existing=this.history.find(m=>m.id===this.messageId);if(existing)Object.assign(existing,{text,phase});else this.history.push({type:'assistant',id:this.messageId,text,phase});}
        this.emit('event',{type:'assistant-completed',itemId:this.messageId,turnId,text,phase});
        if(['error','aborted','length'].includes(e.message.stopReason))this.runError=e.message.errorMessage||(e.message.stopReason==='length'?'模型输出达到长度限制，任务尚未完成':'运行已停止');
        if(text)this.checkpoints[this.messageId]={history:this.history.length,raw:this.agent.state.messages.length};
      }
      this.raw=this.agent.state.messages;this.persist();
    }
  }
  async runTurn(prompt,pending){
    this.runError=null;let status='completed',error=null;
    try {await this.agent.prompt(prompt);if(this.agent.signal?.aborted)throw new Error('已停止');if(this.runError)throw new Error(this.runError);}
    catch(e){status=this.agent.signal?.aborted||this.cancelStarting?'interrupted':'failed';error=e.message;}
    finally {
      try {this.raw=[...this.agent.state.messages];for(const [id,s] of this.steers){this.checkpoints[id]={raw:this.raw.length,history:this.history.findIndex(m=>m.id===id)};this.raw.push(s.message);}this.steers.clear();this.persist();const outcome=await this.workspaceHost?.finish(pending.work,{apply:this.changeMode==='auto',completed:status==='completed',isCurrent:()=>this.pending===pending});const event=outcome&&this.workspaceHost.finishEvent(outcome);if(event)this.emit('event',event);}
      catch(e){status='failed';error='工作区刷新或会话保存失败：'+e.message;}
      this.agent.clearAllQueues();this.steers.clear();this.pending=null;this.activeTurnId=null;this.run=null;this.status='ready';
      const turn=this.history.find(m=>m.type==='turn'&&m.id===pending.turnId);
      if(turn)Object.assign(turn,{status,error,elapsedMs:Date.now()-turn.startedAt});
      for(const m of this.history)if(m.type==='activity'&&m.turnId===pending.turnId&&m.status==='running'){m.status='warning';m.resultStatus='unknown';m.detail=[m.detail,'调用未确认结束，结果未知。'].filter(Boolean).join('\n');this.emit('event',m);}
      try{this.persist();}catch(e){status='failed';error='会话保存失败：'+e.message;}
      if(error)this.transmission={phase:status==='interrupted'?'interrupted':'failed',message:error};
      this.emitStatus();this.emit('event',{type:'turn-completed',turnId:pending.turnId,status,error});
    }
  }
}
module.exports={BuiltinBackend,recoverTranscript};
