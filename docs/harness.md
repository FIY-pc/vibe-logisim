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

用户可在当前任务运行时追加意见，通过原生 `turn/steer` 进入同一回合。宿主复用当前选区、资料和留存观察的准备路径；前端在准备前捕获活动回合，原生拒绝后保留草稿，不自动重启任务。消息在原生确认后进入对话，正在执行的工作记录保持连续。补充消息不提供按整轮回退的编辑按钮，原问题仍可在运行结束后编辑。协议与鼠标交互的验证边界见 [032](../experiments/032-live-steering/README.md)。

插件能力是用户驱动的。模型可以直接编辑工作目录中的 `.circ` 文件，之后请求观察；也可以使用候选构建工具；可以先完成整张电路再运行实验。插件提供可靠动作和证据，不规定动作顺序。

按需参考通过只读挂载 `/tmp/vibe-circuit-reference/` 提供，来源为 `apps/desktop/circuit-knowledge/`，开发版和独立包使用同一内容。它不写入用户文件夹，也不强制每轮读取。`java-runtime.md` 包含支持运行文件的 CLI 语义、正确的 Pin API 与一次性 Java 进程退出示例，供模型选择独立验证时复用。

动态工具能力与原生会话绑定。每条本地对话保存创建线程时的插件契约签名；应用升级插件后，旧签名不会被假装成当前能力继续恢复。宿主会保留本地可见消息，启动带新工具集合的线程并替换绑定，同时记录被替换的线程。这样新增能力是一次明确的会话能力更新，旧线程和旧证据仍可追溯，模型也不会在一个没有新工具的线程里误以为工具存在。

长期协作说明独立在 `electron/agent-instructions.cjs`：介绍真实工作目录、会话与文件边界、冻结观察、实例身份和人工操作，不规定检查或验证顺序。具体参数由工具目录拥有。当前 Codex 0.153.3 在工具契约不变的恢复/分支中仍使用初始 developer 指令，不能只凭传入新版参数认定已更新；新线程和因能力契约升级而创建的新绑定会使用新版说明。

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
| `run` | 本次执行的 ID、用户可读 label、类型、状态、authority 和 stimulus 摘要 |
| `result` | 原始观察或运行报告 |
| `feedback` | 有明确期望时的比较结果，没有期望时保持 `observed` |

模型传输出口由 `electron/model-result-projection.cjs` 提供规范视图：已知 metadata 仅在整值严格相等时保留一个规范位置；`inspect` 的组件链接仅在与既有模板精确一致时省略逐组件副本。观察、未知位、错误、新字段、保存/磁盘状态及图片不变；UI 和历史继续使用原始对象。不向模型发送解码协议，也不截断电路信息。具体规则及同一原始对象的测量见 [010](../experiments/010-model-efficiency/README.md)。

1.9.1 的模型接口经 `electron/schema-constraints-projection.cjs` 从现有 schema 自动补充整数、数值/项数/字符数/字段数量界限；原生 Code Mode 的 TypeScript 声明实际会丢失这些信息。只追加可见说明，不改变执行规则、optional/required 或调用流程。契约签名包含发送给模型的实际声明；当前 Codex 的 resume/fork 不更新旧工具，因此沿用已有新原生绑定机制，不假装旧线程已收到新接口。具体真实协议回放及上下文边界见 [012](../experiments/012-tool-constraints/README.md)。

1.10.0 由 `electron/model-tool-output.cjs` 同时声明实际返回格式：本机 Code Mode 返回字符串，普通 JSON 结果需先 `JSON.parse`，带图结果使用工具原有的 image() 示例。native DynamicToolSpec 没有返回 schema，不能假设 `Promise<unknown>` 的实际结果是对象。此说明随真实模型工具契约签名更新，执行与 UI 对象不变。触发它的真实问题是 1.9.4 模型误读计数字段后重复穷举；[返回类型验收](../experiments/012-tool-constraints/RESULT-TYPE.md)证明传输与字段解析。[020 真实模型对照](../experiments/020-result-contract/README.md)中有/无说明均完成同一只读验证任务、完整覆盖且只穷举一遍；没有观察到减少重跑，不将单次耗时差当因果收益。

原生属性适配在 `observer/src/com/cburch/logisim/circuit/NativeAttributeAdapter.java`：编辑器下拉项可能是包装对象，须经克隆 AttributeSet 的原生 setter 转为保存值。模型元件查询、人工模板/编辑和观察器使用同一边界；两种 Logisim 的实际拆线器位分组、连线仿真、非法配置及撤销已验证，见 [013](../experiments/013-component-attributes/README.md)。这不增加特定任务工具，也不改变直接编辑 `.circ` 的能力。

当前能力类别包括：

- `context`：打开电路并建立共享画布绑定。
- `observe`：读取结构、原生元件定义、冻结观察、组合仿真和时序 trace。
- `construct`：构建候选或把工作目录中的直接编辑载入候选。
- `mutate`：把候选写回用户选择的源文件。
- `evaluate`：运行用户主动请求的实验，并在存在可比较期望时返回判断。

