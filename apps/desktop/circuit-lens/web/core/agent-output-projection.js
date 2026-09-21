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

  // A conversation can contain many turns. Keep the conversation history in
  // the DOM, but scope work-step counts and failures to the current turn.
  beginTurn() { this.clear(); }

  start() { this.status='running'; }

  activity({id,label,status='running',kind='tool',detail=null,activityKey=null,resultStatus=null}={}) {
    if(id==null || id==='')return null;
    const key=String(id);
    let item=this.items.get(key);
    // Transport completion says the tool returned, not that its observations
    // matched. Once present, keep that call's actual result on the same row.
    if(item?.resultStatus && !resultStatus)return null;
    if(!item) {
      item={id:key,label:'正在处理',status:'running',kind:'tool',detail:null,activityKey:null};
      this.items.set(key,item);this.order.push(key);
    }
    item.label=String(label||'正在处理').replace(/\s+/g,' ').trim();
    item.status=status;
    item.kind=kind||'tool';
    item.detail=detail==null?item.detail:String(detail);
    if(activityKey)item.activityKey=String(activityKey);
    if(resultStatus)item.resultStatus=resultStatus;
    return {item:{...item}};
  }

  finish(status='completed') { this.status=status; }

  runningItem() {
    for(let i=this.order.length-1;i>=0;i--) {
      const item=this.items.get(this.order[i]);
      if(item?.status==='running')return item;
    }
    return null;
  }

  failedCallCount() {
    return [...this.items.values()].filter(item=>!item.resultStatus&&item.status==='failed').length;
  }

  unresolvedWarningCount() {
    return [...this.items.values()].filter(item=>item.status==='warning').length;
  }

  summary(fallback=null) {
    const running=this.runningItem();
    if(this.status==='running')return running?`正在${running.label}…`:fallback||'正在整理结果';
    if(this.status==='completed') {
      const count=this.items.size,failed=this.failedCallCount(),warnings=this.unresolvedWarningCount();
      const mismatches=[...this.items.values()].filter(item=>item.resultStatus==='failed').length;
      if(mismatches)return `回答完成 · ${mismatches} 个运行结果不匹配 · 查看工作过程`;
      if(warnings)return `回答完成 · ${warnings} 个结果待确认 · 查看工作过程`;
      if(failed)return `回答完成 · 过程中 ${failed} 次调用失败 · 查看工作过程`;
      return count?`已完成 · ${count} 个工作步骤 · 查看工作过程`:'已完成 · 查看工作过程';
    }
    if(this.status==='interrupted')return '已停止 · 查看工作过程';
    if(this.status==='failed')return '未完成 · 查看工作过程';
    return fallback;
  }
}
