export const modelDependencies=['project'];
export const dependencies=['runningInstance','activateSimulationView','loadCircuit','selectComponent','selectWire','focusComponents','showToast'];

export function createController({models,ports}) {
  const {project}=models;
  let epoch=0;
  async function followCircuitReference(value) {
    const token=++epoch;
    try {
      const url=new URL(value);
      if(url.protocol!=='circuit:'||url.hostname!=='object')throw new Error('电路引用无效');
      const ref=Object.fromEntries(url.searchParams);
      const valid=()=>ref.projectId===project.session?.workspace?.id&&ref.revisionId===project.revision;
      if(!valid())throw new Error('电路已改变，这条引用属于此前版本；原观察仍可查看，请重新指认当前对象');
      if(!ref.circuit||(!ref.componentId&&!ref.wireId))throw new Error('电路引用缺少对象');
      const beforeNavigation=project.circuitRequestEpoch;
      if(ref.sessionId) {
        const instancePath=JSON.parse(ref.instancePath||'[]'),running=ports.runningInstance();
        if(!Array.isArray(instancePath)||instancePath.length>64)throw new Error('运行实例引用无效');
        if(running.session?.id===ref.sessionId) {
          if(JSON.stringify(running.view?.instancePath)!==JSON.stringify(instancePath)) {
            const view=await ports.activateSimulationView(instancePath);
            if(!view||token!==epoch||!valid()||beforeNavigation!==project.circuitRequestEpoch)return false;
            await ports.loadCircuit(ref.circuit,{navigation:{kind:'runtime-return',runtimeView:view}});
          }
        } else {
          await ports.loadCircuit(ref.circuit,{navigation:{kind:'definition'}});
          ports.showToast('已定位当前定义；原来的运行已结束，留存画面仍可查看');
        }
      } else if(project.circuitName!==ref.circuit)await ports.loadCircuit(ref.circuit);
      if(token!==epoch||!valid()||project.circuitName!==ref.circuit)return false;
      if(ref.componentId) {
        if(!project.circuit.components.some(c=>c.componentId===ref.componentId))throw new Error('引用的元件不存在');
        ports.selectComponent(ref.componentId);ports.focusComponents([ref.componentId]);
      } else {
        if(!project.circuit.wires.some(w=>w.wireId===ref.wireId))throw new Error('引用的导线不存在');
        ports.selectWire(ref.wireId);
      }
      return true;
    } catch(error){ports.showToast(error.message);return false;}
  }
  return Object.freeze({followCircuitReference});
}