1.12.0 的 `simulate_circuit` 可二选一接收内联 `vectors` 或工作区相对路径 `vectorsFile`。文件是相同 `{inputs, expected?}` 结构的 JSON 数组，最多 131,072 组、32 MiB；模型用普通脚本生成数据，工具只读取，不执行代码。Electron 按当前文件夹解析路径（包括子目录中的电路与根目录测试资料），运行器读取一次并记录实际字节摘要，内部每 1,024 组复用常驻 JVM 执行。各组仍新建原生状态，每批核对同一电路与运行时；缺行或中途执行失败不能产生整批通过结果。返回完整计数及有限反例/未知样本，完整行沿用观察记录。它减少模型编写 Java 运行入口或多轮批次调用的需求，不生成预期、不强制验证，也不是独立 oracle。小样本、直接 Java/CLI 和时序 trace 继续分别可用。

1.13.0 的 `move_candidate` 还可接受 `positions:[{componentId,x,y}]`，一次指定多个元件各自的最终坐标。ID 全部来自同一次观察，不需逐次移动后重新查询；只检查最终布局，因此支持同时腾空旧位置。它与 `componentIds+delta`（可含 wireIds）二选一，位置由调用者决定，不自动规划布局。两种操作共用 `plan_movements`、XML 更新和原生端口位检查；同位移的内部路径随组平移，不同位移的连接重新布线，固定元件与真正的分支节点继续作为边界。普通拐点不会再被误加入固定端口集合，附着在移动端口上的分支随端口移动。源文件只在用户或模型明确选择 checkout 时写入，候选可预览、组合，直接编辑路径仍开放。

1.14.0 的 `wire_candidate` 移除组件白名单，新增部件复用人工 palette 的真实工具、默认属性、序列化和端口。`factory` 使用原生 tool 名称；可选 `library` 使用当前工程库 ID，空字符串表示项目子电路，省略时仅接受目录中唯一的可放置同名工具。自定义封装及属性由运行时解释，不在 Python 中猜端口位置；一次 `component-templates` 请求取得全部新增部件，仍由已有路由器按完整端口连线。连接 `name` 是可选说明。该版本不新增 Pin/Tunnel；1.17.0 放开无父实例定义的 Pin 构建（见下文），直接文件编辑继续开放。未知库、名字歧义、属性错误和子电路循环在布线前拒绝，并带出对应新增部件 id；失败只清理本次未发布候选。

1.16.0 允许请求中明确相连的两个同宽端口直接贴合（新增与已有、新增与新增）。已有导线占用、第三个端口和未请求的接触仍拒绝。只有发生贴合时才独立加载新增部件，保留 Splitter 等原生部件内部的逐位连接；以贴合前的位网为基准核对允许的接触及最终连线，避免原生加载已合并网络后掩盖短接或多个驱动。无接触构建复用正常观察，不为每个新增元件追加加载。真实失败请求的恢复、图面和独立行为结果见 [026](../experiments/026-explicit-port-contact/README.md)。

1.17.0 的 `wire_candidate` 支持在没有父实例的定义中新增原生 Pin，包括产品新建的空白 main。原有引脚必须保持不变，新增集合必须与请求一致；已有父实例时给出明确原因和接口编辑/直接文件编辑路径，不猜父电路接线。元件目录、模板和连接校验继续共用。后续 wire/move/reroute 对比前一个候选的接口，保留相对源文件的 `interfacePreserved: false`，不会把合法扩展的接口误当作破坏。只改变当前定义且无父实例时，不逐一加载无关定义。助手活动的失败详情也不再被工具名覆盖。真实空白计数器回合暴露了这两个阻碍，但原回合超时且输出冲突，未完成任务；修正后的从空白构建/继续编辑是生产入口验证，不是新的模型自主成功，见 [027](../experiments/027-counter-from-blank/README.md)。

1.18.0 在普通 `inspect_circuit` 的 `connectivityIssues` 中新增 `multipleOutputPeers`：从完整原生位网归并多个标为 output 的端口，给出组件/端口 ID、位置、原生提示和位映射，局部选择也带出选区外相关端口。默认最多16组、每组8个端口、每端口32个位映射，所有省略均标出，完整 nets 保持可读；没有新增原生查询。它是静态连接事实，不能把三态/未激活输出或原生方向元数据当作实际驱动冲突。真实失败计数器的寄存器、多路器和常量输出共网现可直接定位，正常32位扇出与原请求恢复产物不报告该项，见 [028](../experiments/028-construction-feedback/README.md)。

