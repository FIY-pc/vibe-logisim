# Harness 评测契约：如何知道电路真的 work

这份材料定义 Vibe Logisim 中“我观察到电路能工作”这句话最低需要什么证据。它是一个可复用的记录契约，不是强制工作流：可以先把电路完整构建好，再请求一次评测；也可以只观察结构、只运行一次实验，或把已有的外部测试接进来。用户和 AI 选择什么时候验证、验证哪一部分，harness 负责让结果可解释、可归属、不可被无意夸大。

这里的 `work` 总是带范围：它最多表示“在指定版本、运行环境、输入刺激和期望集合上，实际运行结果符合期望”。有限测试不能推出未覆盖行为，结构观察也不能替代功能运行。

## 最小契约

一次可被复核的评测材料至少包含五类事实：

1. **结构观察**：被测电路里有什么、端口如何连接、观察范围是否完整。
2. **运行观察**：实际加载哪个 artifact、使用哪个运行时、给了什么输入、读到了什么输出，以及传播是否稳定。
3. **期望比对**：每个被声称检查的样本有非空期望，实际值逐项比较，并保留缺失、未知和振荡。
4. **结论状态**：明确区分通过、确定反例、无法判定、只有观察和执行错误。
5. **身份**：把结论绑定到工程、revision、circuit、artifact、运行时和本次 stimulus。

最小记录可以采用下面的形状。字段名沿用当前插件结果；`expectation` 是调用者必须随结果保留的测试规格，当前运行报告有 `stimulusSha256`，但不能只凭它重建期望内容。

```json
{
  "target": {
    "projectId": "project-...",
    "revisionId": "...",
    "circuit": "main",
    "candidateId": null,
    "artifactSha256": "..."
  },
  "structure": {
    "authority": "native-loaded",
    "components": 12,
    "wireSegments": 18,
    "connectivityIssues": [],
    "unknowns": []
  },
  "run": {
    "id": "run-...",
    "mode": "simulate",
    "stimulus": {"vectors": [{"inputs": {"A": 0}, "expected": {"Y": 0}}]},
    "stimulusSha256": "...",
    "authority": "Logisim native propagation",
    "runtimeProfileId": "...",
    "runtimeJarSha256": "...",
    "runtimeVersion": "..."
  },
  "observation": {
    "rows": [{"inputs": {"A": 0}, "outputs": {"Y": 0}, "oscillating": false}]
  },
  "verdict": {
    "status": "passed",
    "scope": "1 个显式输入样本",
    "checkedCount": 1,
    "failureCount": 0,
    "unknownCount": 0,
    "firstFailure": null,
    "firstUnknown": null
  }
}
```

实际产品结果会以插件的 `binding`、`run`、`result`、`feedback` envelope 返回，而不是要求调用者手写上述 JSON。这个形状用于规定应当能从返回结果和调用方保存的期望中回答什么问题。

## 四种证据各自能说明什么

### 结构观察

`inspect_circuit` 可以提供组件、端口、导线、位网、层级实例和静态连接事实。`connectivity_feedback.py` 对完整 native nets 建立端点索引，并把无 peer、没有 output peer、未知端口和位宽冲突分开报告；它明确把这些标记为静态事实，不把方向元数据当成真正的驱动值。

结构观察能回答：

- 目标电路和元件是否被实际加载；
- 输入、输出和端口的名字、宽度、方向及连接范围是什么；
- 某些明显的孤立、未知或位宽冲突是否存在；
- 后续运行应使用哪些刺激入口和观察点。

结构观察不能回答：

- 对所有输入是否实现了目标逻辑；
- 时序电路是否在时钟、复位和程序刺激下按预期演化；
- 没有列出结构问题是否等于功能正确。

因此 `connectivityIssues: []` 是“当前结构观察没有发现这些静态问题”，不是 `passed`。当前实现见 [`connectivity_feedback.py`](../apps/desktop/circuit-lens/studio/domain/connectivity_feedback.py) 和 [`inspection.py`](../apps/desktop/circuit-lens/studio/application/inspection.py)。

### 运行观察

`harness_run`、`simulate_circuit` 和 `trace_circuit` 让 native Logisim 实际加载不可变 artifact，执行组合向量或时序事件，并返回每行输入、输出、位表示、tick、振荡和运行身份。运行输入、时钟和按钮是本次实验的 transient stimulus，不是结构修改或自动保存。

