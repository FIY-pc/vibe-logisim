# 面向模型的 Harness 与电路插件

Vibe Logisim 使用 Codex 作为基础 Agent Harness，并通过 Circuit Plugin 把电路领域能力接入 Codex。两者服务不同的边界。

```text
桌面宿主
  ├─ 文件夹、会话、当前电路、修订和 UI 事件
  └─ Codex Base Harness
       ├─ thread / turn / history
       ├─ cwd / workspace / 文件与 shell
       ├─ sandbox / permission / approval
       ├─ tool registry / dispatch / event stream
       └─ model loop
            └─ Circuit Plugin
                 ├─ context provider
                 ├─ observation
                 ├─ construction and mutation
                 ├─ native execution
                 └─ optional evaluation
```

Codex 基础 Harness 决定模型如何持续工作。它拥有回合、工作目录、上下文、工具调用、权限、事件流和历史等生命周期。电路插件不创建第二套 thread、turn、审批或模型循环，它只提供模型在电路世界中的可调用能力。

### Native Codex connection

开发环境的 Codex 连接以启动时的本机 `CODEX_HOME/config.toml` 为默认配置。宿主只建立隔离的运行 profile，并镜像 provider、当前模型、思考深度和 `model_catalog_json` 指向的本地 catalog；认证仍沿用本机登录状态，不复制另一份轮换凭据。这样隔离的是运行目录和工作目录，配置语义仍来自本机 Codex。

模型列表始终从同一个 app-server 的 `model/list` 读取。Vibe Logisim 保存的模型选择只是当前应用的可选覆盖，必须同时通过该 catalog 的模型 ID 和 supported reasoning efforts 校验后才能进入 `thread/start` 或 `turn/start`。失效的旧选择会被清除并回到本机配置；没有应用覆盖时不自行挑选 catalog 默认模型。界面中的“轻度 / 中 / 高 / 极高 / 最高 / Ultra”只是 native effort ID 的显示翻译，选项集合和可用深度由 catalog 决定。

模型目录读取失败会保留为连接级 `modelCatalog` 状态；`turn/start` 明确返回模型不存在或无权使用时，会变成 `MODEL_UNAVAILABLE`，停止对同一模型的无意义重试，并保留会话、草稿和工作区。用户可以在模型列表中刷新或选择当前 catalog 中的模型。认证、目录暂时不可用和模型不可用分别保留不同错误码，不会伪装成普通“正在思考”。

对话操作也沿用原生线程边界。复制只读取可见文本；编辑在原消息内展开独立编辑器，发送时使用 `thread/revert` 截断目标用户回合及其后的持久化历史，再提交新回合，底部未发送草稿不被替换。该协议明确只改变对话历史，不撤销 Codex 已写入工作区的文件；宿主随后重新读取线程并同步本地消息缓存，保证“编辑问题”和“回退消息”不是两个互相矛盾的 UI 动作。

插件能力是用户驱动的。模型可以直接编辑工作目录中的 `.circ` 文件，之后请求观察；也可以使用候选构建工具；可以先完成整张电路再运行实验。插件提供可靠动作和证据，不规定动作顺序。

选区是协作焦点，不是每次提问都必须存在的前置条件。用户直接询问当前电路而没有选中对象时，宿主只绑定当前工作区、revision 和当前电路名称，让 Codex 自己通过工作区和 `inspect_circuit` 按需观察；不会为了填充上下文而伪造覆盖整张画布的选区。用户明确选中元件、导线或空间区域时，宿主才冻结 selection 并请求精确的 native 观察。这样大电路的普通问题不会在模型收到问题之前等待一次与用户意图无关的全图观测，同时保留局部问题需要的可追溯证据。

## 插件契约

插件的唯一目录位于 `studio/domain/circuit-plugin.json`。Studio 的可执行注册位于 `studio.application.circuit_plugin.CircuitPlugin`；Electron 通过 `electron/circuit-tools.cjs` 加载并校验同一份目录，再由 `electron/circuit-plugin.cjs` 负责宿主执行器、串行调用和失效检查。没有第二份手写工具清单：目录描述协议，两个运行时分别验证自己拥有的执行边界。两侧保持相同的插件 ID、版本和能力名称：

| 字段 | 作用 |
| --- | --- |
| `schema` | 插件或结果协议版本 |
| `id` / `version` | 能力来源和兼容边界 |
| `capabilities` | 能力名称、类别、是否写源文件、是否产生候选 |
| `availability` | 当前工作区、native runtime 和源文件状态 |
| `tools` / `hostTools` | Studio 可执行工具和由 Electron 工作区宿主执行的工具 |
| `binding` | 工程、修订、电路、候选、artifact 和运行时 profile 身份 |
| `run` | 本次执行的 ID、类型、状态、authority 和 stimulus 摘要 |
| `result` | 原始观察或运行报告 |
| `feedback` | 有明确期望时的比较结果，没有期望时保持 `observed` |

当前能力类别包括：

- `context`：打开电路并建立共享画布绑定。
- `observe`：读取结构、冻结观察、组合仿真和时序 trace。
- `construct`：构建候选或把工作目录中的直接编辑载入候选。
- `mutate`：把候选写回用户选择的源文件。
- `evaluate`：运行用户主动请求的实验，并在存在可比较期望时返回判断。