1.19.0 的 `wire_candidate` 可用 `removeWireIds` 显式删去已有原生导线段，再新增部件或按端口重连；也支持只删除或只放置。删除要求同一 source/candidate 观察的 `artifactSha256`，导线 ID 严格匹配该原件；端口引用在删除前绑定，避免重载编号变化。复用人工删线的几何减法，原生拆分后的半段可独立选择；不自动猜测整条信号路径或清理未选支线。连接证明以删线后的原生位网为基准，仅允许请求中的新合并，保留其余端口位关系、原组件与接口。候选仍独立，checkout 写入共享文件并进入原有撤销机制；直接文件/脚本编辑继续开放。真实失败计数器的4段删除+2对重连约0.118秒完成，独立原生运行、真实鼠标操作、宿主写回/撤销通过；不是新模型自主采用或整轮提速证据，见 [029](../experiments/029-topology-repair/README.md)。

1.20.0 的时序入口共用 `inputClocks` 周期输入激励：`[{name:"CLK"}]` 从 `inputs.CLK` 的初值开始，于第1步翻转，此后每步翻转。可指定 `firstTick`、`lastTick`、`highTicks` 和 `lowTicks`；停止后保持末值。同一步先按原顺序执行 `inputEvents`，再按声明顺序翻转周期输入，最后执行按钮事件，每项独立传播。一个Pin只能由一种输入事件来源驱动；原生Clock依然在这些输入事件之前推进，并非同一时间单位下的物理时钟。周期激励展开为现有原生事件，执行摘要来自展开序列，返回与留存报告保持紧凑参数；Java按tick索引事件及绑定端口，不再逐步扫描全部事件。适用于 trace/evaluate/harness/compare 的时序模式，不是必需的验证步骤。实际原生与宿主消费结果见 [030](../experiments/030-clock-stimuli/README.md)。

1.21.0 将 `inspect_circuit(includeNets:true)` 的默认连接视图改为 `netGroups`：具有相同端点/切片结构的原生位网合并展示，`netIds[i]` 与每个 contact/slice 的 `bits[i]` 仍一一对应，反向拆线和同端口多位短接不被折叠为猜测的总线。无法归组的记录原样保留；`netFormat:"bits"` 可直接读取逐位原记录。分组发生在模型观察边界，原生位网、组件和连接诊断不改写。失败计数器的真实宿主模型出口从24,424 B降至20,128 B；这不是模型耗时或成功率证明。

同版新增共享 `NativePortSemantics`，按实际加载的类及其 SHA-256 校准已核实的 HUST/ITA 实现：Adder 的第4端口实际输出进位，虽原生 EndData 声明为输入；观察和元件模板现返回 `direction:output`，同时保留 `nativeDirection:input` 与 `directionSource`。两个运行库的 Register 都按原生实现给出七个端口角色及状态元件分类，移除此前对 HUST 的错误排除。模板、组件详情、选区、目录、位网和连接反馈共用这些语义；未知实现继续使用原生声明，不根据名称或 tooltip 猜测。没有改动运行库端口对象或执行逻辑，方向仍不意味着输出此刻正在驱动。具体实现事实、原生运行及宿主出口见 [031](../experiments/031-observation-semantics/README.md)。

1.21 在源码 `04e1aa3` 上的一次真实模型修复已完整交付：同一027失败计数器、028修复提示和8分钟时限下，`gpt-6-astra / xhigh` 于348.587秒结束并给出final，首次写文件命令于208.705秒开始。模型11次工具调用无失败，通过Python直接改XML并submit刷新画布；没有使用 `wire_candidate`，两次inspect均显式选择 `netFormat:"bits"`，没有消费 `netGroups`；一次trace和一次evaluate采用 `inputClocks`。修正后的Adder方向与Register七角色确实出现在首次结果，但本次不能归因为它们或groups带来的提速。最终产物 `b3c414c5f6e0111bc1da44a756dd76395e54549ebabbc2cb8e4408244aebe86c` 经39个真实Electron输入采样、停止/重开及独立267采样通过；模型自给期望的5个evaluate案例单独记录。模型额外将preset悬空列为原因并接0，悬空导致原故障或接0必要性的因果均未独立证明。此前超时记录保留，只记单次完整成功，不作版本因果A/B或成功率结论。见 [真实回合摘要](../experiments/031-observation-semantics/model-repair-1.21/summary.json)、[工具输入输出](../experiments/031-observation-semantics/model-repair-1.21/tool-calls.json)与[原始oracle](../experiments/031-observation-semantics/model-repair-1.21/oracle.json)；本次归档没有运行新模型或测试。

`harness_run` 的反馈状态只有在每一行都有明确期望、传播已稳定且全部匹配时才是 `passed`；已稳定样本存在确定的不匹配时是 `failed`；需要比较的信号未知或运行振荡时是 `unknown`；没有完整比较条件且没有上述异常时是 `observed`。这个状态描述本次实验，不推动模型进入下一步。

