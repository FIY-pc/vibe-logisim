'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {orderBanks,placeBank}=require('../circuit-lens/studio/runtime/bank-order.cjs');
const {packGroups,splitRow}=require('../circuit-lens/studio/runtime/group-packing.cjs');
const {packStages}=require('../circuit-lens/studio/runtime/stage-packing.cjs');
const snap=x=>Math.ceil(x/10)*10;
const node=id=>({id,x:0,y:0,width:80,height:60,ports:[
  {id:id+':p0',x:60,y:30,direction:'output'},
  {id:id+':p1',x:20,y:30,direction:'input'}]});
const bank=(id,order,ids)=>({id,order,row:0,role:'main',layout:'bank',columns:2,children:ids.map(node),edges:[]});

test('connected fields retain relative order and column across differently ordered banks',()=>{
  const a=bank('a',0,['a0','a1','a2','a3']),b=bank('b',1,['b3','b1','b0','b2']);
  for(const g of [a,b])placeBank(g,snap);
  const links=[0,1,2,3].map(i=>({source:`a${i}:p0`,target:`b${i}:p1`,sourceGroup:'a',targetGroup:'b',directed:true,weight:3}));
  const report=orderBanks([a,b],links);for(const g of [a,b])placeBank(g,snap);
  assert.equal(report.length,2);
  assert.deepEqual(a.children.map(n=>n.id.slice(1)),b.children.map(n=>n.id.slice(1)));
  for(let i=0;i<4;i++)assert.equal(a.children.find(n=>n.id===`a${i}`).bankColumn,b.children.find(n=>n.id===`b${i}`).bankColumn);
  assert.equal(new Set(a.children.map(n=>n.id)).size,4);
});

test('explicit bank sequence and native port offsets remain unchanged',()=>{
  const a=bank('a',0,['a2','a0','a1']);a.bankOrder='given';
  const original=structuredClone(a.children.map(n=>n.ports));
  orderBanks([a],[]);placeBank(a,snap);
  assert.deepEqual(a.children.map(n=>n.id),['a2','a0','a1']);
  assert.deepEqual(a.children.map(n=>n.ports),original);
});

test('row break avoids a strongly coupled boundary and preserves reading order',()=>{
  const groups=['a','b','c','d'].map((id,order)=>({id,order,width:100,height:100}));
  const input={maxRowWidth:340,groupGap:20,rowGap:30,links:[{sourceGroup:'b',targetGroup:'c',weight:10}]};
  const rows=splitRow(groups,input);
  assert.equal(rows.length,2);
  assert.deepEqual(rows.flat().map(g=>g.id),['a','b','c','d']);
  assert.ok(rows.some(r=>r.some(g=>g.id==='b')&&r.some(g=>g.id==='c')));
  assert.ok(rows.every(r=>r.reduce((s,g)=>s+g.width,0)+20*(r.length-1)<=340));
  assert.equal(splitRow(groups,{...input,maxRowWidth:0}).length,1);
});

test('support occupies free space beside a tall group near its connected owner',()=>{
  const groups=[{...bank('tall',0,['t']),layout:'flow',width:200,height:800},
    {...bank('owner',1,['o']),layout:'flow',width:200,height:100},
    {...bank('support',2,['s']),layout:'flow',role:'support',row:1,width:200,height:100}];
  const input={maxRowWidth:500,groupGap:50,rowGap:50,links:[{source:'o:p0',target:'s:p1',sourceGroup:'owner',targetGroup:'support',weight:3}]};
  const result=packGroups(groups,input,snap),s=groups[2],o=groups[1];
  assert.equal(s.supportOf,'owner');assert.equal(s.x,o.x);
  assert.ok(s.y>=o.y+o.height+50);assert.ok(s.y+s.height<groups[0].height);
  assert.equal(result.supportAttachments.length,1);
});