`harness_run` 的反馈状态只有在每一行都有明确期望、且全部匹配时才是 `passed`；存在不匹配时是 `failed`；没有完整比较条件时是 `observed`。这个状态描述本次实验，不推动模型进入下一步。

`inspect_circuit` 在精确运行时观察到端口后，还会返回 `connectivityIssues`：其中 `unconnectedInputs` 列出没有位网的输入端及其原生 tooltip，`widthIncompatibilities` 保留运行时报告的宽度冲突点。这是观察摘要，不替模型决定哪些端口应该连接；它把模型原本需要从大量端口和 net ID 中手工归纳的事实直接暴露出来。

`evaluate_circuit` 是独立的评测能力。组合模式要求每个输入向量带 `expected`；时序模式要求 `expectedRows`，每行指定 tick 和观察信号。它返回 `evaluation` 对象并保留底层 native observation：`passed` 表示规格覆盖的案例全部匹配，`failed` 表示至少一个明确不匹配，`unknown` 表示运行结果中有未确定信号或缺失样本。

### 工具失败反馈

工具失败使用 `vibe-logisim.circuit-plugin.error/v1`，错误对象至少包含：

```json
{
  "code": "UNKNOWN_INPUT",
  "message": "找不到输入引脚 Cin。",
  "retryable": false,
  "hint": "使用 availableInputs 中的标签；组件 ID 不是输入名。",
  "availableInputs": ["A", "B"]
}
```

`retryable` 表示原参数不变时是否适合直接重试；参数错误、未知输入和过期修订通常为 `false`，模型应先根据 `hint`、`context` 或 `availableInputs` 修正调用。错误从 Studio 生成，经 HTTP 和 Electron 透传到 Codex 工具结果，不由 UI 改写成成功，也不要求用户进入固定验证流程。

## 身份与证据

每次 native 仿真至少绑定：

```json
{
  "projectId": "project-...",
  "revisionId": "...64 hex...",
  "circuit": "main",
  "candidateId": null,
  "artifactSha256": "...",
  "runtimeProfileId": "..."
}
```

工具调用本身还带有 `threadId`、`turnId` 和 `callId`。它们用于宿主在异步 native 操作返回时判断结果是否仍属于原回合；它们不是电路正确性的额外结论。

运行报告还记录 `runId`、`stimulusSha256`、开始时间、耗时和 authority。候选运行使用候选 artifact 的真实 hash，不能回退到基础工作区 hash。仿真输入、时钟和按钮事件仍属于本次运行的 transient stimulus，不写入电路结构。

## 当前实现边界

- Codex thread/turn 与工作区文件能力由 [`codex-backend.cjs`](../apps/desktop/electron/codex-backend.cjs) 负责。
- 插件的模型可见协议规格和暴露策略由 [`circuit-plugin.json`](../apps/desktop/circuit-lens/studio/domain/circuit-plugin.json) 声明，由 [`circuit-tools.cjs`](../apps/desktop/electron/circuit-tools.cjs) 校验和投影；[`circuit-plugin.cjs`](../apps/desktop/electron/circuit-plugin.cjs) 只执行宿主工具并串行化共享画布操作。调用执行会带着 `threadId`、`turnId` 和 `callId` 穿过宿主边界。
- Studio 的可执行插件注册和调用身份由 [`circuit_plugin.py`](../apps/desktop/circuit-lens/studio/application/circuit_plugin.py) 负责；`Workbench` 不再用一个按字符串展开的总分派器。目录中的 `import_candidate` 是隐藏的 Studio 内部能力，供候选生命周期测试使用，不会进入 Codex 的动态工具列表；模型看到的 `submit_circuit` 只刷新用户正在编辑的实际 `.circ` 文件。
- 真实 Logisim 仿真和 trace 由 [`harness.py`](../apps/desktop/circuit-lens/studio/runtime/harness.py) 的 `NativeCircuitRuntime` 调用 native runtime 完成；显式规格比较由 [`evaluation.py`](../apps/desktop/circuit-lens/studio/runtime/evaluation.py) 独立完成。
- 插件描述通过 `/api/agent/plugin` 暴露，桌面宿主在发送上下文时将其作为 application context 注入模型绑定。

`NativeCircuitRuntime` 是电路插件中的原生执行能力，不是整个 Agent Harness。真正的 Base Harness 仍然是 Codex backend 及其 thread/turn、上下文、工具调用、权限、事件流和停止恢复边界。以后增加课程测试集、时序断言或其他领域能力时，优先注册新的插件 executor 或扩展独立 evaluator，保持 Codex 的代理生命周期不变。

一次调用的最小身份链是：

```text
Codex dynamic tool call
  -> Electron admission + circuit operation queue
  -> /api/agent/tool
  -> CircuitInvocation(project, revision, thread, turn, call)
  -> catalog-validated host or Studio executor
  -> native observation / evaluation result
```

工作区切换、版本变化、停止回合和 Codex 进程重连都会使排队调用失效。Native 进程可能仍在结束，但其结果不会再写回旧回合。
