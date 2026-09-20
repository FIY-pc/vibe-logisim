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
projection.activity({id:'unknown',label:'工作区检查',status:'warning',activityKey:'harness:verification'});
projection.finish('completed');
assert.equal(projection.unresolvedWarningCount(),1);
assert.match(projection.summary(),/1 个结果待确认/);

projection.beginTurn();
projection.start();
projection.activity({id:'new-turn',label:'生成回答',status:'completed',activityKey:'assistant:final'});
projection.finish('completed');
assert.equal(projection.unresolvedFailureCount(),0);
assert.match(projection.summary(),/1 个工作步骤/);
// A native mismatch is a completed measurement, not a tool invocation error.
// Later transport completion and another passing batch cannot erase it.
projection.beginTurn();
projection.start();
projection.activity({id:'batch-1',label:'检查输入输出',status:'running',activityKey:'circuit:simulate_circuit'});
projection.activity({id:'batch-1',label:'原生运行观察 · 有异常',status:'failed',activityKey:'harness:simulate',resultStatus:'failed'});
assert.equal(projection.activity({id:'batch-1',label:'检查输入输出',status:'completed',activityKey:'circuit:simulate_circuit'}),null);
projection.activity({id:'batch-2',label:'原生运行观察 · 通过',status:'completed',activityKey:'harness:simulate',resultStatus:'passed'});
assert.equal(projection.items.get('batch-1').recovered,false);
assert.equal(projection.items.get('batch-1').status,'failed');
projection.finish('completed');
assert.match(projection.summary(),/1 个运行结果不匹配/);
assert.equal(projection.unresolvedFailureCount(),0);

projection.beginTurn();
projection.activity({id:'floating',label:'原生运行观察 · 未确定',status:'warning',activityKey:'harness:simulate',resultStatus:'unknown'});
assert.equal(projection.activity({id:'floating',label:'检查输入输出',status:'completed',activityKey:'circuit:simulate_circuit'}),null);
projection.finish('completed');
assert.match(projection.summary(),/1 个结果待确认/);
assert.equal(projection.items.size,1,'one display row per call');
console.log('agent output projection checks passed');
