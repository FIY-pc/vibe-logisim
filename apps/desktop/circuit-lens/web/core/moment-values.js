// Runtime identity is separate from definition-local component IDs.
export const momentScope=m=>JSON.stringify([m.projectId,m.revisionId,m.circuit,m.instancePath]);
export const momentPlace=m=>[m.rootCircuit,...m.instancePath.map(p=>p.label)].join(' › ');
export const momentValue=s=>!s?'—':s.value==null?s.bits:`0x${s.value.toString(16).toUpperCase().padStart(Math.ceil(s.width/4),'0')}`;
export function momentRows(moments) {
  if(moments.length>1&&momentScope(moments[0])!==momentScope(moments[1]))return null;
  const keys=[...new Set(moments.flatMap(m=>m.signals.map(s=>s.key)))];
  return keys.map(key=>{
    const signals=moments.map(m=>m.signals.find(s=>s.key===key));
    return {signal:signals.find(Boolean),signals,changed:signals.length===2&&signals.every(Boolean)&&signals[0].bits!==signals[1].bits};
  });
}
