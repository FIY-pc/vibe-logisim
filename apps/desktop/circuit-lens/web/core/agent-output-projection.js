// The app-server protocol exposes many low-level items for one answer. This
// model compresses them into a user-facing work process before the DOM sees
// them. It deliberately owns no rendering, timing, or transport concerns.
export class AgentOutputProjection {
  constructor() { this.clear(); }

  clear() {
    this.status='idle';
    this.items=new Map();
    this.order=[];
  }

  start() { this.status='running'; }

  activity({id,label,status='running',kind='tool',detail=null,activityKey=null}={}) {
    if(id==null || id==='')return null;
    const key=String(id), retryKey=String(activityKey||'');
    let item=this.items.get(key);
    const priorFailed=status==='completed' && retryKey
      ? [...this.order].map(id=>this.items.get(id)).find(candidate=>candidate && candidate.id!==key
        && candidate.status==='failed' && candidate.activityKey===retryKey)
      : null;
    if(!item) {
      item={id:key,label:'正在处理',status:'running',kind:'tool',detail:null,activityKey:null,recovered:false};
      this.items.set(key,item);this.order.push(key);
    }
    const recovered=item.status==='failed' && status==='completed' && item.activityKey===retryKey;
    item.label=String(label||'正在处理').replace(/\s+/g,' ').trim();
    item.status=status;
    item.kind=kind||'tool';
    item.detail=detail==null?item.detail:String(detail);
    if(activityKey)item.activityKey=String(activityKey);
    if(recovered)item.recovered=true;
    if(priorFailed)priorFailed.recovered=true;
    return {item:{...item},priorFailed:priorFailed?{...priorFailed}:null};
  }

  finish(status='completed') { this.status=status; }

  runningItem() {
    for(let i=this.order.length-1;i>=0;i--) {
      const item=this.items.get(this.order[i]);
      if(item?.status==='running')return item;
    }
    return null;
  }

  unresolvedFailureCount() {
    return [...this.items.values()].filter(item=>item.status==='failed'&&!item.recovered).length;
  }

  summary(fallback=null) {
    const running=this.runningItem();
    if(this.status==='running')return running?`正在${running.label}…`:fallback||'正在整理结果';
    if(this.status==='completed') {
      const count=this.items.size,failed=this.unresolvedFailureCount();
      if(failed)return `回答完成 · ${failed} 个步骤未完成 · 查看工作过程`;
      return count?`已完成 · ${count} 个工作步骤 · 查看工作过程`:'已完成 · 查看工作过程';
    }
    if(this.status==='interrupted')return '已停止 · 查看工作过程';
    if(this.status==='failed')return '未完成 · 查看工作过程';
    return fallback;
  }
}
