'use strict';

// Coordinates are disposable; port identity and connectivity are not. Families
// below express a placement relationship across banks, never an electrical join.
function orderBanks(groups, links) {
  const banks = groups.filter(g => g.layout === 'bank' && g.bankOrder !== 'given');
  const byGroup = new Map(groups.map(g => [g.id, g]));
  const nodes = new Map(banks.flatMap(g => g.children.map((n, i) =>
    [n.id, {node:n, group:g, index:i, parent:n.id}])));
  const nodeId = port => port.slice(0, port.lastIndexOf(':p'));
  function root(id) {
    const v = nodes.get(id);
    if (v.parent !== id) v.parent = root(v.parent);
    return v.parent;
  }
  const endpoint = (g, id) => {
    const n = g.children.find(n => n.id === nodeId(id));
    const p = n?.ports.find(p => p.id === id);
    return p && {node:n, port:p, y:n.y+p.y};
  };
  for (const e of links) {
    const a=nodeId(e.source), b=nodeId(e.target);
    if (nodes.has(a) && nodes.has(b) && e.sourceGroup !== e.targetGroup &&
        !e.distribution && e.directed) {
      const ra=root(a), rb=root(b);
      // A shared input must not collapse two lanes within one bank.
      const ga=new Set([...nodes.values()].filter(n=>root(n.node.id)===ra).map(n=>n.group.id));
      if (![...nodes.values()].some(n=>root(n.node.id)===rb && ga.has(n.group.id))) nodes.get(rb).parent=ra;
    }
  }
  const families=new Map();
  for (const [id,v] of nodes) {
    const key=root(id);
    if (!families.has(key)) families.set(key,{id:key,members:[],votes:[]});
    families.get(key).members.push(v);
  }
  for (const e of links) {
    if (e.distribution) continue;
    for (const [local,remote,remoteGroup] of [[e.source,e.target,e.targetGroup],[e.target,e.source,e.sourceGroup]]) {
      const v=nodes.get(nodeId(local)), g=byGroup.get(remoteGroup);
      if (!v || !g || g.layout==='bank' || g.role==='support') continue;
      const p=endpoint(g,remote); if (!p) continue;
      const weight=e.weight / Math.max(1,Math.abs(g.order-v.group.order));
      families.get(root(v.node.id)).votes.push([p.y/Math.max(1,g.height),weight]);
    }
  }
  const ordered=[...families.values()];
  for (const f of ordered) {
    const prior=f.members.reduce((s,v)=>s+(v.index+.5)/v.group.children.length,0)/f.members.length;
    const weight=f.votes.reduce((s,v)=>s+v[1],0);
    // The supplied order is a semantic prior. Port geometry refines it rather
    // than allowing one distant consumer to scatter an otherwise coherent bank.
    f.score=weight ? .65*prior+.35*f.votes.reduce((s,v)=>s+v[0]*v[1],0)/weight : prior;
    f.prior=prior;
  }
  ordered.sort((a,b)=>a.score-b.score || a.prior-b.prior || a.id.localeCompare(b.id));
  // Families keep their column in related banks. Missing fields compress away,
  // rather than making every smaller bank as tall as the largest one.
  const two=banks.filter(g=>g.columns===2).sort((a,b)=>b.children.length-a.children.length || a.order-b.order);
  const columns=new Map();
  for (const g of two) {
    const present=ordered.filter(f=>f.members.some(v=>v.group===g));
    const target=Math.ceil(present.length/2);
    let left=present.filter(f=>columns.get(f.id)===0).length;
    for (const f of present) if (!columns.has(f.id)) columns.set(f.id,left++<target?0:1);
  }
  const reports=[];
  for (const g of banks) {
    const previous=g.children.map(n=>n.id), arranged=[];
    for (const f of ordered) for (const v of f.members) if (v.group===g) {
      v.node.bankColumn=g.columns===2 ? columns.get(f.id) : 0;
      v.node.bankFamily=f.id;
      arranged.push(v.node);
    }
    g.children=arranged;
    reports.push({groupId:g.id,previousOrder:previous,order:arranged.map(n=>n.id),
      columns:arranged.map(n=>n.bankColumn),families:arranged.map(n=>n.bankFamily)});
  }
  return reports;
}

function placeBank(group, snap) {
  const columns=Math.max(1,Math.min(2,group.columns||1)), rows=Math.ceil(group.children.length/columns);
  const cols=Array.from({length:columns},()=>[]);
  group.children.forEach((n,i)=>cols[n.bankColumn ?? Math.floor(i/rows)].push(n));
  let x=20;
  for (let col=0;col<cols.length;col++) {
    const ns=cols[col]; if (!ns.length) continue;
    const reference=n=>n.ports.find(p=>p.direction==='output')?.x ?? n.width/2;
    const axis=Math.max(...ns.map(reference));
    let y=55;
    for (const n of ns) {n.bankColumn=col;n.x=snap(x+axis-reference(n));n.y=y;y=snap(y+n.height+25);}
    x=Math.max(...ns.map(n=>n.x+n.width))+60;
  }
  group.width=snap(Math.max(...group.children.map(n=>n.x+n.width))+20);
  group.height=snap(Math.max(...group.children.map(n=>n.y+n.height))+25);
}

module.exports={orderBanks,placeBank};
