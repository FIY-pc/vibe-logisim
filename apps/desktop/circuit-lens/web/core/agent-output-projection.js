// Keep the transport's item identity and result state together. The view owns
// the two disclosure levels; this object does not invent a third progress UI.
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

  displayLabel(label,kind) {
    const text=String(label||'正在处理').replace(/\s+/g,' ').trim();
    if(kind==='reasoning')return '分析电路与问题';
    // Some replay and older host events carry the raw shell command as the
    // label. Keep commands in the detail/title while the live status stays a
    // calm, human-readable phase name.
    if(kind==='command'&&/\b(?:python(?:3)?|node|npm|npx|java|javac|cargo|go|rg|grep|find|ls|cat|sed|awk|pwd|git)\b|[\\/]/i.test(text))return '执行本地操作';
    return text||'正在处理';
  }

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
    item.label=this.displayLabel(label,kind);
    item.status=status;
    item.kind=kind||'tool';
    item.detail=detail==null?item.detail:String(detail);
    if(activityKey)item.activityKey=String(activityKey);
    if(resultStatus)item.resultStatus=resultStatus;
    return {item:{...item}};
  }

  finish(status='completed') { this.status=status; }

}
