'use strict';
const fs=require('node:fs');
const ELK=require('elkjs/lib/elk.bundled.js');
const elk=new ELK(),snap=v=>Math.ceil(v/10)*10;
const {orderBanks,placeBank}=require('./bank-order.cjs');
const {packGroups}=require('./group-packing.cjs');
const {packStages}=require('./stage-packing.cjs');
function port(group,id){for(const n of group.children){const p=n.ports.find(p=>p.id===id);if(p)return {x:n.x+p.x,y:n.y+p.y,node:n,port:p};}return null;}
async function main(input){
 const groups=[];let attachedBuffers=0;
 for(const group of input.groups){
  let graph;
  if(!group.children.length){groups.push({...group,children:[],edges:[],width:200,height:80});continue;}
  if(group.layout==='bank'){
   graph={...group,children:structuredClone(group.children)};
   placeBank(graph,snap);
  }else graph=await elk.layout({id:group.id,children:structuredClone(group.children),edges:structuredClone(group.edges),layoutOptions:{
   'elk.algorithm':'layered','elk.direction':'RIGHT','elk.edgeRouting':'ORTHOGONAL','elk.randomSeed':'1',
   'elk.spacing.nodeNode':'25','elk.layered.spacing.nodeNodeBetweenLayers':'30',
   'elk.padding':'[top=55,left=20,bottom=25,right=20]',
   'elk.layered.considerModelOrder.strategy':'NODES_AND_EDGES','elk.separateConnectedComponents':'true','elk.aspectRatio':'1.5'}});
  // ELK projects ports onto the padded node border. Use the caller's
  // real inner-symbol offsets for attachment and inter-group alignment.
  for(const n of graph.children){const original=group.children.find(c=>c.id===n.id);for(const p of n.ports){const q=original.ports.find(v=>v.id===p.id);p.x=q.x;p.y=q.y;}}
  // Terminal buffers remain real components. Move the existing small symbol
  // toward its driver if its full reserved box still fits without overlap.
  for(const a of input.attachments.filter(a=>a.group===group.id)){
   const s=port(graph,a.source),t=port(graph,a.target);if(!s||!t)continue;
   if(s.port.x<s.node.width/2||t.port.x>t.node.width/2)continue;
   const x=snap(s.x+35-t.port.x),y=snap(s.y-t.port.y),n=t.node;
   if(x+t.port.x<=s.x+20)continue;
   if(graph.children.some(c=>c!==n&&c!==s.node&&x<c.x+c.width&&x+n.width>c.x&&y<c.y+c.height&&y+n.height>c.y))continue;
   n.x=x;n.y=y;attachedBuffers++;
  }
  graph.width=snap(Math.max(...graph.children.map(n=>n.x+n.width))+20);
  graph.height=snap(Math.max(...graph.children.map(n=>n.y+n.height))+25);
  groups.push({...group,...graph});
 }
 const bankOrdering=orderBanks(groups,input.links);
 for(const g of groups)if(g.layout==='bank'&&g.children.length)placeBank(g,snap);
 const packing=input.stages?.length?packStages(groups,input,snap):packGroups(groups,input,snap);
 return {groups,attachedBuffers,bankOrdering,...packing};
}
module.exports={layoutGroups:main};
if(require.main===module)main(JSON.parse(fs.readFileSync(0,'utf8'))).then(x=>process.stdout.write(JSON.stringify(x))).catch(e=>{console.error(e.stack||e);process.exitCode=1;});