1.10.1 的 `simulate_circuit` / `trace_circuit` 在原生报告生成边界使用相同的 `observation_feedback`，附上真实运行已有的 run ID、stimulus 和 runtime 身份；保持原先顶层 rows/passed/failed/unchecked。汇总先于传输采样与分页，不能因未返回的第 41 行存在未知或反例而误报整批通过。未断言的 trace 可以是已观察或振荡未知，不能通过。现有事件与评测记录器直接接收这份反馈，不从工具完成、调用次数或空身份推断验证；一次调用只记录一次。见 [原生链路验收](../experiments/008-native-verification/SIMULATION-FEEDBACK.md)，历史 episode 保持原样。

桌面宿主把所有带 `feedback` 的结果投影成同一类 Harness 事件：保留旧式 native `session` 以支持已有的对象定位，同时使用 `binding` 和 `run` 识别所有结果类型。外部验证器没有 native session 也能显示自己的 label、通过/失败/未确定状态和有限输出预览；原始完整结果仍只作为模型工具结果返回。未确定结果在工作过程中显示“待确认”，不会伪装成通过或普通完成。

右栏投影保留每次调用的 `resultStatus`：后续传输层“工具完成”不能覆盖实际反例或未知，另一批通过也不能自动将前一批反例标为恢复。工具请求失败的重试仍沿用原有处理；运行不匹配、未确定与普通已观察分别显示，不把测得反例说成工具没有执行。

`inspect_circuit` 的 `connectivityIssues` 由 `domain/connectivity_feedback.py` 根据完整原生位网生成。1.9.2 修正了“有网络编号就算已连接”的漏报：`unconnectedInputs` / `unconnectedOutputs` 按端口列出没有其他端口 contact 的位；导线段可以存在。`inputsWithoutOutputPeer` 另列有 peer 但没有被原生标为 output 的位，不重复前一类；`unknownPorts` 与 `widthIncompatibilities` 保留未知和冲突。省略 nets 或筛选组件不缩减判断所用网络。原生方向标签不等于实际驱动，浮空输入也可能有合法默认值，因此这些是静态事实，不是功能成败或强制提交条件。两种实际运行时的总线、浮空、冲突反例与历史产物证据见 [014](../experiments/014-wire-construction/CONNECTIVITY.md)。

`inspect_circuit(circuit, componentDirectory: {maxBytes?, cursor?})` 提供可选组件目录。1.15.0 起直接包含组件位置、边界、子电路目标和端口坐标、位宽、方向与原生角色说明，可据此布局和接线，无需仅为几何再查完整详情。属性和详细位网按既有 componentIds 路径读取。页面按实际 UTF-8 JSON 字节预算生成，默认 24,000、上限 32,000，包含身份与游标；未知端口保留 null。游标绑定工程、版本、候选和完整静态观察/运行环境，过期拒绝，单条过大明确报错，不切断或跳过条目。原始全文和 Code Mode 自行筛选仍可用。原有分页证据见 [018](../experiments/018-inspection-discovery/README.md)，用目录完成原生子电路构建的实际消费见 [025](../experiments/025-context-observation/README.md)。

每轮会话上下文的 `binding.plugin` 只携带插件身份与版本；完整工具说明由原生 dynamicTools 提供一次，不在应用上下文中再复制 capabilities。原始 context 仍保留给 UI，选区、运行观察、留存时刻和资料引用照常传送。

插件 1.8.0 的 `describe_component` 复用左栏元件库的 `PlacementService` / `CircuitPalette`，让模型能查询尚未放置的元件。只传 `circuit` 返回当前工程声明库及子电路中的可放置工具；加 `library`、`tool` 和可选 `attributes` 返回有效属性、选项、真实端口索引/方向/位宽/原生 tooltip、边界，以及原点为 `(0,0)` 的 `<comp>` XML。插入时移动 `loc` 并平移端口坐标；库 ID 属于当前工程，不能跨项目照搬。属性初值来自当前库工具配置，不冒充固定的 factory 默认值。

模型查询不生成图片或 base64，不创建候选、放置元件、保存或修改结构历史。未知、非法或设置后被丢弃的属性会明确失败；模型入口使用返回的原生标准字符串，人工模板/放置继续接受原生合法的颜色与数值别名。支持动态属性的依赖关系，不把 JSON 对象键顺序变成行为约束。它提供形状和配置参考，不说明该元件在任意电路中的行为已经通过验证，也不要求模型先查再编辑。

`evaluate_circuit` 是独立的评测能力。组合模式要求每个输入向量带非空 `expected`；时序模式要求非空 `expectedRows`，每行指定 tick 和至少一个观察信号的期望。它返回 `evaluation` 对象并保留底层 native observation：`passed` 表示所列案例全部稳定且匹配，`failed` 表示至少一个已稳定样本存在确定的不匹配，`unknown` 表示没有确定反例，但存在未确定信号、缺失样本或振荡。振荡样本即使某个独立输出恰好匹配，也不算通过；另一个已稳定样本的确定反例仍足以判失败。`cases[].reason` 和 `feedback.firstUnknown` 区分具体原因，不把未知位变为零。

