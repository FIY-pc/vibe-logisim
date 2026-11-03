# 前端组件选型

通用交互优先交给覆盖完整场景的成熟组件，应用保留电路、文件和运行状态的语义。依赖是否合适，取决于它能接管什么职责，以及真实桌面中的行为，而不是能否渲染一张相似截图。

以下为2026年11月的选型。已使用和候选方案分开列出；候选仍需实际接入、性能与平台验证。

| 构件                   | 采用或候选方案                                                                                                                                               | 应用保留的职责                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| 设置、表单、菜单、确认 | [Radix Themes](https://www.radix-ui.com/themes/docs/overview/getting-started)，统一主题和通用交互                                                            | 异步提交、错误、焦点返回、属性提交语义                 |
| 工作区分栏             | [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels)，接管拖动、键盘与尺寸约束                                                        | 抽屉、页签、用户布局意图与恢复                         |
| XML 源码与历史差异     | [CodeMirror 6](https://codemirror.net/)、[merge](https://codemirror.net/docs/ref/#merge)，共享编辑与差异底座                                                 | 源修订、预览、显式应用、历史只读                       |
| PDF 资料               | [Mozilla PDF.js Viewer](https://mozilla.github.io/pdf.js/getting_started/)，使用完整 Viewer                                                                  | 文件访问、引用、阅读位置和页面跳转                     |
| AI Markdown            | 已使用 [react-markdown](https://github.com/remarkjs/react-markdown) 与 GFM                                                                                   | 工程引用、外部链接、代码复制                           |
| AI 长历史              | 候选 [React Virtuoso](https://virtuoso.dev/react-virtuoso/)，使用 MIT 核心包                                                                                 | 回合与工具卡片、流式内容、展开状态、会话位置、引用回跳 |
| 文件树                 | 候选 [Headless Tree](https://headless-tree.lukasbach.com/)，接管异步树状态、选择和键盘导航                                                                   | 磁盘命令、导入冲突、桌面文件拖放                       |
| 搜索与模型选择         | 当前使用 Themes 浮层；搜索行为候选 [cmdk](https://cmdk.paco.me/)，自由输入组合框候选 [React Aria](https://react-spectrum.adobe.com/react-aria/ComboBox.html) | 模型发现、服务范围、过滤规则和状态                     |
| 成员、成绩、提交表     | 当前简单表格；排序、筛选等需求增长时采用 [TanStack Table](https://tanstack.com/table/latest) 与 Themes Table                                                 | 角色、评分定义、完整学生范围和提交归属                 |
| ROM/RAM 编辑           | 保留分页领域编辑器，通用输入使用主题控件                                                                                                                     | 地址、位宽、原值检查、运行态与工程写入区别             |
| 波形与统计             | 数字总线波形保留领域实现；统计图候选 [ECharts](https://echarts.apache.org/)，教学时序图候选 [WaveDrom](https://wavedrom.com/)                                | 四态逻辑、采样时序、总线显示与运行控制                 |
| 电路画布与布局         | 保留 Logisim 符号录制/Canvas2D 回放，通用布局继续使用 [ELK](https://github.com/kieler/elkjs)                                                                 | 元件身份、端口、接线、编辑、仿真和文件保真             |
| 课堂页面               | 按表单、目录、编辑器、表格复用以上构件                                                                                                                       | 教材、测试用例、工程快照、评测与权限                   |

## 接入时需要解决的边界

分栏只保留一个尺寸控制器。窗口变小时的临时夹紧不能覆盖用户希望恢复的宽度；拖动结束后保存，不能每次 pointermove 都写持久化。资料 iframe、抽屉和折叠仍要在实际窗口中检查。

源码编辑器的语言高亮不是电路校验。编辑缓冲区、预览和应用继续分开；切工程后旧请求不能写入新文档。历史差异使用只读视图，不开放编辑或逐块接受操作。中文输入和长 XML 的验证要在 WebView 中进行。

聊天虚拟化不能只替换 `.map()`：同一回合会持续增长，展开状态不能随卸载丢失，上翻阅读不能被强制滚回底部，引用也不能依赖未挂载的 DOM。它不解决单条巨大 Markdown 的解析成本。若以后整体采用 [assistant-ui 的 ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)，应统一消息控制层，避免两套状态与滚动系统并存。

文件树的通用状态可以替换，拖放需要单独适配。[Tauri 在 Windows 上的原生拖放与 HTML5 拖放存在互斥关系](https://v2.tauri.app/reference/config/#dragdropenabled)。不能为接入树库而关闭外部文件拖入；内部移动、引用和外部拖入必须一起验证。

已有成熟能力继续复用。无需为更换 Markdown 解析器而迁移模型 SDK，也不为64字的内存分页引入电子表格引擎。React Flow、通用画图库或数值图表库不提供 Logisim 的装载、接线和仿真语义，不能据此认为领域画布已被替代。
