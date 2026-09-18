# 开发与验证

## 环境

当前桌面开发版在 Linux 上使用。需要 Node.js 22+、npm、Python 3.11+（服务使用标准库）、JDK 17+ 的 `java` 和 `javac`。前端 npm 依赖版本由锁文件固定。

开发启动的内嵌 AI 需要 `codex`、`codex-code-mode-host` 在 PATH 中，已有可用的本地 Codex 登录或服务商配置，以及可用的 `systemd-run --user` 隔离环境。独立应用包已内置这些程序和 Python、Java、Logisim，并提供应用内登录；见 [分发与验收](distribution.md)。PDF 预览使用内置 PDF.js，不再依赖 Poppler。

## Logisim 运行文件

桥接层依赖特定版本的 Logisim 内部接口。当前仍使用以下本地路径；运行文件与课程库未在此仓库分发，需从自己可用的 Logisim / 课程安装包准备，不能随意替换为其他版本。

| 文件 | 仓库内安装路径 | SHA-256 |
| --- | --- | --- |
| Logisim-ITA 2.16.2.2 | `apps/desktop/circuit-lens/native/Logisim-ITA.jar` | `9eb1aae5e87cf0c6e4af845dde00624338c6dce25d945b6482cad017aa6cbb34` |
| HUST 20200118 课程运行文件 | `workspaces/hust-riscv/original/course-package/logisim-ita-cn-20200118.exe` | `b2400702fb9e8e4c71c512d7e09678a788039f402be55164209cde4cee8fc996` |

请准备两个运行文件：基础环境检查使用前者，新建电路及 `source="2.15.*"` 的课程电路使用后者。课程 `.exe` 含 Java 运行类，由 Java 加载，不通过 Wine 启动。它们都是被 Git 忽略的本地依赖。

课程组件库 `cs3410.jar`、`riscv-probe.jar` 与引用它们的 `.circ` 放在同一目录。当前只加载已支持摘要的课程库；任意外部库和不同 Logisim 分支尚不保证兼容。详见 `studio/project/package.py`。

## 启动

从仓库根目录运行：

```sh
npm --prefix apps/desktop ci
apps/desktop/run
```

安装会将锁定版本的前端依赖生成到 `web/vendor/`；需要联网下载 npm/Electron 依赖。桌面打开本地文件夹后，可从文件树选择或新建电路。AI 使用同一工作目录，资料直接放入文件夹。

可选环境变量：

| 变量 | 用途 |
| --- | --- |
| `VIBE_LOGISIM_PYTHON` | Python 可执行文件 |
| `VIBE_LOGISIM_CODEX` | Codex 可执行文件 |
| `VIBE_LOGISIM_STATE_DIR` | 独立的本地电路服务状态目录 |
| `VIBE_LOGISIM_MODEL` / `VIBE_LOGISIM_EFFORT` | 模型与思考深度初始值 |

会话、认证与运行状态不属于源码。保持原生 Codex 的认证来源，不复制轮换凭据到多个独立活跃配置。

## 有针对性的验证

渲染性能和清晰度基准（真实 Electron、临时工作区、不启动 Codex）：

```sh
node scripts/bench/rendering.cjs /path/to/circuit.circ "电路名"
```

静态细节瓦片的端到端验收（真实 Electron、长课程电路、不启动 Codex）：

```sh
node apps/desktop/test/e2e-render-tiles.cjs
```

高 DPI、窄视口、瓦片复用和连续缩放基线（真实 Electron、不启动 Codex）：

```sh
node apps/desktop/test/e2e-render-density.cjs
```

测量解释和后续渲染架构见 [画布渲染方向](rendering.md)。

不消耗模型额度、也不需要课程电路的文件夹行为验证：

```sh
node --test apps/desktop/electron/folder-workspace.test.cjs apps/desktop/electron/folder-import.test.cjs apps/desktop/electron/folder-operations.test.cjs
```

`apps/desktop/test/` 保存桌面和原生运行验证脚本。许多历史脚本依赖本地 `exports/`、`archive/` 下的课程样本；它们没有随仓库分发，不能把干净检出直接运行这些脚本的缺样本失败解释成产品回归。现有 `npm run test:e2e` 也是需要样本的浏览器服务验证，不覆盖完整 Electron 体验。

交互改动优先在独立临时文件夹和独立状态目录启动真实 Electron，通过鼠标/键盘走用户流程，核对保存文件、原生行为与重开结果。AI 状态可用明确标注的回放验证；真实模型回合单独考虑额度和必要性。

已经安装上述两个 Logisim 运行文件时，可验证 AI 缺失不影响人工工作：

```sh
node apps/desktop/test/e2e-without-agent.cjs
```

此脚本在独立临时目录启动真实 Electron，故意指定不存在的 Codex 路径，经界面新建电路、放置元件、保存并重开，也检查无效目录不会覆盖当前文件。只替换系统文件选择器的返回路径，不模拟文件服务或电路引擎；不需要个人课设文件，不发送模型请求。它验证的是文件与人工编辑路径，不包含 AI 协作或仿真正确性的验收。