`compare_circuit` 是另一条可选路径：它用同一组原生时序激励运行当前版本和当前工程拥有的历史 revision，默认对照紧邻上一版本，也可以传入历史 `referenceRevisionId`。`passed` 只表示所选观察点在这次实验中与历史一致，`failed` 会给出第一个差异，`unknown` 表示缺少样本或发生振荡。它适合做回归检查；历史版本本身不是课程期望，因此这个结果不能替代 `evaluate_circuit` 的显式规格或用户提供的测试脚本。

外部 oracle 通过工作区根目录或当前电路所在目录向上的最近 `vibe-verification.json` 声明。`list_verifications` 只发现声明，`run_verification` 只运行模型明确选择的条目。命令可以使用 `${artifact}`、`${artifactDir}`、`${source}`、`${workspace}`、`${circuit}`、`${revision}`、`${artifactSha256}` 和 `${oracleSha256}`，并会收到同名的 `VIBE_LOGISIM_*` 环境变量；harness 会在一次性目录中 materialize 当前不可变 artifact 及其冻结的 JAR/资料依赖，`${artifact}`、`${source}` 和 `VIBE_LOGISIM_SOURCE` 都指向这份 disposable 输入，不会把用户源文件交给脚本写入，`${artifactDir}` 指向其目录。recipe 可以声明工作区内的相对 `oracleFiles`，结果会保留这些文件的摘要与完整性状态；没有声明时仍兼容运行，但结果会标记 oracle identity incomplete。结果同时绑定当前 revision、artifact SHA、清单 SHA、规范化验证条目 SHA 和（若声明）oracle 文件 SHA；运行期间输入包、清单、oracle 文件或用户源文件发生变化时只能得到 `unknown`。验证结果还区分 `execution=completed|timed-out|output-limited|identity-changed|failed-to-start` 与 `verdict=passed|failed|unknown`，旧的 `feedback.status` 仍保留用于兼容投影。验证器在独立进程组中运行，超时会清理其子进程。条目可以按进程退出码判断，也可以返回 `{"status":"passed|failed|unknown"}`。这是一层通用适配协议，课程自测、个人脚本和项目回归都通过同一入口接入，插件不理解脚本的领域语义，也不要求每次任务都运行验证器。

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

候选编号缺失或拼写不完整时，`CANDIDATE_NOT_FOUND` 附当前工程、当前 revision 的最多五个完整候选编号与标题；读取和 checkout 的桌面通道均保留同一结构化反馈。编号仍严格匹配，不按前缀自动选中或写入。此修正来自 1.13 真实模型将编号少抄一位后连续失败的记录，见 [023](../experiments/023-simultaneous-layout/README.md)；反馈可恢复不等于已证明模型耗时改善。

1.9.4 的原生加载共用 `NativeCircuitLoader`，在 Logisim WireRepair 前拒绝非水平/垂直导线，给出具体定义、序号及端点。它不自动换路线，不把坐标对齐规则扩大成网格/非零长度限制；直接编辑文件仍受支持。常驻 worker 的意外结束附退出码及有界 stderr，具体 observer 错误会传到渲染和交互启动。两种 JAR 的兼容、拒绝后的正常处理及源/结构不变证据见 [017](../experiments/017-native-wire-validation/README.md)。这是执行边界的故障反馈，不要求提交前先验证，也不证明功能正确。

插件边界还会执行工具目录中声明的 `minimum/maximum/minItems/maxItems` 以及嵌套对象约束。越界参数在进入 native runtime 或工作区命令前就返回带路径的 `INVALID_ARGUMENT`，并给出可修正的边界；目录是约束的唯一来源，执行器不再各自重复维护一套上限。

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

`simulate_circuit`、`trace_circuit` 的 `execution` 由执行 JVM 返回：从实际加载的 Pin 类定位 JAR，读取其摘要、运行版本和电路摘要，操作结束时再次核对文件未变。宿主将其与调用前的运行文件/电路摘要比较，不匹配即拒绝结果。完成后的 `runtimeProfile` 为 `observed`；它和 `binding` 使用同一运行身份。历史对照分别保留两侧实际运行信息，不拿当前环境代替历史环境。尚未执行的配置描述仍保留 `configured-not-observed`。

`trace_circuit` 与组合仿真一样，可省略 `candidateId` 表示当前文件；旧调用传空串仍兼容。运行身份说明本次执行使用了什么，不证明测试规格充分，也不是防恶意运行环境的远程证明。

如果需要判断“在声明范围内是否真的 work”，使用 [Harness 评测契约](harness-evaluation-contract.md)。它把结构观察、实际运行、期望比对、失败/未知和身份绑定放在同一证据边界中，但不要求用户或模型按固定顺序执行这些动作。

