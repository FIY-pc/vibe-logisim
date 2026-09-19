import assert from 'node:assert/strict';
import {AgentOutputProjection} from '../circuit-lens/web/core/agent-output-projection.js';

const projection=new AgentOutputProjection();
projection.start();
projection.activity({id:'failed',label:'查看电路',status:'running',activityKey:'circuit:inspect_circuit'});
projection.activity({id:'failed',label:'查看电路',status:'failed',detail:'缺少输入',activityKey:'circuit:inspect_circuit'});
assert.equal(projection.summary(),'正在整理结果');
const retry=projection.activity({id:'retry',label:'查看电路',status:'completed',activityKey:'circuit:inspect_circuit'});
assert.equal(retry.priorFailed.id,'failed');
assert.equal(retry.priorFailed.recovered,true);
assert.equal(projection.unresolvedFailureCount(),0);
projection.finish('completed');
assert.match(projection.summary(),/已完成/);

projection.beginTurn();
projection.start();
projection.activity({id:'unresolved',label:'检查输入输出',status:'failed',activityKey:'circuit:simulate_circuit'});
projection.finish('completed');
assert.match(projection.summary(),/1 个步骤未完成/);

projection.beginTurn();
projection.start();
projection.activity({id:'new-turn',label:'生成回答',status:'completed',activityKey:'assistant:final'});
projection.finish('completed');
assert.equal(projection.unresolvedFailureCount(),0);
assert.match(projection.summary(),/1 个工作步骤/);
console.log('agent output projection checks passed');
