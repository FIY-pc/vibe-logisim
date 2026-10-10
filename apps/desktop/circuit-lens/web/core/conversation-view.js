import {makeElement} from './dom.js';
import {icon,action,copyText} from './chat-dom.js';
import {renderMarkdown} from './chat-markdown.js';
import {AgentOutputProjection,summarizeActivities} from './agent-output-projection.js';

// Owns message DOM, reading position and transient progress only. Transport,
// projects, draft submission and structural changes belong to other owners.
export class ConversationView {
  constructor(ui,{followReference,appendMoments,appendMaterials,edit,submitEdit,cancelEdit,fork,notify,referenceBinding=()=>null}) {
    Object.assign(this,{ui,followReference,appendMoments,appendMaterials,edit,submitEdit,cancelEdit,fork,notify,referenceBinding});
    // Keep live path versions across timeline rebuilds; history without a
    // recorded version must never adopt the current version of a reused path.
    this.referenceBindings=new Map();this.turnReferenceBinding=null;this.restoring=false;
    this.messages=new Map();this.activities=new Map();this.activityBatches=new Map();this.follow=true;
    this.output=new AgentOutputProjection();
    this.frame=null;this.scrollTop=null;this.work=null;this.toolBatch=null;this.lastContentKind='message';this.workStartedAt=0;this.workElapsedMs=0;this.workClock=null;this.pending=new Set();this.editing=null;this.editingFollow=null;
  }
  mount() {
    const {agentTimeline:node,conversationLatest:latest}=this.ui;
    const reading=()=>{if(node.scrollHeight>node.clientHeight){this.follow=false;this.scrollTop=null;latest.hidden=false;}};
    node.addEventListener('wheel',e=>{if(e.deltaY<0)reading();},{passive:true});
    node.addEventListener('keydown',e=>{if(['ArrowUp','PageUp','Home'].includes(e.key))reading();});
    node.addEventListener('scroll',()=>{
      if(this.scrollTop!==null&&Math.abs(node.scrollTop-this.scrollTop)<1)return;
      this.scrollTop=null;this.follow=node.scrollHeight-node.clientHeight-node.scrollTop<40;latest.hidden=this.follow;
    },{passive:true});
    new ResizeObserver(()=>this.scroll()).observe(node);
    latest.addEventListener('click',()=>{this.follow=true;this.scroll();});
  }
  clear() {
    this.turnReferenceBinding=null;this.activityBatches.clear();
    if(this.workClock)clearInterval(this.workClock);this.workClock=null;
    this.editing=null;this.editingFollow=null;this.messages.clear();this.activities.clear();this.pending.clear();this.output.clear();this.work=null;this.toolBatch=null;this.lastContentKind='message';this.workStartedAt=0;this.workElapsedMs=0;this.follow=true;this.scrollTop=null;
    this.ui.conversationLatest.hidden=true;this.ui.agentTimeline.replaceChildren(this.ui.agentEmpty);this.ui.agentEmpty.hidden=false;
  }
  user(id,text,context) {
    this.follow=true;if(!context?.turnContinuation)this.work=null;
    const binding=this.referenceBinding();
    const sameFolder=context?.folderId&&context.folderId===binding?.folderId;
    this.turnReferenceBinding={...binding,folderId:context?.folderId||null,projectId:context?.projectId,
      pathVersion:!this.restoring&&sameFolder?binding.pathVersion:null};
    const message=this.create('user',id,text,context);
    message.context=context;
    if(context) {
      const path=context.simulationInstancePath?.map(p=>p.label)||[];
      const showCircuit=context.circuit && (context.circuit!=='main'||path.length>0||context.observationId);
      const label=[showCircuit?context.circuit:null,...path,context.observationId?'运行时刻':null].filter(Boolean).join(' › ');
      if(label){const ref=makeElement('small','agent-message-context',label);ref.title=context.summary||'';message.node.append(ref);}
      this.appendMoments(message.node,context);
      this.appendMaterials(message.node,context);
    }
    this.scroll();return message;
  }
  delivery(id,state){
    const message=this.messages.get(String(id));if(!message)return;
    let receipt=message.node.querySelector('.message-delivery');
    if(!receipt){receipt=makeElement('small','message-delivery');receipt.setAttribute('role','status');message.node.insertBefore(receipt,message.footer);}
    receipt.textContent=({queued:'等待加入本轮',included:'已加入上下文',deferred:'待下次继续'}[state]||'');receipt.hidden=!receipt.textContent;
  }
  create(role,id,text='',context=null) {
    this.ui.agentEmpty.hidden=true;
    const node=makeElement('article','agent-message');node.dataset.role=role;node.dataset.itemId=id;
    node.setAttribute('aria-label',role==='user'?'你的消息':'助手回复');
    const body=makeElement('div','agent-message-body');const footer=makeElement('div','message-actions');
    const scope=this.turnReferenceBinding||{};
    const bindingKey=JSON.stringify([scope?.folderId,scope?.conversationId,role,id]);
    const binding=this.referenceBindings.get(bindingKey)||Object.freeze({...scope,pathVersion:this.restoring?null:scope?.pathVersion});
    if(binding.folderId){this.referenceBindings.set(bindingKey,binding);if(this.referenceBindings.size>1000)this.referenceBindings.delete(this.referenceBindings.keys().next().value);}
    const message={node,body,footer,text,phase:null,id,referenceBinding:binding};
    const copy=action('复制消息','Copy',()=>copyText(message.text,copy,this.notify));
    footer.append(copy);
    if(role==='user') {
      if(!context?.turnContinuation) {
        const edit=action('编辑此问题','Pencil',()=>this.edit({id:message.id,text:message.text,node:message.node}));
        edit.classList.add('message-edit');edit.disabled=Boolean(this.busy);footer.append(edit);
      }
    }
    else {
      const status=makeElement('small','message-branch-status');status.hidden=true;status.setAttribute('role','status');
      const branch=action('分支到新聊天','Split',async()=>{
        branch.disabled=true;branch.setAttribute('aria-busy','true');status.hidden=false;status.textContent='正在创建分支…';
        try {await this.fork(id);status.hidden=true;}
        catch(error){status.textContent=String(error.message||error).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,'');}
        finally{branch.disabled=this.busy;branch.removeAttribute('aria-busy');}
      });
      branch.classList.add('message-branch');branch.disabled=Boolean(this.busy);footer.append(branch,status);
    }
    node.append(body,footer);this.ui.agentTimeline.append(node);
    this.messages.set(String(id),message);this.render(message);return message;
  }
  render(message) {
    if(message.node.dataset.role==='assistant')renderMarkdown(message.body,message.text,{followReference:value=>this.followReference(value,message.referenceBinding),notify:this.notify});
    else message.body.textContent=message.text;
  }
  openEditor(id) {
    const message=this.messages.get(String(id));
    if(!message || message.node.dataset.role!=='user')return;
    if(this.editing && this.editing!==message)this.closeEditor(this.editing.id);
    if(message.editForm){message.editInput.focus();message.editInput.select();return;}
    this.editingFollow=this.follow;this.follow=false;this.scrollTop=null;
    this.editing=message;message.node.classList.add('is-editing');message.footer.hidden=true;
    const form=makeElement('form','message-edit-form');form.noValidate=true;
    const input=makeElement('textarea','message-edit-input');
    input.setAttribute('aria-label','编辑消息');input.setAttribute('placeholder','编辑消息');input.maxLength=4000;input.value=message.text;
    const actions=makeElement('div','message-edit-actions');
    const cancel=makeElement('button','message-edit-cancel','取消');cancel.type='button';
    const submit=makeElement('button','message-edit-submit','发送');submit.type='submit';
    actions.append(cancel,submit);form.append(input,actions);message.body.replaceChildren(form);
    message.editForm=form;message.editInput=input;message.editCancel=cancel;message.editSubmit=submit;message.editSubmitting=false;
    const resize=()=>{input.style.height='auto';input.style.height=`${Math.min(input.scrollHeight,240)}px`;};
    input.addEventListener('input',()=>{resize();this.updateEditControls(message);});
    input.addEventListener('keydown',event=>{
      if(event.isComposing||event.keyCode===229)return;
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancel.click();return;}
      if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();event.stopPropagation();form.requestSubmit();}
    });
    cancel.addEventListener('click',()=>{
      this.cancelEdit({id:message.id});
      message.footer.querySelector('.message-edit')?.focus({preventScroll:true});
    });
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      const text=input.value.trim();
      if(!text || this.busy || message.editSubmitting)return;
      message.editSubmitting=true;this.updateEditControls(message);
      try {await this.submitEdit({id:message.id,text,context:message.context});}
      catch(error){this.notify(`没有发送：${error.message||error}`);}
      finally {if(message.editForm){message.editSubmitting=false;this.updateEditControls(message);}}
    });
    requestAnimationFrame(()=>{
      if(this.editing!==message||!form.isConnected)return;
      resize();input.focus({preventScroll:true});input.setSelectionRange(input.value.length,input.value.length);
      form.scrollIntoView({block:'nearest'});
    });
    this.updateEditControls(message);
  }
  updateEditControls(message) {
    if(!message.editForm)return;
    const disabled=Boolean(this.busy||message.editSubmitting);
    message.editInput.disabled=disabled;message.editCancel.disabled=disabled;message.editSubmit.disabled=disabled||!message.editInput.value.trim();
    message.editSubmit.setAttribute('aria-busy',String(Boolean(message.editSubmitting)));
  }
  closeEditor(id) {
    const message=this.editing;
    if(!message || (id!=null && String(message.id)!==String(id)))return;
    message.editForm=null;message.editInput=null;message.editCancel=null;message.editSubmit=null;message.editSubmitting=false;
    message.node.classList.remove('is-editing');message.footer.hidden=false;this.editing=null;
    if(this.editingFollow!==null){this.follow=this.editingFollow;this.editingFollow=null;}
    this.render(message);this.scroll();
  }
  assistant(id,text='',phase=null,streaming=false,delta=false) {
    const key=String(id);let m=this.messages.get(key);
    if(!m)m=this.create('assistant',key,'');
    if(delta)m.text+=text;else if(text)m.text=text;
    m.phase=phase||m.phase;m.node.dataset.phase=m.phase||'';
    if(m.phase==='commentary') {
      this.breakToolBatch();
      const work=this.group();
      if(m.node.parentElement!==work)work.append(m.node);
    } else this.breakToolBatch();
    m.node.classList.toggle('is-streaming',streaming);m.node.setAttribute('aria-busy',String(streaming));m.footer.hidden=streaming||m.phase==='commentary';
    if(streaming) {this.pending.add(m);this.scroll();}
    else {this.pending.delete(m);this.render(m);this.scroll();}
    return m;
  }
  group() {
    if(!this.work) {
      const node=makeElement('details','agent-work');
      const summary=makeElement('summary');
      summary.append(icon('ChevronRight'),makeElement('span','agent-work-title'),makeElement('span','agent-work-alert'));
      node.append(summary);this.ui.agentTimeline.append(node);this.work=node;
    }
    return this.work;
  }
  start() {
    if(this.workClock)clearInterval(this.workClock);
    this.work=null;
    this.toolBatch=null;
    this.lastContentKind='message';
    this.activities.clear();
    this.activityBatches.clear();
    this.output.beginTurn();
    this.workStartedAt=Date.now();
    this.workElapsedMs=0;
    this.group().dataset.status='running';
    this.group().open=true;
    this.output.start();
    this.updateWork();
    this.workClock=setInterval(()=>this.updateWork(),1000);
    this.scroll();
  }
  formatDuration(ms) {
    const seconds=Math.max(0,Math.round(ms/1000));
    if(seconds<60)return `${seconds}s`;
    const minutes=Math.floor(seconds/60),rest=seconds%60;
    return `${minutes}m ${String(rest).padStart(2,'0')}s`;
  }
  updateWork() {
    if(!this.work)return;
    const title=this.work.querySelector('.agent-work-title');
    const status=this.work.dataset.status;
    const prefix=status==='interrupted'?'已中断 · ':status==='failed'?'未完成 · ':'';
    const summary=summarizeActivities([...this.output.items.values()]);
    const alert=this.work.querySelector('.agent-work-alert');
    if(alert){alert.hidden=!summary.alert;alert.textContent=summary.alert;}
    const active=status==='running'&&[...this.output.items.values()].some(i=>i.status==='running');
    if(title)title.textContent=prefix+(active?summary.label+' · ':'用时 ')+this.formatDuration(this.workElapsedMs || (this.workStartedAt?Date.now()-this.workStartedAt:0));
  }
  activity(id,label,status='running',kind='tool',detail=null,activityKey=null,resultStatus=null,toolOutput=null) {
    if(!id)return;this.ui.agentEmpty.hidden=true;
    const projected=this.output.activity({id,label,status,kind,detail,activityKey,resultStatus,toolOutput});
    if(!projected)return;
    if(status==='running'&&this.output.status!=='running') this.output.start();
    const work=this.group();
    if(status==='running') {
      work.dataset.status='running';
      if(!this.workStartedAt)this.workStartedAt=Date.now();
    }
    if(kind==='reasoning')return;
    let batch=this.activityBatches.get(String(id));
    if(!batch){
      if(this.toolBatch===null || this.lastContentKind!=='tool')this.toolBatch=this.createToolBatch(work);
      this.lastContentKind='tool';batch=this.toolBatch;this.activityBatches.set(String(id),batch);
    }
    let node=this.activities.get(String(id));
    if(!node) {
      node=makeElement('div','agent-activity');node.append(makeElement('span','agent-activity-label'),makeElement('span','agent-activity-status'));
      batch.body.append(node);this.activities.set(String(id),node);batch.ids.push(String(id));
    }
    const item=projected.item;
    node.dataset.status=item.status;
    if(item.resultStatus)node.dataset.resultStatus=item.resultStatus;
    if(item.activityKey)node.dataset.activityKey=item.activityKey;
    const text=item.label;
    node.querySelector('.agent-activity-label').textContent=item.kind==='reasoning'?'分析电路与问题':text;
    node.querySelector('.agent-activity-status').textContent=item.resultStatus==='unknown'?'结果未知':item.resultStatus==='failed'?'不匹配':item.status==='running'?'进行中':item.status==='warning'?'待确认':item.status==='failed'?'调用失败':'完成';
    if(item.toolOutput){
      let content=node.querySelector('.agent-tool-output');
      if(!content){content=makeElement('div','agent-tool-output');node.append(content);}
      const output=item.toolOutput;content.dataset.kind=output.type;content.replaceChildren();
      if(output.target)content.append(makeElement('code','agent-tool-target',output.target));
      if(output.input&&output.type!=='command'){
        const input={...output.input};if(output.type==='file')delete input.path;
        if(Object.keys(input).length)content.append(makeElement('pre','agent-tool-input',JSON.stringify(input,null,2)));
      }
      if(output.text)content.append(makeElement('pre','agent-activity-output',output.text));
      if(output.exitCode!=null&&output.exitCode!==0)content.append(makeElement('small','agent-tool-exit',`退出码 ${output.exitCode}`));
      if(output.truncated)content.append(makeElement('small','agent-tool-truncated','输出已截断'));
    }else if(item.detail) {
      let output=node.querySelector('.agent-activity-output');
      if(!output){output=makeElement('pre','agent-activity-output');node.append(output);}
      output.textContent=item.detail;
    }
    this.updateToolBatch(batch);
    this.updateWork();
    this.scroll();
  }
  createToolBatch(work) {
    const batch=makeElement('details','agent-tool-batch');
    const summary=makeElement('summary');
    summary.append(icon('ChevronRight'),makeElement('span','agent-tool-batch-label','工具调用'),makeElement('small','agent-tool-batch-meta'));
    const body=makeElement('div','agent-tool-batch-body');
    batch.append(summary,body);work.append(batch);
    batch.open=false;
    return {node:batch,body,label:summary.querySelector('.agent-tool-batch-label'),meta:summary.querySelector('.agent-tool-batch-meta'),ids:[]};
  }
  updateToolBatch(batch) {
    if(!batch)return;
    const summary=summarizeActivities(batch.ids.map(id=>this.output.items.get(id)).filter(Boolean));
    batch.label.textContent=summary.label;batch.meta.textContent=summary.meta;
    batch.meta.classList.toggle('has-unknown',Boolean(summary.alert));
    batch.node.dataset.status=summary.status;
  }
  breakToolBatch() {
    this.toolBatch=null;this.lastContentKind='message';
  }
  finish(status='completed') {
    for(const message of this.pending)this.render(message);this.pending.clear();
    this.ui.agentTimeline.querySelectorAll('.is-streaming').forEach(node=>{node.classList.remove('is-streaming');node.setAttribute('aria-busy','false');const m=this.messages.get(node.dataset.itemId);if(m)m.footer.hidden=m.phase==='commentary';});
    if(this.work){
      this.workElapsedMs=this.workStartedAt?Date.now()-this.workStartedAt:0;
      this.work.dataset.status=status;this.output.finish(status);this.updateWork();
      this.work.open=status!=='completed';
    }
    if(this.workClock)clearInterval(this.workClock);this.workClock=null;
    this.toolBatch=null;
    this.scroll();
  }
  system(text,kind='warning') {
    this.ui.agentEmpty.hidden=true;const node=makeElement('div','agent-system-message',text);node.dataset.kind=kind;this.ui.agentTimeline.append(node);this.scroll();return node;
  }
  history(messages) {
    this.clear();this.restoring=true;
    let turn=null;
    const settle=()=>{
      if(!this.work)return;
      const status=turn?.status==='running'?'interrupted':turn?.status||'completed';
      this.output.finish(status);this.work.dataset.status=status;this.work.open=status!=='completed';
      this.workElapsedMs=turn?.elapsedMs||0;this.workStartedAt=0;this.updateWork();
      if(turn?.error){const note=makeElement('small','agent-system-message',turn.error);this.work.append(note);}
    };
    for(const m of messages) {
      if(m.type==='user'){
        if(!m.context?.turnContinuation){settle();turn=null;this.toolBatch=null;this.activities.clear();this.activityBatches.clear();this.output.beginTurn();this.workStartedAt=0;this.workElapsedMs=0;}
        this.user(m.id,m.text,m.context);
        if(m.delivery)this.delivery(m.id,m.delivery);
      }
      if(m.type==='turn'){turn=m;this.group();}
      if(m.type==='assistant'||m.type==='reasoning')this.assistant(m.id,m.text,m.type==='reasoning'?'commentary':m.phase);
      if(m.type==='activity')this.activity(m.itemId||m.id,m.label,m.status==='running'?'warning':m.status,m.kind,m.detail,m.activityKey,m.resultStatus,m.toolOutput);
    }
    settle();this.restoring=false;this.scroll();
  }
  setBusy(value) {
    this.busy=value;
    this.ui.agentTimeline.querySelectorAll('.message-branch,.message-edit').forEach(button=>button.disabled=value);
    if(this.editing)this.updateEditControls(this.editing);
  }
  scroll() {
    if(this.frame!==null)return;
    this.frame=requestAnimationFrame(()=>{
      this.frame=null;for(const m of this.pending)this.render(m);this.pending.clear();
      if(this.follow){this.ui.agentTimeline.scrollTop=this.ui.agentTimeline.scrollHeight;this.scrollTop=this.ui.agentTimeline.scrollTop;}
      this.ui.conversationLatest.hidden=this.follow;
    });
  }
}