插件 1.7.0 的 `trace_circuit` 暴露 `inputEvents` / `buttonEvents`，与 `evaluate_circuit`、`harness_run` 共用现有执行器。初始化输入传播、可选复位按钮脉冲之后，执行 tick 0 事件再采样；后续每步先推进原生 tick 并传播，再依次执行输入事件、按钮事件和采样。同类事件按列表顺序逐个传播，值持续到下一次修改。原生 Clock 的高低持续时间决定何时翻转，tick 不等于时钟沿；以 Pin 作为时钟时由输入事件驱动。分页参数只选返回行，每次调用都会从新状态重跑，不是继续上一轮。

## 当前实现边界

- Codex thread/turn 与工作区文件能力由 [`codex-backend.cjs`](../apps/desktop/electron/codex-backend.cjs) 负责。
- 插件的模型可见协议规格和暴露策略由 [`circuit-plugin.json`](../apps/desktop/circuit-lens/studio/domain/circuit-plugin.json) 声明，由 [`circuit-tools.cjs`](../apps/desktop/electron/circuit-tools.cjs) 校验和投影；[`circuit-plugin.cjs`](../apps/desktop/electron/circuit-plugin.cjs) 只执行宿主工具并串行化共享画布操作。调用执行会带着 `threadId`、`turnId` 和 `callId` 穿过宿主边界。
- Studio 的可执行插件注册和调用身份由 [`circuit_plugin.py`](../apps/desktop/circuit-lens/studio/application/circuit_plugin.py) 负责；`Workbench` 不再用一个按字符串展开的总分派器。目录中的 `import_candidate` 是隐藏的 Studio 内部能力，供候选生命周期测试使用，不会进入 Codex 的动态工具列表；模型看到的 `submit_circuit` 只刷新用户正在编辑的实际 `.circ` 文件。
- 真实 Logisim 仿真和 trace 由 [`harness.py`](../apps/desktop/circuit-lens/studio/runtime/harness.py) 的 `NativeCircuitRuntime` 调用 native runtime 完成；显式规格比较由 [`evaluation.py`](../apps/desktop/circuit-lens/studio/runtime/evaluation.py) 独立完成。
- 组合与时序共用 [`domain/evaluation.py`](../apps/desktop/circuit-lens/studio/domain/evaluation.py) 的样本比较语义；原生观察继续保留实际数值、未知位和振荡标记。空断言在运行前拒绝，观察动作无需提供断言。
- 插件描述通过 `/api/agent/plugin` 暴露，桌面宿主在发送上下文时将其作为 application context 注入模型绑定。

`NativeCircuitRuntime` 是电路插件中的原生执行能力，不是整个 Agent Harness。真正的 Base Harness 仍然是 Codex backend 及其 thread/turn、上下文、工具调用、权限、事件流和停止恢复边界。以后增加课程测试集、时序断言或其他领域能力时，优先注册新的插件 executor 或扩展独立 evaluator，保持 Codex 的代理生命周期不变。

`render_circuit` 是一个可选的视觉观察工具。它从当前绑定的 revision 和 runtime profile 取得真实 Logisim 图面，返回范围、像素尺寸和来源摘要，并通过 Codex app-server 的 `inputImage` content item 传递 PNG；不会把宿主路径放进模型上下文。默认返回整张电路图，也支持受限 viewport。图像只说明几何和标签，不能替代 `inspect_circuit` 的连接观察或 `simulate_circuit`/`evaluate_circuit` 的行为结果。图像过大时工具返回可操作的分块提示，模型可以自行选择是否继续查看。

模型整图和 viewport 都使用白底 RGB 原生 renderer，不能直接传递依赖网页背景的透明 overview。`region` 为电路坐标，`scale` 为每电路单位的像素数，并返回 `imageSha256`；静态图中的 X 不是运行结果。同版本同区域复用已有 renderer LRU，仍返回图像，避免模型压缩上下文后无法重看。切工程、修订或运行环境期间生成的旧图会被拒绝。

1.10.0 增加可选 `candidateId`，允许在 checkout 前查看候选整图或 viewport；省略时仍查看当前电路。`application/candidate_render.py` 复用候选 owner/base/artifact/依赖检查和白底 renderer，原生观察提供图面边界；不修改源文件、结构历史或候选 UI PNG。返回真实候选 SHA、candidateId、baseRevisionId 和本次实际预览 runtime，拒绝其他工程、过期基线以及运行中变化。每次预览仍有一次 native overview 以取得边界，不宣称更快。生产生成的两种候选、两种 JAR 和 Code Mode 图像字节传递见 [019](../experiments/019-candidate-render/README.md)。

**Code Mode 的最后一段传输也要验证。** 当前本机 Codex 0.153.3 会将动态工具的 `inputText`/`inputImage` 转换为换行拼接的字符串。直接 `text(await tools.render_circuit(...))` 会打印 base64，不能让模型看到图。工具 catalog 提供原生 Code Mode 调用示例：保留 metadata 文本，并把独立 data URL 行传给 `image(...)`。普通直接工具调用仍返回原生 `inputImage`。`node apps/desktop/test/native-tool-images.cjs` 用真实 Codex 和 localhost Responses 回放检查下一次模型请求中的 `input_image`，覆盖反例和 catalog 示例，不访问真实服务商或消耗模型额度。这证明传输契约，不证明某次真实模型回合采用了示例。

