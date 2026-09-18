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

插件能力是用户驱动的。模型可以直接编辑工作目录中的 `.circ` 文件，之后请求观察；也可以使用候选构建工具；可以先完成整张电路再运行实验。插件提供可靠动作和证据，不规定动作顺序。

## 插件契约

插件描述位于 `studio.domain.plugin`，JS 宿主侧的模型可见注册位于 `electron/circuit-tools.cjs`。两侧保持相同的插件 ID、版本和能力名称：

| 字段 | 作用 |
| --- | --- |
| `schema` | 插件或结果协议版本 |
| `id` / `version` | 能力来源和兼容边界 |
| `capabilities` | 能力名称、类别、是否写源文件、是否产生候选 |
| `availability` | 当前工作区、native runtime 和源文件状态 |
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

`evaluate_circuit` 是独立的评测能力。组合模式要求每个输入向量带 `expected`；时序模式要求 `expectedRows`，每行指定 tick 和观察信号。它返回 `evaluation` 对象并保留底层 native observation：`passed` 表示规格覆盖的案例全部匹配，`failed` 表示至少一个明确不匹配，`unknown` 表示运行结果中有未确定信号或缺失样本。

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

运行报告还记录 `runId`、`stimulusSha256`、开始时间、耗时和 authority。候选运行使用候选 artifact 的真实 hash，不能回退到基础工作区 hash。仿真输入、时钟和按钮事件仍属于本次运行的 transient stimulus，不写入电路结构。

## 当前实现边界

- Codex thread/turn 与工作区文件能力由 [`codex-backend.cjs`](../apps/desktop/electron/codex-backend.cjs) 负责。
- 插件的模型可见工具和能力注册由 [`circuit-tools.cjs`](../apps/desktop/electron/circuit-tools.cjs) 负责。
- Studio 的领域路由由 [`tools.py`](../apps/desktop/circuit-lens/studio/application/tools.py) 负责。
- 真实 Logisim 仿真和 trace 由 [`harness.py`](../apps/desktop/circuit-lens/studio/runtime/harness.py) 调用 native runtime 完成。
- 插件描述通过 `/api/agent/plugin` 暴露，桌面宿主在发送上下文时将其作为 application context 注入模型绑定。

`HarnessService` 是电路插件中的运行能力实现，不是整个 Agent Harness。以后增加课程测试集、时序断言或其他领域能力时，优先扩展插件能力和结果协议，保持 Codex 的代理生命周期不变。