运行观察能回答：

- 这份具体 artifact 在这个具体运行时确实执行过；
- 对给定输入或事件，实际读到了什么输出；
- 结果是否稳定，是否存在未知位、缺失样本或振荡；
- 运行是否与当前 revision 和 artifact 对应。

没有期望时，运行只能形成 `observed`。它很有用，例如让 AI 看到当前状态、发现某个输出为 `x` 或观察时序过程，但它没有“正确答案”可以比较。`harness.py` 保留这条路径，并明确反馈“不规定下一步必须验证还是继续构建”。

### 期望比对

`evaluate_circuit` 是显式评测路径。组合模式要求每个向量有非空 `expected`；时序模式要求每个 `expectedRows` 指定非负 tick 和至少一个期望信号。比较发生在完整 native rows 上，不能用分页后看到的几行、工具调用完成、通过计数或模型自己的描述替代。

当前状态语义如下：

| 状态 | 可以说什么 | 不能说什么 |
| --- | --- | --- |
| `passed` | 本次列出的所有样本都稳定，且实际值逐项匹配期望 | 未覆盖输入、事件或观察点也正确 |
| `failed` | 至少一个实际执行且稳定的样本产生确定不匹配；应保留第一个反例 | 其他未运行样本也失败 |
| `unknown` | 运行存在未知位、缺失样本、缺失信号或振荡，当前无法判定全部期望 | 把未知当作 0、把独立输出碰巧匹配当作通过 |
| `observed` | 发生了真实运行观察，但没有足够完整的期望用于判定 | 这是一份通过证明 |
| `error` | 执行器、参数、身份或外部验证命令失败，结论没有形成 | 把工具失败解释成电路功能失败 |

`compare_sample` 和 `observation_feedback` 的实现位于 [`domain/evaluation.py`](../apps/desktop/circuit-lens/studio/domain/evaluation.py)。其中，振荡行即使某个无关输出数值碰巧匹配，也只能是 `unknown`；稳定反例优先使整体成为 `failed`。空断言在运行前拒绝，见 [`evaluation.py`](../apps/desktop/circuit-lens/studio/runtime/evaluation.py) 和 [`evaluation-integrity.py`](../apps/desktop/test/evaluation-integrity.py)。

外部测试也可以作为期望比对路径。工作区中的 `vibe-verification.json` 由 `run_verification` 发现并运行；harness 在一次性目录中提供精确 artifact、冻结依赖、目录、revision 和 SHA，`${source}` 也指向这份 disposable 输入，避免验证器直接写入用户源文件。结果保留清单 SHA 与规范化条目 SHA；输入包、清单或源文件在运行期间变化时只能是 `unknown`。结果同时区分 `execution=completed|timed-out|identity-changed|failed-to-start` 与 `verdict=passed|failed|unknown`，旧的 `feedback.status` 只作为兼容投影。超时会清理验证器的进程组。harness 接受命令退出码或 `status=passed|failed|unknown` 的 JSON，不解释脚本内部的领域语义。实现见 [`verification.py`](../apps/desktop/circuit-lens/studio/runtime/verification.py)。

### 身份与版本

结论必须能回答“是哪一份电路、用哪一个运行时、跑了什么输入”。当前插件的 binding 至少包含：

```text
schema
pluginId / pluginVersion
projectId
revisionId
circuit
candidateId
artifactSha256
runtimeProfileId
```

本次运行还应保留：

```text
run.id
stimulusSha256
authority
runtimeJarSha256
runtimeVersion
```

`binding_for` 和 `result_envelope` 是统一入口，见 [`domain/plugin.py`](../apps/desktop/circuit-lens/studio/domain/plugin.py)。native 执行返回实际加载的 runtime JAR、版本和 artifact 摘要，宿主会将它们与调用前的请求身份核对；摘要不一致就拒绝结果，见 [`runtime/native.py`](../apps/desktop/circuit-lens/studio/runtime/native.py)。

`threadId`、`turnId` 和 `callId` 只用于把异步结果归属到正确的 Agent 回合，不能增加电路正确性的可信度。`revisionId`、`artifactSha256` 和 `runtimeJarSha256` 也只说明“结果来自哪里”，不说明测试规格是否充分。