test('stages place a wide side branch beside a tall bank without interrupting the backbone',()=>{
  const groups=[{...bank('logic',0,['a']),layout:'flow',width:200,height:120},
    {...bank('branch',1,['b']),layout:'flow',width:300,height:150,attachTo:'storage'},
    {...bank('storage',2,['c']),width:200,height:800},
    {...bank('output',3,['d']),layout:'flow',width:200,height:120}];
  const input={maxRowWidth:800,groupGap:50,rowGap:50,stages:[
    {id:'s1',label:'Preparation',groups:['logic','branch','storage'],mainPath:['logic','storage']},
    {id:'s2',label:'Result',groups:['output'],mainPath:['output']}],links:[
    {source:'a:p0',target:'c:p1',sourceGroup:'logic',targetGroup:'storage',weight:2},
    {source:'b:p0',target:'c:p1',sourceGroup:'branch',targetGroup:'storage',weight:2}]};
  const result=packStages(groups,input,snap),[a,b,c]=groups;
  assert.equal(a.x,b.x);assert.ok(c.x>=b.x+b.width+50);
  assert.ok(b.y>=a.y+a.height+50||a.y>=b.y+b.height+50);
  assert.ok(result.stageBoxes[0].height<1000);
  assert.ok(result.copperPairs.some(([x,y])=>x==='logic'&&y==='storage'));
  for(let i=0;i<groups.length;i++)for(const v of groups.slice(i+1)){
    const u=groups[i];assert.ok(u.x+u.width<=v.x||v.x+v.width<=u.x||u.y+u.height<=v.y||v.y+v.height<=u.y);
  }
  assert.throws(()=>packStages(structuredClone(groups),{...input,stages:[input.stages[0]]},snap),/cover every group/);
});

test('wrapped stages carry explicit continuation and never wire a reading jump',()=>{
  const groups=['a','b'].map((id,order)=>({...bank(id,order,[id]),layout:'flow',width:200,height:100}));
  const result=packStages(groups,{maxRowWidth:250,groupGap:50,rowGap:50,links:[],stages:
    groups.map(g=>({id:'stage-'+g.id,label:g.id,groups:[g.id],mainPath:[g.id]}))},snap);
  assert.match(result.stageBoxes[0].label,/接续 02/);assert.match(result.stageBoxes[1].label,/接续 01/);
  assert.equal(result.copperPairs.length,0);
});

test('a tall stage does not push the next reading row below its full height',()=>{
  const groups=[['a',200,100],['b',200,900],['c',200,100],['d',200,100]].map(([id,width,height],order)=>({...bank(id,order,[id]),layout:'flow',width,height}));
  const result=packStages(groups,{maxRowWidth:450,groupGap:50,rowGap:50,links:[],stages:
    groups.map(g=>({id:'s-'+g.id,label:g.id,groups:[g.id],mainPath:[g.id]}))},snap);
  const [a,b,c]=result.stageBoxes;
  assert.ok(c.y>=a.y+a.height+50);
  assert.ok(c.y+c.height<b.y+b.height);
  assert.ok(result.stageBoxes.every(s=>s.x+s.width<=450));
});

test('automatic stage width avoids a near-boundary singleton while explicit limits stay binding',()=>{
  const make=()=>[['a',1020,630],['b',2470,1640],['c',1250,1080],['d',1620,1060],['e',550,1240]]
    .map(([id,width,height],order)=>({...bank(id,order,[id]),layout:'flow',width,height}));
  const groups=make(),input={groupGap:100,rowGap:120,links:[],stages:groups.map(g=>({id:'s-'+g.id,label:g.id,groups:[g.id],mainPath:[g.id]}))};
  const auto=packStages(groups,input,snap);
  assert.ok(auto.autoStageWidth.selectedWidth>3600);
  const constrained=packStages(make(),{...input,maxRowWidth:3600},snap);
  assert.ok(constrained.stageBoxes.every(g=>g.x+g.width<=3600));
  assert.ok(Math.max(...auto.stageBoxes.map(g=>g.y+g.height))<Math.max(...constrained.stageBoxes.map(g=>g.y+g.height)));
});

test('later stages never jump above an earlier stage when filling an unused column',()=>{
  const groups=[['a',300,100],['b',300,1000],['c',250,100],['d',250,300],['e',150,100]]
    .map(([id,width,height],order)=>({...bank(id,order,[id]),layout:'flow',width,height}));
  const result=packStages(groups,{maxRowWidth:1000,groupGap:50,rowGap:50,links:[],stages:
    groups.map((g,i)=>({id:'s-'+g.id,label:g.id,row:i<2?0:1,groups:[g.id],mainPath:[g.id]}))},snap);
  for(let i=1;i<result.stageBoxes.length;i++){
    const a=result.stageBoxes[i-1],b=result.stageBoxes[i];
    assert.ok(b.y>=a.y,`${a.id} to ${b.id} jumps upward`);
    if(a.row===b.row)assert.ok(b.x>a.x);
  }
});