[实验 006-v3](../experiments/006-visual-feedback/results/2026-09-19-native-v3/README.md)另行记录了一次真实模型轨迹：原生上下文包含 2 张图片、0 段 base64 文本；模型在 8 分 24 秒结束，冻结文件独立仿真 8/8 通过。图面消除了穿过门体的线，但仍有长绕线和扩大的面积，布局目标没有因功能通过而自动完成。单轮结果不能证明通用增益。

## 可选的布局移动

1.11.0 的 `move_candidate` 提供与人工拖动相同的成组移动能力：传入当前 source/candidate 的 `artifactSha256`、`componentIds` 和 `delta: {x,y}`，可另选 `wireIds` 一起移动。内部线路随组平移，边界线路重新连接；距离对齐 10 单位网格，元件留在当前 0–6000 画布范围。允许通过 `candidateId` 连续组合，再用已有渲染、运行、写回动作处理结果；没有强制顺序，直接编辑文件仍可用。

`project/layout_document.py` 供人工编辑和模型入口共同应用 XML 布局，更新 Pin 的自定义封装引用。`project/moving.py` 负责独立产物、原生重载、全部端口位连接关系和外部接口检查；失败不发布候选或修改源文件。新位置若压到别的信号线，布线器提前返回具体端点冲突，不做无效路径搜索。工具只执行指定移动，不自动设计版式，也不承诺移动后的线最短。可选 `reroute_candidate` 可以继续整理遗留折线。

[实际使用与图面](../experiments/007-local-rerouting/results/2026-09-21-move/README.md)：外层助手通过模型工具入口移动真实产物上的 XOR/NOT/AND，原生检查保留 177 个端口位关系，随后局部重布线；最终文件经独立 65,536 组及真实 Electron 输入、停止、重开验证。没有调用嵌入模型，不能据此声称自主采用率或整轮加速。

## 可选的局部导线整理

`inspect_circuit(includeWires=true)` 返回原生导线 ID、端点、bundle、总线宽度和总长度；`wireOffset/wireLimit` 分页，默认 128、最多 512 段。它覆盖指定电路，不随 `componentIds` 缩小；默认 inspect 不附加导线明细。返回的 `artifactSha256` 将导线 ID 绑定到源文件或指定候选，避免文件改变后误用旧 ID。

`reroute_candidate` 接收该摘要和明确的 `wireIds`，将所选路径交给共享正交布线器。保留全部元件、属性、位置、接口、未选铜线及所选路径的端点和分支点；不新建 Tunnel，也不决定整个电路的版式。`domain/rerouting.py` 只计算几何；`project/rerouting.py` 将结果写入独立临时产物，以原生 Logisim 重载并比较所有端口位的连接等价关系，再发布到现有候选机制。异常只清理本次未发布产物，源文件与修订不变。

电路片段的读写复用 `CircuitDocument`，保留注释并按真实 XML 元素边界修改；不会把注释里的 `<circuit>` 文本误当编辑目标。宿主验收覆盖候选写回、渲染绑定和文件历史撤销，不能用原生候选生成成功代替共享文件链路成功。

候选可以继续组合、查看和仿真；模型选择 `checkout_candidate` 时才写入共享工作文件，随后仍可查看改动和撤销。直接改 `.circ` 不受限制。这个可选计算工具不要求用户采用候选工作流。它拒绝过期摘要、未知位宽、冲突网络和闭合回路；不承诺路径总会缩短，矩形元件障碍也不覆盖文字标签，美观和功能仍应按任务判断。

1.10.1 的共享 `domain/routing.py` 对器件边缘附近增加有限代价，并优先让端口沿向外方向引出一格，再转弯；不新增硬障碍、移动元件或生成 Tunnel。重新布线、按端口连线和人工移动复用这一几何规则。真实产物 A/B 保留局部改善与变差的区域，原生端口位关系和独立行为检查分开验证，见 [间隙与引出报告](../experiments/007-local-rerouting/CLEARANCE.md)。这只是局部走线偏好，未解决全图布局、外置标签和密集拆线器。

仿真执行现在由独立的串行 `SimulationWorker` 持有 warm JVM。[021 运行时调查](../experiments/021-simulation-runtime/README.md)显示固定成本主要来自 JVM/首次加载；同一 JVM 直接复用 `LogisimFile` 又会保留 ROM program overlay 并累积 Project/Simulator 线程。因此 worker 只复用 JVM，每个请求重新加载 immutable artifact；runtime 切换、超时、协议错误或 native/domain 异常都会销毁它。`NativeWorker` 的只读缓存仍不能承担仿真，也没有被扩成仿真池。

