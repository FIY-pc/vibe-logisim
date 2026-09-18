import {makeElement} from './dom.js';
import {icon,action,copyText} from './chat-dom.js';
import {renderMarkdown} from './chat-markdown.js';

// Owns message DOM, reading position and transient progress only. Transport,
// projects, draft submission and structural changes belong to other owners.
export class ConversationView {
  constructor(ui,{followReference,appendMoments,appendMaterials,edit,submitEdit,cancelEdit,fork,notify}) {
    Object.assign(this,{ui,followReference,appendMoments,appendMaterials,edit,submitEdit,cancelEdit,fork,notify});
    this.messages=new Map();this.activities=new Map();this.follow=true;
    this.frame=null;this.scrollTop=null;this.work=null;this.pending=new Set();this.editing=null;this.editingFollow=null;
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
    this.editing=null;this.editingFollow=null;this.messages.clear();this.activities.clear();this.pending.clear();this.work=null;this.follow=true;this.scrollTop=null;
    this.ui.conversationLatest.hidden=true;this.ui.agentTimeline.replaceChildren(this.ui.agentEmpty);this.ui.agentEmpty.hidden=false;
  }
  user(id,text,context) {
    this.follow=true;this.work=null;
    const message=this.create('user',id,text);
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
  create(role,id,text='') {
    this.ui.agentEmpty.hidden=true;
    const node=makeElement('article','agent-message');node.dataset.role=role;node.dataset.itemId=id;
    const header=makeElement('div','agent-message-header');header.append(makeElement('strong','',role==='user'?'你':'Codex'));
    const body=makeElement('div','agent-message-body');const footer=makeElement('div','message-actions');
    const message={node,body,footer,text,phase:null,id};
    const copy=action('复制消息','Copy',()=>copyText(message.text,copy,this.notify));
    footer.append(copy);
    if(role==='user') {
      const edit=action('编辑此问题','Pencil',()=>this.edit({id:message.id,text:message.text,node:message.node}));
      edit.classList.add('message-edit');edit.disabled=Boolean(this.busy);footer.append(edit);
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
    node.append(header,body,footer);this.ui.agentTimeline.append(node);
    this.messages.set(String(id),message);this.render(message);return message;
  }
  render(message) {
    if(message.node.dataset.role==='assistant')renderMarkdown(message.body,message.text,{followReference:this.followReference,notify:this.notify});
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
    if(m.phase==='commentary')this.group().append(m.node);
    m.node.classList.toggle('is-streaming',streaming);m.node.setAttribute('aria-busy',String(streaming));m.footer.hidden=streaming||m.phase==='commentary';
    if(streaming) {this.pending.add(m);this.scroll();}
    else {this.pending.delete(m);this.render(m);this.scroll();}
    return m;
  }
  group() {
    if(!this.work) {
      const node=makeElement('details','agent-work');
      const summary=makeElement('summary');summary.append(icon('ChevronRight'),makeElement('span','','工作过程'));
      node.append(summary);this.ui.agentTimeline.append(node);this.work=node;
    }
    return this.work;
  }
  start() {this.group().dataset.status='running';this.updateWork('正在思考');this.scroll();}
  updateWork(fallback=null) {
    const work=this.group(),summary=work.querySelector('summary span');
    const running=[...work.querySelectorAll('.agent-activity[data-status="running"]')].at(-1);
    if(running) {summary.textContent=`正在${running.querySelector('.agent-activity-label')?.textContent || '处理'}…`;return;}
    if(work.dataset.status==='running') {summary.textContent=fallback || '正在整理结果';return;}
    if(!work.dataset.status && fallback) {summary.textContent=fallback;return;}
    if(work.dataset.status==='completed') {
      const count=work.querySelectorAll('.agent-activity').length;
      const failed=work.querySelectorAll('.agent-activity[data-status="failed"]:not([data-recovered="true"])').length;
      if(failed) {summary.textContent=`回答完成 · ${failed} 个步骤未完成 · 查看工作过程`;return;}
      summary.textContent=count ? `已完成 · ${count} 个工作步骤 · 查看工作过程` : '已完成 · 查看工作过程';return;
    }
    if(work.dataset.status==='interrupted') {summary.textContent='已停止 · 查看工作过程';return;}
    summary.textContent='未完成 · 查看工作过程';
  }
  activity(id,label,status='running',kind='tool',detail=null,activityKey=null) {
    if(!id)return;this.ui.agentEmpty.hidden=true;
    let node=this.activities.get(String(id));
    const retryKey=String(activityKey||'');
    const priorFailed=status==='completed' && retryKey
      ? [...this.group().querySelectorAll('.agent-activity[data-status="failed"]')].find(item=>item!==node&&item.dataset.activityKey===retryKey)
      : null;
    if(!node) {
      node=makeElement('div','agent-activity');node.append(makeElement('span','agent-activity-label'),makeElement('span','agent-activity-status'));
      this.group().append(node);this.activities.set(String(id),node);
    }
    const previous=node.dataset.status;
    const recovered=previous==='failed' && status==='completed' && node.dataset.activityKey===retryKey;
    if(activityKey)node.dataset.activityKey=String(activityKey);
    node.dataset.status=status;
    if(recovered)node.dataset.recovered='true';
    if(priorFailed) {
      priorFailed.dataset.recovered='true';
      priorFailed.querySelector('.agent-activity-status').textContent='已恢复';
    }
    const text=String(label||'正在处理').replace(/\s+/g,' ').trim();
    node.querySelector('.agent-activity-label').textContent=kind==='reasoning'?'分析电路与问题':text;
    node.querySelector('.agent-activity-status').textContent=status==='running'?'进行中':status==='failed'?(recovered?'已恢复':'未完成'):'完成';
    if(detail) {
      node.title=String(detail);
      if(status==='failed') {
        let error=node.querySelector('.agent-activity-detail');
        if(!error){error=makeElement('small','agent-activity-detail');node.append(error);}
        error.textContent=String(detail);
      }
    }
    this.updateWork();
    this.scroll();
  }
  finish(status='completed') {
    for(const message of this.pending)this.render(message);this.pending.clear();
    this.ui.agentTimeline.querySelectorAll('.is-streaming').forEach(node=>{node.classList.remove('is-streaming');node.setAttribute('aria-busy','false');const m=this.messages.get(node.dataset.itemId);if(m)m.footer.hidden=m.phase==='commentary';});
    if(this.work){this.work.dataset.status=status;this.updateWork();}
    this.scroll();
  }
  system(text,kind='warning') {
    this.ui.agentEmpty.hidden=true;const node=makeElement('div','agent-system-message',text);node.dataset.kind=kind;this.ui.agentTimeline.append(node);this.scroll();return node;
  }
  history(messages) {
    this.clear();
    for(const m of messages) {
      if(m.type==='user')this.user(m.id,m.text,m.context);
      if(m.type==='assistant')this.assistant(m.id,m.text,m.phase);
    }
    if(this.work)this.updateWork('查看工作过程');this.scroll();
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
