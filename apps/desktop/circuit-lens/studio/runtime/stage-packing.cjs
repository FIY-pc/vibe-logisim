'use strict';
// Semantic stages are supplied by the caller. Only geometry is inferred here;
// a stage and a mainPath never add electrical connections or imply simulation.
const {packGroups,splitRow}=require('./group-packing.cjs');

function packStageRows(boxes,input,snap){
  const logical=[...new Set(boxes.map(g=>g.row))].sort((a,b)=>a-b);
  const rows=logical.flatMap(row=>splitRow(boxes.filter(g=>g.row===row),input));
  const count=Math.max(...rows.map(r=>r.length)),limit=input.maxRowWidth||Infinity;
  // A bounded beam assigns successive reading rows to ordered columns. Lower
  // stages can use the space under a short stage; a tall neighbor no longer
  // pushes the entire next row down. Full stage rectangles remain disjoint.
  let states=[{widths:Array(count).fill(0),heights:Array(count).fill(0),places:[],rowTop:0}];
  for(let row=0;row<rows.length;row++){
    states=states.map(s=>({...s,last:-1,floor:row?s.rowTop+input.rowGap:0,lastY:0,rowTop:0}));
    for(let n=0;n<rows[row].length;n++){
      const g=rows[row][n],next=[];
      for(const s of states)for(let column=s.last+1;column<count-(rows[row].length-n-1);column++){
        const widths=[...s.widths],heights=[...s.heights];widths[column]=Math.max(widths[column],g.width);
        const width=widths.reduce((a,b)=>a+b,0)+input.groupGap*(count-1);
        if(width>limit&&count>1)continue;
        // Reading proceeds right/down within a row. An unused column must
        // not bring a later stage back to the top of an earlier reading row.
        const y=Math.max(heights[column],s.floor,s.lastY);heights[column]=y+g.height+input.rowGap;
        next.push({widths,heights,places:[...s.places,{id:g.id,column,y,row}],last:column,
          floor:s.floor,lastY:y,rowTop:Math.max(s.rowTop,y),
          cost:width*Math.max(...heights)});
      }
      next.sort((a,b)=>a.cost-b.cost||a.last-b.last);
      states=next.slice(0,32);
      if(!states.length)return packGroups(boxes,{...input,alignTop:true},snap);
    }
  }
  const best=states[0],by=new Map(boxes.map(g=>[g.id,g]));
  for(const p of best.places){const g=by.get(p.id);g.x=snap(best.widths.slice(0,p.column).reduce((a,b)=>a+b,0)+p.column*input.groupGap);g.y=p.y;g.row=p.row;}
  const cuts=input.links.filter(e=>by.get(e.sourceGroup).row!==by.get(e.targetGroup).row);
  return {rowWraps:Math.max(0,rows.length-logical.length),rowCuts:rows.slice(1).map(r=>r[0].id),wrappedConnections:cuts.length,packing:'ordered-stage-columns'};
}

function packStagePage(boxes,input,snap){
  if(input.maxRowWidth!=null)return packStageRows(boxes,input,snap);
  const area=boxes.reduce((sum,b)=>sum+b.width*b.height,0),ideal=Math.sqrt(area*1.4);
  const minimum=Math.max(...boxes.map(b=>b.width)),maximum=boxes.reduce((sum,b)=>sum+b.width,0)+input.groupGap*(boxes.length-1);
  const widths=new Set([minimum]);
  for(const scale of [.85,1,1.2,1.45])widths.add(Math.max(minimum,Math.min(maximum,Math.ceil(ideal*scale/100)*100)));
  // Include the next complete-stage boundary near the area-based estimate.
  // A 20-unit shortfall must not strand an otherwise natural pair of stages.
  const boundaries=[];
  for(let a=0;a<boxes.length;a++)for(let b=a+1;b<=boxes.length;b++)boundaries.push(boxes.slice(a,b).reduce((s,g)=>s+g.width,0)+input.groupGap*(b-a-1));
  for(const w of [...widths]){
    const above=boundaries.filter(v=>v>=w).sort((a,b)=>a-b)[0];if(above!=null)widths.add(above);
  }
  const attempts=[];
  for(const width of [...widths].sort((a,b)=>a-b)){
    const placed=structuredClone(boxes),report=packStageRows(placed,{...input,maxRowWidth:width},snap);
    const w=Math.max(...placed.map(b=>b.x+b.width)),h=Math.max(...placed.map(b=>b.y+b.height));
    const cost=w*h*(1+.4*Math.abs(Math.log(w/h/1.4)));
    attempts.push({width,placed,report,extent:{width:w,height:h},cost});
  }
  attempts.sort((a,b)=>a.cost-b.cost||a.width-b.width);
  const best=attempts[0];
  for(let i=0;i<boxes.length;i++)Object.assign(boxes[i],best.placed[i]);
  return {...best.report,autoStageWidth:{selectedWidth:best.width,
    method:'whole-stage boundaries, area and aspect; geometric packing only',
    candidates:attempts.map(({width,extent,cost})=>({width,extent,cost:Math.round(cost)}))}};
}

