import {makeElement} from './dom.js';
import {icon,action,copyText} from './chat-dom.js';
import {renderMarkdown} from './chat-markdown.js';

// Owns message DOM, reading position and transient progress only. Transport,
// projects, draft submission and structural changes belong to other owners.
export class ConversationView {
  constructor(ui,{followReference,appendMoments,appendMaterials,edit,fork,notify}) {
    Object.assign(this,{ui,followReference,appendMoments,appendMaterials,edit,fork,notify});
    this.messages=new Map();this.activities=new Map();this.follow=true;
    this.frame=null;this.scrollTop=null;this.work=null;this.pending=new Set();
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
    this.messages.clear();this.activities.clear();this.pending.clear();this.work=null;this.follow=true;this.scrollTop=null;
    this.ui.conversationLatest.hidden=true;this.ui.agentTimeline.replaceChildren(this.ui.agentEmpty);this.ui.agentEmpty.hidden=false;
  }
  user(id,text,context) {
    this.follow=true;this.work=null;
    const message=this.create('user',id,text);
    if(context) {
      const path=context.simulationInstancePath?.map(p=>p.label)||[];
      const label=[context.circuit,...path,context.observationId?'运行时刻':null].filter(Boolean).join(' › ');
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
  updateWork(label) {this.group().querySelector('summary span').textContent=label;}
  activity(id,label,status='running',kind='tool') {
    if(!id)return;this.ui.agentEmpty.hidden=true;
    let node=this.activities.get(String(id));
    if(!node) {
      node=makeElement('div','agent-activity');node.append(makeElement('span','agent-activity-label'),makeElement('span','agent-activity-status'));
      this.group().append(node);this.activities.set(String(id),node);
    }
    node.dataset.status=status;
    const text=String(label||'正在处理').replace(/\s+/g,' ').trim();
    node.querySelector('.agent-activity-label').textContent=kind==='reasoning'?'分析电路与问题':text;
    node.querySelector('.agent-activity-status').textContent=status==='running'?'进行中':status==='failed'?'未完成':'完成';
    this.updateWork(status==='running'?(kind==='command'?'正在执行本地操作':kind==='reasoning'?'正在思考':text.slice(0,50)):'正在整理结果');
    this.scroll();
  }
  finish(status='completed') {
    for(const message of this.pending)this.render(message);this.pending.clear();
    this.ui.agentTimeline.querySelectorAll('.is-streaming').forEach(node=>{node.classList.remove('is-streaming');node.setAttribute('aria-busy','false');const m=this.messages.get(node.dataset.itemId);if(m)m.footer.hidden=m.phase==='commentary';});
    if(this.work){this.work.dataset.status=status;this.updateWork(status==='completed'?'查看工作过程':status==='interrupted'?'已停止 · 查看过程':'未完成 · 查看过程');}
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
  }
  setEditing(id) {
    const key=id == null ? null : String(id);
    for (const message of this.messages.values()) {
      message.node.classList.toggle('is-editing', key !== null && String(message.id) === key);
    }
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
