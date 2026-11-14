# 前端组件选型

通用交互优先交给覆盖完整场景的成熟组件，应用保留电路、文件和运行状态的语义。依赖是否合适，取决于它能接管什么职责，以及真实桌面中的行为，而不是能否渲染一张相似截图。

以下为2026年11月的选型。表中列出当前实现；进一步引入库须有对应的产品需求和实际收益。

| 构件                   | 当前实现                                                                                                     | 应用保留的职责                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| 设置、表单、菜单、确认 | [Radix Themes](https://www.radix-ui.com/themes/docs/overview/getting-started)，统一主题和通用交互            | 异步提交、错误、焦点返回、属性提交语义                 |
| 悬浮提示               | [Floating UI](https://floating-ui.com/) 负责定位、翻转和屏幕边界                                             | 溢出文本判断、延时、提示内容                           |
| 工作区分栏             | [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels)，接管拖动、键盘与尺寸约束        | 抽屉、页签、用户布局意图与恢复                         |
| XML 源码与历史差异     | [CodeMirror 6](https://codemirror.net/)、[merge](https://codemirror.net/docs/ref/#merge)，共享编辑与差异底座 | 源修订、预览、显式应用、历史只读                       |
| PDF 资料               | [Mozilla PDF.js Viewer](https://mozilla.github.io/pdf.js/getting_started/)，使用完整 Viewer                  | 文件访问、引用、阅读位置和页面跳转                     |
| AI 输入与附件          | [assistant-ui 0.15.35](https://github.com/assistant-ui/assistant-ui)，ExternalStoreRuntime 与 Composer primitives | 项目文件身份、引用快照、Tauri 原生拖图和草稿持久化 |
| AI Markdown            | 已使用 [react-markdown](https://github.com/remarkjs/react-markdown) 与 GFM                                   | 工程引用、外部链接、代码复制                           |
| AI 长历史              | [React Virtuoso 4.18.20](https://virtuoso.dev/react-virtuoso/)，使用 MIT 核心包                              | 回合与工具卡片、流式内容、展开状态、会话位置、引用回跳 |
| 文件树                 | [Headless Tree](https://headless-tree.lukasbach.com/)，接管异步树状态、选择和键盘导航                        | 磁盘命令、导入冲突、桌面文件拖放                       |
| 搜索与模型选择         | [cmdk](https://cmdk.paco.me/) 接管搜索列表与键盘选择，Themes 提供浮层；自定义模型仍可直接输入                | 模型发现、服务范围、过滤规则和状态                     |
| 成员、成绩、提交表     | Themes Table；当前无需独立表格状态引擎，出现复杂排序、筛选需求时再评估 TanStack Table                        | 角色、评分定义、完整学生范围和提交归属                 |
| ROM/RAM 编辑           | 保留分页领域编辑器，通用输入使用主题控件                                                                     | 地址、位宽、原值检查、运行态与工程写入区别             |
| 波形与统计             | 数字总线波形保留领域实现；当前统计为指标与表格，没有需要替换的图表引擎                                       | 四态逻辑、采样时序、总线显示与运行控制                 |
| 电路画布         | 保留 Logisim 符号录制/Canvas2D 回放                 | 元件身份、端口、接线、编辑、仿真和文件保真             |
| 课堂页面               | Themes 表单、页签、表格与共享 DialogFrame；沿用课程与评测数据流                                              | 教材、测试用例、工程快照、评测与权限                   |

## 接入时需要解决的边界

分栏只保留一个尺寸控制器。窗口变小时的临时夹紧不能覆盖用户希望恢复的宽度；拖动结束后保存，不能每次 pointermove 都写持久化。资料 iframe、抽屉和折叠仍要在实际窗口中检查。

源码编辑器的语言高亮不是电路校验。编辑缓冲区、预览和应用继续分开；切工程后旧请求不能写入新文档。历史差异使用只读视图，不开放编辑或逐块接受操作。中文输入和长 XML 的验证要在 WebView 中进行。

聊天按回合使用 Virtuoso 虚拟化，会话层保留三层展开状态；滚动测量与定位由库管理，应用只表达用户是否跟随。虚拟化不能只替换 `.map()`：同一回合会持续增长，展开状态不能随卸载丢失，上翻阅读不能被强制滚回底部，引用也不能依赖未挂载的 DOM。它不解决单条巨大 Markdown 的解析成本。输入区已采用 assistant-ui 的 ExternalStoreRuntime 与 Composer primitives，接管文字、图片粘贴/选取、发送状态与失败恢复。库读取现有消息投影；消息持久化仍属于 Pi 运行时，历史滚动仍只由 Virtuoso 管理。文件引用和图片都先保存成不可变引用，localStorage 只保存草稿文字与引用摘要，不保存图片字节。Tauri 原生拖图经有大小限制的读取命令进入同一附件适配器，不写入用户工程。输入通过库的 render 槽使用原生 textarea，保留已有的 ResizeObserver 尺寸处理：WebKit 在折叠面板零宽时会把占位文字误算为多行，库默认的隐藏文本框测量未覆盖这个场景。

文件树的通用状态可以替换，拖放需要单独适配。[Tauri 在 Windows 上的原生拖放与 HTML5 拖放存在互斥关系](https://v2.tauri.app/reference/config/#dragdropenabled)。不能为接入树库而关闭外部文件拖入；内部移动、引用和外部拖入必须一起验证。

已有成熟能力继续复用。无需为更换 Markdown 解析器而迁移模型 SDK，也不为64字的内存分页引入电子表格引擎。React Flow、通用画图库或数值图表库不提供 Logisim 的装载、接线和仿真语义，不能据此认为领域画布已被替代。

共享弹窗由 Radix 管理模态层、焦点圈定与 Escape；DialogFrame/Body/Footer 仅组合标题、滚动内容和操作区。长表单必须在矮窗口中检查内容滚动，不能依靠 jsdom 的尺寸证明可用。所有通用控件使用主题状态，领域区域只定义必要的布局。

消息过程由 `presentTurn` 统一结合运行状态和消息阶段划分。待确认的流式文字先显示在回答区，模型确认工具调用后归入过程；中断、失败或恢复出的未完成回合不把尾部文字提升为最终答案。过程独立分组，完成后默认收起，摘要只显示步骤数或异常计数，耗时单独排列且不换行。长对话仍由 Virtuoso 管理，折叠状态仍按对话保存；领域工具结果和撤销继续沿用现有实现。
