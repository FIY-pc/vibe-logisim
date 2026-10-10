import assert from 'node:assert/strict';
import {AgentOutputProjection,summarizeActivities} from '../circuit-lens/web/core/agent-output-projection.js';

// The projection preserves transport identity and result state. Presentation
// (the two disclosure levels and their automatic closing) belongs to the view.
const projection=new AgentOutputProjection();
projection.start();
projection.activity({id:'failed',label:'查看电路',status:'running',activityKey:'circuit:inspect_circuit'});
projection.activity({id:'failed',label:'查看电路',status:'failed',detail:'缺少输入',activityKey:'circuit:inspect_circuit'});
const retry=projection.activity({id:'retry',label:'查看电路',status:'completed',activityKey:'circuit:inspect_circuit'});
assert.equal(retry.item.status,'completed');
assert.equal(projection.items.get('failed').status,'failed','a different call succeeding does not explain the earlier failure');
projection.finish('completed');
assert.equal(projection.status,'completed');
assert.equal(projection.items.size,2,'one state record per call');

projection.beginTurn();
projection.activity({id:'floating',label:'工作区检查',status:'warning',activityKey:'harness:verification',resultStatus:'unknown'});
assert.equal(projection.activity({id:'floating',label:'工作区检查',status:'completed',activityKey:'harness:verification'}),null);
assert.equal(projection.items.get('floating').resultStatus,'unknown');
const steps=[{label:'读取电路',status:'completed'},{label:'检查连线',status:'completed'},{label:'运行仿真',status:'running'}];
assert.equal(summarizeActivities(steps).label,'运行仿真');
steps[2].status='failed';assert.match(summarizeActivities(steps).alert,/运行仿真/);assert.equal(summarizeActivities(steps).status,'failed');
projection.beginTurn();projection.activity({id:'call',label:'读取',status:'completed'});
assert.equal(projection.activity({id:'call',label:'读取',status:'running'}),null,'late partial events cannot reopen a completed call');
console.log('agent output projection checks passed');