已提供 Linux 独立应用包构建及打包程序的鼠标/键盘验收入口，见 [分发与验收](distribution.md)。当前产物限本地验收，尚无公开安装器、跨平台验收或自动发布流程。

输入操作不再要求手工先启动仿真。针对本地全加器（含 `FullAdder`、`A/B/Cin/Sum/Cout`）的实际界面验收：

```sh
node apps/desktop/test/e2e-simulation-inputs.cjs /path/to/full_adder.circ
```

原文件会复制到临时工作区。脚本直接点输入，核对八种组合，检查启动中快速点击、未运行时填值、总线、按钮松开、启动失败重试及切换文件后的旧点击隔离。可追加独立包可执行文件路径，改为验收打包版本。

放置时的图面连续性可用同一份全加器验证：

```sh
node apps/desktop/test/e2e-placement-rendering.cjs /path/to/full_adder.circ
```

通过真实鼠标在放大和普通视野放置，延迟真实高清图响应，检查等待期间原图和新组件持续存在、后续点击保留、视野稳定、切换文件后丢弃旧图。记录逐帧状态与 Chromium 实际绘制的 PNG，便于检查局部闪烁；不替换原生电路结果，不消耗模型额度。

放置与删除的即时反馈和失败恢复可用临时全加器及空电路验证：

```sh
node apps/desktop/test/e2e-place-delete-latency.cjs
node apps/desktop/test/e2e-delete-recovery.cjs
```

两者都用真实 Electron 鼠标和键盘操作，不启动 Codex。前者记录单次放置、连续放置和 Backspace 删除从输入到画面可见的时间，并确认后台仍写入临时文件；后者让第一次删除故意失败，确认元件和画面覆盖层恢复、文件内容不变。它们测量的是本地即时反馈与恢复边界，不把后台写入耗时冒充用户已经看到结果的时间。

对话管理与草稿归属的验收：

```sh
node --test apps/desktop/electron/conversations.test.cjs apps/desktop/electron/conversation-drafts.test.cjs
node apps/desktop/test/e2e-conversations.cjs
```

窗口脚本在临时文件夹打开真实 Electron，经鼠标和键盘新建、搜索、重命名、归档和恢复，核对不同会话的文字与引用、跨文件夹隔离、切电路保留会话、重开恢复和电路文件未改变；历史消息使用明确标注的本地夹具，回答中状态也为回放。单元验证另覆盖旧索引备份迁移、延迟草稿保存、损坏记录保留，以及协议回放下不同会话续接各自原生线程。两者均不调用模型，不证明真实模型回答质量。

“分支到新聊天”额外使用真实 Codex 原生协议验收，需要本机 Codex 可以启动：

```sh
node --test apps/desktop/electron/conversation-fork.test.cjs
node apps/desktop/test/e2e-conversation-fork.cjs
node apps/desktop/test/e2e-conversation-fork.cjs --legacy
```

脚本只向隔离的测试配置写入合成历史，不复制个人会话或认证；在真实窗口点击早期回复的分支按钮，核对新线程的上下文只到所选位置、保留此前工具结果、原聊天和草稿不变、重开续接新线程。默认覆盖原生分页会话格式，`--legacy` 覆盖旧格式；不发送模型回合。单元回放另检查下一次发送使用子线程，以及失败、错误终点和过期响应不会替换原对话。

画布网格的鼠标、快捷键、缩放与重开验证：

```sh
node apps/desktop/test/e2e-grid.cjs
```

脚本在临时工作区使用真实 Electron 和原生电路图，核对网格显示、导线像素、平移缩放对齐、超长画布覆盖、输入点击及重启后的显示偏好。视图操作不改变电路文件或结构历史；不启动 Codex、不消耗模型额度。

### 文件拖动、删除和引用

```sh
node apps/desktop/test/e2e-file-operations.cjs
```

在真实 Electron 中用鼠标拖动文件/文件夹与右栏引用，悬停展开目录，拒绝向自身子目录移动和覆盖同名文件；经界面放置元件、移动当前电路、继续编辑和撤销移动，核对原文档身份、编辑历史及新保存位置。右键和 Backspace 删除调用真实系统回收站，核对回收站内容及历史恢复；引用经移动、对话切换和重开继续可用。系统文件拖入使用 Chromium 的原生文件拖动协议，走真实复制与引用服务。

夹具保存在 `~/.cache/vibe-logisim-e2e/file-operations-*`，使用独立配置、状态和 XDG 回收站；某些 Linux 系统拒绝对 `/tmp` 的内部挂载执行回收站操作，因此不把删除验收放在 `/tmp`。不启动 Codex，不消耗模型额度。该验证覆盖文件操作与引用传递，不代表模型已阅读这些资料并完成电路任务。
