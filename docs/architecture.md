# 架构

一句话：Rust 宿主拥有工作区，窗口和 AI 进程都只是它的客户端，走同一套请求。每个模块目录下有一份 README，写明职责、接口、不变量、状态和待办；本文只给地图。

## 模块

| 模块                                                            | 语言                     | 职责                                                                            |
| --------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------- |
| [crates/circuit-document](../crates/circuit-document/README.md) | Rust                     | `.circ` 文件本身：解析与原样回写、对象 ID、修订、编辑、撤销、保存、历史、文件夹 |
| [crates/logisim-runtime](../crates/logisim-runtime/README.md)   | Rust + Java              | 真实 Logisim 运行时：观察连通、元件目录、属性、元件符号、渲染、仿真会话         |
| [crates/workbench-host](../crates/workbench-host/README.md)     | Rust                     | 唯一拥有工作区的进程：请求词汇与规则、状态目录、事件、AI 进程的生命周期         |
| [apps/workbench](../apps/workbench/README.md)                   | TypeScript、React、Tauri | 窗口：按领域分文件夹的界面状态与交互，不含任何业务规则                          |
| [packages/agent-runtime](../packages/agent-runtime/README.md)   | TypeScript、Node         | AI 回合：模型服务、按文件夹的对话、工具；每个工具调用都是一次宿主请求           |
| [packages/arranger](../packages/arranger/README.md)             | TypeScript               | 纯函数布局：放置、布线、等价检查，不做 I/O                                      |
| [scripts/workbench](../scripts/workbench/README.md)             | TypeScript               | 开发、验证、打包脚本                                                            |

依赖只向下：`circuit-document` ← `logisim-runtime` ← `workbench-host` ← Tauri 壳；窗口和 AI 进程通过传输层调用宿主；AI 进程和窗口各自在 worker 里调用 `arranger`。没有模块依赖窗口或 AI 进程。

## 四条数据流

1. **人编辑。** 窗口动作构造 `{op, …}` → `Host::dispatch` → `Document::edit`（带调用方读到的修订）→ 自动保存到源文件 → 记录历史 → 返回只含改动电路的 `change` 和 `selection` → 窗口把它并进打开的文档 → 画布在下一帧用缓存的元件符号重画（缺的种类发一次 `symbols`，见 [rendering.md](rendering.md)）。提交的连线、删除、移动在回复到达前先画出手势本身的结果，其余不预测。
2. **观察。** 宿主为每个修订落一份不可变 artifact → `Native::observe` 交给 Java 读取端口、位网、边界 → JSON 按 artifact 摘要缓存。连通面板、信号追踪、整理和 AI 的连接检查来自这份观察；画面、命中测试和端口标记用 `symbols` 录下的包围盒和端口，不等观察。
3. **AI 回合。** 窗口 `agent{method:"ask"}` → 宿主 → sidecar 标准输入 → `TurnRunner` 流式调用模型 → 工具以 `{kind:"host"}` 发宿主请求，走和人编辑完全相同的 `dispatch`；sidecar 不留文档，每个工具调用问宿主要它需要的那个定义。宿主把每个变化作为 `change` 事件广播，窗口按修订叠上（AI 的这次编辑也一样）→ 对话事件回窗口 `agent` 主题。每回合开始和结束各记一次文件夹检查点，窗口收到 `files-changed`，用户可整回合撤销。
4. **仿真。** 窗口 `simulationStart`/`simulationCommand`/`simulationNavigate`/`simulationStop` → `SimulationRegistry` 里唯一的 run → 一个 Java 进程（运行状态只在这里）。回复只有 `commandSequence` 或错误；Java 的帧经 run 叠进最新状态后，作为 `Event::Simulation` 推给每个页面的订阅（订阅先拿整幅）→ 窗口 store。每次请求后宿主 `reconcile`：文档关闭或修订变化即结束运行。

## 全局规则，各在一处实现

- 对象 ID 是位置：元件 `c<x>_<y>`（负号写 `m`，同锚点第二个加 `_2`），导线 `w<n>` 按文件顺序。由 `circuit-document` 定义，窗口、AI 和脚本都照此寻址。
- 每个修改请求带调用方读到的修订，不匹配整条拒绝（`StaleRevision`），没有部分生效。`circuit-document` 检查，宿主透传。
- 磁盘文件为真：文档是它的缓存。宿主在每个文档/文件夹请求前 stat 打开的文档（变了才读，见 `crates/workbench-host/src/documents/files.rs`），干净文档就地重载并广播，有未保存改动的文档绝不覆盖；窗口不轮询。
- 写操作串行、成功后自动保存（源文件在打开的文件夹内时）、记录文档历史、落恢复记录；全在 `Host::dispatch`。
- 仿真寿命绑定修订：`Host::reconcile`。
- AI 能调用哪些操作：`api/*.rs` 里每个 op 的 `Meta::agent()`，其余一律 `NotAllowed`。
- 对话的作用域是文件夹 ID：sidecar 从宿主 `status.folder` 取。
- Rust 类型是契约源：`npm run contracts` 生成窗口和 sidecar 的 TypeScript 与编辑 schema，`npm run check:contracts` 校验。
- 错误文案在错误产生处定义，面向用户、中文：宿主 `ErrorCode`、Java 桥接的字符串、AI 工具的 `CircuitToolError`。上层只展示，不翻译、不包装。

## 改东西去哪里

- 新的宿主操作：在 `crates/workbench-host/src/api/<领域>.rs` 加一个变体并声明 `Meta`，实现放进对应领域目录，跑 `npm run contracts`，再在窗口或 sidecar 使用。
- 新的 AI 工具：`packages/agent-runtime/src/tools/schemas.mts` 加 schema 和中文标签，handler 放进对应 `tools/<领域>.mts`，在 `tools/index.mts` 注册；工具只能调用宿主操作。
- 新的界面：放进 `apps/workbench/src/<领域>/`，状态进该领域的 store，跨领域只经过 `app/` 或 `shared/`。
- Logisim 行为问题：先看 `crates/logisim-runtime/java/native`；Rust 和 TypeScript 不复制 Logisim 语义。

## 待办

每个模块 README 末尾的「Remaining tasks」是当前的待办。跨模块的优先次序：

1. 通过新的 `agent-runtime` 跑一次真实模型回合，修掉断点（`packages/agent-runtime/README.md`）。
2. 宿主加 `observeXml`，`arrange_circuit` 改为先验证再应用（`crates/workbench-host/README.md`、`packages/agent-runtime/README.md`）。
3. 课程大小文件的编辑延迟：减少每次编辑的 Java↔Rust↔Node 往返（`crates/workbench-host/README.md`）。
4. 补回 sidecar 回合的脚本场景（`scripts/workbench/README.md`）。
