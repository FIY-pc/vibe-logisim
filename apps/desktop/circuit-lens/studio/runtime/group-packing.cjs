'use strict';

const median = values => {
  const sorted=values.slice().sort((a,b)=>a[0]-b[0]);
  const half=sorted.reduce((s,v)=>s+v[1],0)/2;
  let sum=0;
  for (const [v,w] of sorted) {sum+=w;if(sum>=half)return v;}
  return 0;
};
const port=(g,id)=>{
  for(const n of g.children){const p=n.ports.find(p=>p.id===id);if(p)return{x:n.x+p.x,y:n.y+p.y};}
  return null;
};

function splitRow(line, input) {
  const limit=input.maxRowWidth??3600;
  if(limit===0 || line.length<2) return [line];
  const index=new Map(line.map((g,i)=>[g.id,i])), cuts=Array(line.length).fill(0);
  // Count distinct connections, not every sink of a high-fanout control.
  for(const e of input.links){
    if(e.distribution || !index.has(e.sourceGroup) || !index.has(e.targetGroup))continue;
    const a=index.get(e.sourceGroup),b=index.get(e.targetGroup);
    for(let i=Math.min(a,b)+1;i<=Math.max(a,b);i++)cuts[i]+=e.weight;
  }
  // First minimize row count. Without this, a cheap cut can strand the first
  // or last stage on a nearly empty row just to improve the middle row.
  const count=Array(line.length+1).fill(Infinity);count[0]=0;
  const dp=Array(line.length+1).fill(Infinity),prev=Array(line.length+1);dp[0]=0;
  for(let end=1;end<=line.length;end++){
    let width=0,height=0;
    for(let start=end-1;start>=0;start--){
      width+=line[start].width+(start<end-1?input.groupGap:0);
      height=Math.max(height,line[start].height);
      if(width>limit && start<end-1)break; // An oversized single group is indivisible.
      const ragged=Math.max(0,1-width/limit);
      const cost=dp[start]+height+input.rowGap+limit*.08*ragged*ragged+cuts[start]*55;
      const rows=count[start]+1;
      if(rows<count[end] || (rows===count[end]&&cost<dp[end])){count[end]=rows;dp[end]=cost;prev[end]=start;}
    }
  }
  const rows=[];
  for(let end=line.length;end>0;){const start=prev[end];rows.unshift(line.slice(start,end));end=start;}
  return rows;
}

function packGroups(groups,input,snap){
  const by=new Map(groups.map(g=>[g.id,g]));
  const main=groups.filter(g=>g.role!=='support'),support=groups.filter(g=>g.role==='support');
  const logicalRows=[...new Set(main.map(g=>g.row))].sort((a,b)=>a-b);
  const rows=logicalRows.flatMap(r=>splitRow(main.filter(g=>g.row===r).sort((a,b)=>a.order-b.order),input));
  let y=0;
  for(let r=0;r<rows.length;r++){
    const line=rows[r],ids=new Set(line.map(g=>g.id));let x=0;
    for(const g of line){g.readingRow=g.row;g.row=r;g.x=x;g.y=0;x+=g.width+input.groupGap;}
    const links=input.links.filter(e=>!e.distribution&&ids.has(e.sourceGroup)&&ids.has(e.targetGroup));
    // Bidirectional port alignment: later blocks need not accumulate downward
    // offsets. Nearby stages have more influence than long feedback paths.
    for(let pass=0;pass<(input.alignTop?0:6);pass++)for(const g of (pass%2?line.slice().reverse():line)){
      const votes=[];
      for(const e of links){
        let other,local,remote;
        if(e.sourceGroup===g.id){other=by.get(e.targetGroup);local=port(g,e.source);remote=port(other,e.target);}
        else if(e.targetGroup===g.id){other=by.get(e.sourceGroup);local=port(g,e.target);remote=port(other,e.source);}
        if(local&&remote)votes.push([other.y+remote.y-local.y,e.weight/Math.max(1,Math.abs(g.order-other.order))**2]);
      }
      if(votes.length)g.y=snap(median(votes));
    }
    const top=Math.min(...line.map(g=>g.y));
    for(const g of line)g.y+=y-top;
    y=Math.max(...line.map(g=>g.y+g.height))+input.rowGap;
  }
  const intersects=(a,b)=>a.x<b.x+b.width+input.groupGap&&a.x+a.width+input.groupGap>b.x&&
    a.y<b.y+b.height+input.rowGap&&a.y+a.height+input.rowGap>b.y;
  const placed=main.slice(),attachments=[];
  // Support follows its strongest connected main group and may occupy a hole
  // below a short block. It never moves/splits a main group or invades its box.
  for(const g of support.sort((a,b)=>a.order-b.order)){
    const scores=new Map();
    for(const e of input.links){
      if(e.distribution)continue;
      const id=e.sourceGroup===g.id?e.targetGroup:e.targetGroup===g.id?e.sourceGroup:null;
      if(id&&by.get(id).role!=='support')scores.set(id,(scores.get(id)||0)+e.weight);
    }
    const owner=main.slice().sort((a,b)=>(scores.get(b.id)||0)-(scores.get(a.id)||0)||a.order-b.order)[0];
    if(!owner){g.x=0;g.y=y;g.readingRow=g.row;g.row=rows.length;placed.push(g);y+=g.height+input.rowGap;continue;}
    const maxWidth=Math.max(input.maxRowWidth||0,...main.map(n=>n.x+n.width),g.width);
    const xs=new Set([owner.x,owner.x+owner.width-g.width,0]);
    for(const n of placed){xs.add(n.x);xs.add(n.x+n.width+input.groupGap);}
    const candidates=[];
    for(const xx of xs){
      const x=snap(Math.max(0,Math.min(xx,maxWidth-g.width)));
      const ys=new Set([owner.y+owner.height+input.rowGap,...placed.map(n=>n.y+n.height+input.rowGap)]);
      for(const yy of ys){
        if(yy<owner.y)continue;
        const rect={x,y:snap(yy),width:g.width,height:g.height};
        if(placed.some(n=>intersects(rect,n)))continue;
        const growth=Math.max(0,rect.y+g.height-y+input.rowGap);
        const distance=Math.abs(x+g.width/2-owner.x-owner.width/2)+Math.abs(rect.y-owner.y-owner.height);
        candidates.push({rect,cost:growth*2+distance});
      }
    }
    candidates.sort((a,b)=>a.cost-b.cost||a.rect.y-b.rect.y||a.rect.x-b.rect.x);
    const best=candidates[0]?.rect||{x:owner.x,y};
    g.x=best.x;g.y=best.y;g.readingRow=g.row;g.row=rows.length+attachments.length;
    g.supportOf=owner.id;attachments.push({groupId:g.id,ownerGroupId:owner.id});placed.push(g);
    y=Math.max(y,g.y+g.height+input.rowGap);
  }
  const cutLinks=input.links.filter(e=>!e.distribution&&by.get(e.sourceGroup).role!=='support'&&
    by.get(e.targetGroup).role!=='support'&&by.get(e.sourceGroup).row!==by.get(e.targetGroup).row);
  return {rowWraps:Math.max(0,rows.length-logicalRows.length),rowCuts:rows.slice(1).map(r=>r[0].id),
    wrappedConnections:cutLinks.length,wrappedConnectionWeight:cutLinks.reduce((s,e)=>s+e.weight,0),supportAttachments:attachments};
}
module.exports={packGroups,splitRow};