当前每次原生 `simulate`/`trace` 已在 finally 中关闭其 `Project` 的 Simulator；后续 021 复测的线程和文件引用不再增长。这个修复只负责请求内生命周期回收，不能把可变 `LogisimFile` 变成可复用快照，所以 warm worker 仍坚持每请求重载 artifact，异常后不继续复用。

`routing.lengthBefore/lengthAfter` 是所选/提出路径的长度，`circuitWireLengthBefore/circuitWireLengthAfter` 是原生规范化后的整图线长；重叠线可能被运行时合并，两者不能混用。[实验 007](../experiments/007-local-rerouting/README.md)分别保存直接工具计算、开放任务采用几何观察，以及真实模型自行调用局部布线器的结果；局部布线已被实际使用，但整轮效率和图面质量还不能由单次试跑推广。

## Episode 级效果评测

工具单测、catalog 校验和一次真实 dogfood 只能证明局部链路能工作，不能证明 Harness 让模型更容易完成任务。对照实验使用可重置的 workspace fixture，把同一初始 artifact、同一模型条件、同一用户任务和同一权威 oracle 配成一个 episode；只替换是否提供电路能力或工作台上下文。

[`episode-ledger.cjs`](../apps/desktop/electron/episode-ledger.cjs) 是被动的评测记录器。它可以 attach 到 `CodexBackend` 的 `event` 与 `telemetry` 事件，不改变模型可用的动作，也不强迫验证顺序。产物 schema 为 `vibe-logisim.episode/v2`，保存：

- 任务、条件、模型和 effort，以及开始/结束时间；
- 工具调用、失败状态、同类活动后续成功、阻塞请求和 host error；
- 视觉观察调用与绑定到原生图面的视觉证据次数，和行为运行调用分开计数；
- 第一次绑定到 revision/artifact 的运行证据及验证次数；
- artifact 是否改变、人工介入次数、token usage 摘要；
- 最终独立 oracle 的状态；模型声明语义对齐保留为人工审查项。

问题正文、命令正文、模型回答正文、完整电路输出和认证信息不进入 ledger；需要人工审查时，应由实验 runner 另行保存受控的证据文件。最终 `taskSuccess` 在 oracle 为 passed/failed 时分别为 true/false，unknown 时为 null。模型回答中的“完成/通过”不能覆盖 unknown；关键词无法分辨否定、承诺或旧结果，`claimEvidenceAlignment` 默认 not-assessed。

v2 将 v1 的 `invalidCalls/recoveryCalls` 改成 `failedCalls/laterSuccessesOfSameActivity`：非零退出可能是帮助输出或主动终止，后续同类命令成功也不能证明修复了此前问题。旧实验保持原始 schema，不倒改历史数据。实验 006 runner 可显式加 `--capture-commands` 保存有界命令和输出，便于受控夹具诊断；默认关闭，不进入产品历史或 ledger。此文件可能包含私有正文，发布实验前需单独审阅。

可运行的对照入口见 [实验 005](../experiments/005-harness-effect/README.md)。三组共用当前直接文件工作区、隔离方式、模型配置和原生 JAR，分别比较通用能力、增加工具、增加产品指令及上下文。最终冻结文件由独立 Java 客户端调用上游 Logisim 检查，不复用被测插件的 evaluator。预检不调用模型；真实回合必须显式启用。插件反馈事件统计看不到 A 组自建 shell 验证，因此不能用零次插件事件断言模型没有验证。

[通用任务 runner](../experiments/lib/README.md)复用生产工作区与 Codex host，可指定 fixture、任务、冻结文件和独立 oracle；[双实例时序任务](../experiments/009-sequential-hierarchy/README-scenario.md)用于跨模块、使能、同步复位及边沿验证。先停止模型再冻结工作区，功能判断不依赖模型自述。受控实验的有界正文记录包含宿主参数拒绝、checkout/submit 和 shell 退出结果，不只记录已进入 Studio 的调用；正文不写入产品历史或 Episode Ledger。

评测器可以事后把结构、接口、运行行为和用户目标建成 milestone DAG，允许不同轨迹达到同一结果。它不能把产品变成固定的“先观察、再构建、再验证”向导；用户和模型仍可以先完整构建，再请求验证，或直接编辑文件后运行。

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

这里的失效检查有两个边界：CodexBackend 在停止/切换时递增当前 circuit generation，Electron 插件在排队执行前、同步工作区后和 domain executor 返回后都调用 `scope.assertCurrent()`；因此过期结果不会推进新的 binding、产生 harness-result 事件或交给模型。队列本身会在失败后继续服务后续调用。这个交界由 [`circuit-tool-expiry.test.cjs`](../apps/desktop/electron/circuit-tool-expiry.test.cjs) 覆盖；它验证了第一调用过期、第二调用仍执行以及旧结果不泄漏。底层 native 进程可能还会完成当前有限请求，Python 工作区也会先完成已进入的原子操作，不能把“模型看不到旧结果”夸大为“所有底层计算被即时取消”。