function packStages(groups,input,snap){
  const by=new Map(groups.map(g=>[g.id,g])), stages=input.stages, seen=new Set(), ids=new Set();
  for(const s of stages){
    if(ids.has(s.id))throw new Error(`Duplicate stage: ${s.id}`);
    ids.add(s.id);
    if(!s.groups?.length||!s.mainPath?.length)throw new Error('Each stage needs groups and a mainPath');
    for(const id of s.groups){if(!by.has(id)||seen.has(id))throw new Error(`Unknown or repeated stage group: ${id}`);seen.add(id);}
    if(new Set(s.mainPath).size!==s.mainPath.length||s.mainPath.some(id=>!s.groups.includes(id)))throw new Error(`Invalid mainPath: ${s.id}`);
  }
  if(seen.size!==groups.length)throw new Error('Stages must cover every group exactly once');
  const boxes=[],joins=[],attachments=[];
  const groupStage=new Map(stages.flatMap(s=>s.groups.map(id=>[id,s.id])));
  for(const [index,s] of stages.entries()){
    const spine=s.mainPath.map(id=>by.get(id)), branches=s.groups.filter(id=>!s.mainPath.includes(id)).map(id=>by.get(id));
    const local=input.links.filter(e=>s.groups.includes(e.sourceGroup)&&s.groups.includes(e.targetGroup));
    const columns=spine.map(g=>({main:g,branches:[],width:g.width}));
    for(const b of branches){
      const scores=new Map(spine.map(g=>[g.id,0])), incoming=new Map(spine.map(g=>[g.id,0]));
      for(const e of local){
        if(e.sourceGroup===b.id&&scores.has(e.targetGroup)){scores.set(e.targetGroup,scores.get(e.targetGroup)+e.weight);incoming.set(e.targetGroup,incoming.get(e.targetGroup)+e.weight);}
        if(e.targetGroup===b.id&&scores.has(e.sourceGroup))scores.set(e.sourceGroup,scores.get(e.sourceGroup)+e.weight);
      }
      if(b.attachTo&&!scores.has(b.attachTo))throw new Error(`Branch attachTo must name a mainPath group in its stage: ${b.id}`);
      const owner=b.attachTo?by.get(b.attachTo):spine.slice().sort((a,c)=>scores.get(c.id)-scores.get(a.id)||a.order-c.order)[0];
      let column=spine.indexOf(owner);
      // A branch feeding a tall storage bank can share the preceding logic
      // column. Reserve its full width before placing the bank to its right.
      const feedsBank=owner.layout==='bank'&&column>0&&incoming.get(owner.id)>scores.get(owner.id)/2;
      if(feedsBank)column--;
      columns[column].branches.push(b);
      if(feedsBank)columns[column].width=Math.max(columns[column].width,b.width);
      b.supportOf=owner.id;b.stage=s.id;
      attachments.push({groupId:b.id,ownerGroupId:owner.id,stageId:s.id});
      if(scores.get(owner.id)>0)joins.push([owner.id,b.id,'branch']);
    }
    // Port alignment remains based on native offsets, even after a column is
    // widened for side branches. Preserve the original group footprint.
    const proxies=columns.map(c=>({...c.main,width:c.width,role:'main',row:0}));
    packGroups(proxies,{...input,stages:undefined,maxRowWidth:0,links:local.filter(e=>s.mainPath.includes(e.sourceGroup)&&s.mainPath.includes(e.targetGroup))},snap);
    for(let i=0;i<spine.length;i++){
      const g=spine[i],p=proxies[i];g.x=p.x;g.y=p.y;g.stage=s.id;
      if(i)joins.push([spine[i-1].id,g.id,'main']);
    }
    const placed=[...spine];
    for(const c of columns)for(const b of c.branches){
      const owner=by.get(b.supportOf),top=Math.min(...placed.map(g=>g.y)),bottom=Math.max(...placed.map(g=>g.y+g.height));
      const right=Math.max(...placed.map(g=>g.x+g.width));
      const xs=new Set([c.main.x,owner.x,0,...placed.flatMap(g=>[g.x,g.x+g.width+input.groupGap])]);
      const ys=new Set([0,...placed.flatMap(g=>[g.y+g.height+input.rowGap,g.y-b.height-input.rowGap])]);
      const candidates=[];
      for(const xx of xs)for(const yy of ys){
        if(yy<0)continue; // Branches never push the complete backbone downward.
        const rect={x:snap(xx),y:snap(yy),width:b.width,height:b.height};
        if(placed.some(g=>rect.x<g.x+g.width+input.groupGap&&rect.x+rect.width+input.groupGap>g.x&&rect.y<g.y+g.height+input.rowGap&&rect.y+rect.height+input.rowGap>g.y))continue;
        const width=Math.max(right,rect.x+b.width),height=Math.max(bottom,rect.y+b.height)-top;
        const growth=(width*height-right*(bottom-top))/Math.max(1,right);
        const distance=Math.abs(rect.y+b.height/2-owner.y-owner.height/2)+Math.abs(rect.x+b.width/2-owner.x-owner.width/2);
        candidates.push({...rect,cost:2*growth+.25*distance});
      }
      candidates.sort((a,b)=>a.cost-b.cost||a.y-b.y||a.x-b.x);
      if(!candidates.length)throw new Error(`No branch placement: ${b.id}`);
      Object.assign(b,{x:candidates[0].x,y:candidates[0].y});placed.push(b);
    }
    const top=Math.min(...placed.map(g=>g.y));
    for(const g of placed)g.y+=70-top;
    const width=Math.max(...placed.map(g=>g.x+g.width)),height=Math.max(...placed.map(g=>g.y+g.height))+20;
    const ports=placed.flatMap(g=>g.children.flatMap(n=>n.ports.map(p=>({...p,x:g.x+n.x+p.x,y:g.y+n.y+p.y}))));
    boxes.push({id:s.id,label:s.label,order:index,row:s.row??0,role:'main',width,height,children:[{id:`stage:${s.id}`,x:0,y:0,ports}],edges:[]});
  }
  const links=input.links.filter(e=>groupStage.get(e.sourceGroup)!==groupStage.get(e.targetGroup)).map(e=>({...e,sourceGroup:groupStage.get(e.sourceGroup),targetGroup:groupStage.get(e.targetGroup)}));
  const packing=packStagePage(boxes,{...input,stages:undefined,links},snap);
  const annotations=[];
  for(let i=0;i<stages.length;i++){
    const s=stages[i],box=boxes[i];
    const prior=i?boxes[i-1]:null,next=boxes[i+1];
    if(prior&&prior.row===box.row)joins.push([stages[i-1].mainPath.at(-1),s.mainPath[0],'main']);
    let label=`${String(i+1).padStart(2,'0')}  ${s.label}`;
    if(prior&&prior.row!==box.row)label+=`  ← 接续 ${String(i).padStart(2,'0')}`;
    if(next&&next.row!==box.row)label+=`  → 接续 ${String(i+2).padStart(2,'0')}`;
    annotations.push({id:s.id,label,x:box.x,y:box.y,width:box.width,height:box.height,mainPath:s.mainPath,row:box.row});
    for(const [j,id] of s.groups.entries()){
      const g=by.get(id);g.x+=box.x;g.y+=box.y;g.readingRow=g.row;g.row=box.row;g.heading=`${i+1}.${j+1}  ${g.label}`;
    }
  }
  return {...packing,stageBoxes:annotations,copperPairs:joins,supportAttachments:attachments,
    readingTransitions:boxes.slice(1).map((b,i)=>({from:boxes[i].id,to:b.id,
      kind:b.row===boxes[i].row?'forward':'continuation',
      fromTop:{x:boxes[i].x,y:boxes[i].y},toTop:{x:b.x,y:b.y}}))};
}
module.exports={packStages};