## 评测结论的最小判定规则

当 AI 需要回答“这个电路真的 work 吗”时，可以把结论压缩成下面的规则：

```text
能声称“在已声明范围内通过”
  = 实际执行成功
  + artifact/revision/runtime/stimulus 身份完整且相互一致
  + 每个声称检查的样本都有非空期望
  + 所有这些样本稳定并逐项匹配
  + 没有被隐藏在分页、截断或未返回行中的 failure/unknown
```

否则：

- 有确定反例，结论是 `failed`；
- 有未知、振荡、缺失样本或覆盖不完整，结论是 `unknown` 或 `observed`；
- 没有可归属的实际执行，不能声称电路已经运行；
- 工具或运行时出错，保留 `error` 及错误细节，等待修复或重新执行。

“通过”仍只对 `scope` 有效。若目标是一个外部课程测试集，必须把测试集本身的覆盖范围、生成方式和独立 oracle 一并保留；仅有 `passed=1024` 这样的计数不足以证明输入没有重复、期望没有写错、所有批次属于同一 artifact，或测试集覆盖了目标要求。

## 复用时的最小材料包

任何电路项目都可以用同一个材料包，而不需要插件知道“全加器”“RISC-V”或其他领域名称：

```text
evaluation/
  target.json       # project/revision/circuit/candidate/artifact 身份
  structure.json    # inspect_circuit 的结构事实和 unknowns
  stimulus.json     # 实际输入、事件、观察点；或外部 oracle 的入口
  expected.json     # 显式期望及其覆盖说明
  observation.json  # 完整运行 rows、稳定性和 runtime 身份
  verdict.json      # passed/failed/unknown/observed/error、原因和范围
```

这些文件可以在构建完成后一次性生成，也可以由多次局部观察组成；契约不要求模型先查组件、先做结构检查或每次修改都评测。关键是最终要能把 `expected`、`observation` 和 `verdict` 连接回同一个 `target`，并保留第一条确定反例或第一条未知原因。

## 为什么这是通用 harness 能力

这套边界不依赖课设特化：

- 结构层只处理组件、端口、位网和层级，不知道目标逻辑名称；
- 运行层只处理 artifact、stimulus、native output、tick 和稳定性，不知道输出应该是什么；
- 比对层只要求调用者提供输入与期望，可以是人工样例、自动生成向量、时序轨迹或外部脚本；
- 身份层绑定文件版本和运行时，适用于直接编辑 `.circ`、候选 artifact、脚本生成文件和其他兼容 Logisim 的任务；
- 外部 oracle 由工作区拥有，harness 只 materialize 精确 artifact 并转发状态，不把某门课的测试语义写进产品。

因此课设是一个硬场景和真实压力测试，而不是契约的定义。全加器、课程 CPU 或任意新电路都只是在 `stimulus` 与 `expected` 中提供不同领域内容，证据分类和身份边界保持不变。

## 当前证据边界

- [008 原生仿真反馈实验](../experiments/008-native-verification/SIMULATION-FEEDBACK.md) 证明反馈必须在完整 native rows 汇总后生成；采样或分页不能把未返回的未知/反例藏掉，历史记录也不应被倒改。
- [020 返回契约实验](../experiments/020-result-contract/README.md) 证明完整覆盖需要核对生成代码、批次输入、实际 batch SHA 和独立 oracle；模型声称跑过多少次不是覆盖证明。
- [021 仿真运行时调查](../experiments/021-simulation-runtime/README.md) 证明 runtime 生命周期和 artifact 隔离本身也是证据边界：复用可变 `LogisimFile` 会造成 ROM stimulus 污染，因此性能优化不能牺牲“这次输出来自哪份状态”的可归属性。
- [`docs/harness.md`](harness.md) 记录基础 Codex harness、Circuit Plugin、可选评测和直接编辑之间的职责边界；本契约把其中分散的证据规则收敛成可复核的最小材料。

这些证据证明的是契约和当前实现的边界，不证明任意模型能自动设计充分测试，也不证明有限一次评测等于完整任务验收。要宣称更强的结论，必须增加对应覆盖证据或独立 oracle，而不是扩大 `passed` 文案的含义。
