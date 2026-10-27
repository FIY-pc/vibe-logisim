# 画布渲染

一句话：Java 只回答「每种元件长什么样」和仿真，编辑器的静态画面由窗口用 Canvas2D 自己合成；运行中的仿真画面仍是 Java 的 PNG 帧，盖在静态画面上。外观仍然 100% 由 Logisim 自己的 `Component.draw` 产生（课程 jar 里的元件也是），只是每种元件录一次、按种类缓存，不再每次出一张位图。

## 谁画什么

| 内容 | 谁画 | 从哪来 |
| --- | --- | --- |
| 元件 | 窗口回放录下的矢量指令 | 宿主 `symbols`：每个 (library, name, attributes) 一份 `{bounds, ink, ports, ops}`，相对元件位置（指令表和录制器见 [logisim-runtime README](../crates/logisim-runtime/README.md) 的 Symbols 一节） |
| 导线、交点 | 窗口按 `CircuitWires.draw` 的规则直接画 | 文档视图里的导线端点 |
| 线宽冲突的导线 | 窗口画成 `#ff7b00`（Logisim 的 `Value.WIDTH_ERROR_COLOR`） | 编辑、撤销、重做回复里的 `widthErrors`（每个改动的电路一份），和新画面同一帧画；还没有回复带过的电路（刚打开、重读）由第一次 `symbols` 带 |
| 网格 | canvas 下面的 SVG | — |
| 选择框、端口标记、布线中的线、框选、移动时的改线 | canvas 上面的 SVG 交互层 | 窗口状态、`movePreview` |
| 运行中的仿真 | Java 的 PNG 帧（SVG `<image>`，盖住 canvas 的同一块区域） | `simulationFrameImage` |
| 给 AI 看的图（`render`、`interfaceRender`、`historyPreview`） | Java 的 PNG（`CircuitRenderer`） | 不变 |

导线规则：每条导线一条宽 3 的黑线（圆头圆角）；一个点上导线端数 + 2×从中间穿过的导线数 + 元件端口数 > 2，且至少有一条导线到这里，就画一个 8×8 的实心圆点。

## 代码

都在 `apps/workbench/src/editor/`：

- `symbols.ts`：符号缓存和请求（`useSymbols`、`symbolId`、`templateKey`、`keepSymbols`）。
- `paint.ts`：把指令编译成 `Program`、`buildScene`（元件、导线、交点、包围盒、端口）、`paintFrame`（画一帧）。
- `CanvasPicture.tsx`：`<canvas>`；帧变了就在下一个动画帧画，一帧里变多少次都只画一次；设备像素比变化、录下的图片加载完都会重画。
- `geometry.ts`：命中测试、框选、适合视图，全读 scene 里的包围盒（来自符号的 `bounds`；种类还不知道时用 `fallbackBounds`）。
- `useConnections.ts`：连接面板和信号追踪要用时才发 `connections`，只读选中对象和追踪点所在的网络。
- `usePlacementQueue.ts`：放置的点击排队提交。
- `Canvas.tsx`：交互（指针、键盘、工具、拖动、提交）和把上面这些拼成一帧。

## 一帧怎么画

`paintFrame(canvas, frame, dpr)`：

- `k = view.scale × dpr` 是每个单位的设备像素数；原点 `(-view.x·k, -view.y·k)` 取整到整设备像素，100% 时和 Logisim 自己的像素格对齐。
- 墨迹盒（`ink`，指令可能碰到的范围）在视口外的元件不画。
- 填充、文字、图片在符号空间回放（`setTransform(k, 0, 0, k, x, y)`）。
- 描边在设备空间建路径，按 Java2D 抗锯齿描边的规整化（stroke normalization，JDK 21 的 Marlin 实测）摆点：路径上每个点移到它所在设备像素的中心 `floor(d) + 0.5`；二次曲线的控制点平移前后两个端点调整量的平均，三次曲线的第一个控制点跟前一个端点、第二个跟后一个端点；闭合后当前调整量回到起点的。填充不规整化。导线中心同样取 `floor(d) + 0.5`，交点圆点不取整。描边路径因此和原点的亚像素相位有关，按 (k, 相位) 缓存在 `Program` 上，k 变了清空；同一缩放下拖动只多一两份。
- 矩形、圆角矩形、椭圆、弧按 Java 的路径迭代器（`RectIterator`：M 加四段 L 回到起点再 Z；`RoundRectIterator`、`EllipseIterator` 的 KAPPA 控制点、`ArcIterator` 每段不超过 90°）展开成同样的点，再规整化，所以描边落在和 Logisim 一样的像素上。
- Java 的 0 宽描边画成 1 个设备像素；虚线长度和相位乘 k。
- `U` 指令：形状门的输入线只在那一点有连接时才画（Logisim 打印视图的行为）。`buildScene` 按文档算：那一点的导线端、穿过的导线、别的元件端口，去掉这个元件自己的端口后大于 0 才画。
- 文字：Java 的逻辑字体 Dialog/SansSerif 换成平台的 sans（Windows Arial + SimSun，macOS Lucida Grande，其他 fontconfig 的 sans-serif），`(x, y)` 是基线左端。Java 有 hinting 和整数字宽，浏览器没有，文字会差一两个像素；中文字形高低差 1 px。接受。Logisim 在非 100% 时按当前缩放重新量文字，这里等比缩放，放大和高 DPI 下反而更清楚。
- 画不出来的种类（`symbols` 回了 `{error}`）在它的大概位置画红色虚线框。
- 运行中的仿真帧盖住的区域 canvas 不画（`frame.cover`）。

100% 下和 Logisim 自己画的位图（`CircuitRenderer` 在 scale 1 出的 PNG）逐像素比：文字之外有差的像素在 126 万里约 120–150 个，剩下的是字体光栅化。

## 缓存与失效

- 键：`JSON [library 或 "", name, 按名字排好的属性]`（`symbolId`）。缓存按文档 id 分开（`DocumentSymbols`）；`paletteIdentity` 变了整份丢；文档不在打开列表里了也丢（`editor/actions.ts` 的 `watchSymbols` 跟着打开的文档调 `keepSymbols`）。
- 子电路的符号（library 为空）记着录它时的电路定义对象。编辑回复的 `DocumentChange` 里出现的电路会换成新对象，于是用它的实例的符号算缺失、重新问；新答复到之前继续用旧图（`latest`），不闪。
- `symbols` 只在缺种类时发：当前电路所有元件，加放置幻影和排队中放置的模板键（`extra`），只带缺的键。一个电路还没有回复带过线宽冲突（刚打开、重读）时，一个不缺也发一次，为了它的 `widthErrors`。打开一页是一次往返；之后编辑一次只有编辑本身的请求，出了新种类才多一次 `symbols`。
- 请求失败：这些键在这个修订内不再问，下个修订再问。被拒 `STALE_REVISION` 且窗口还停在那个修订，调 `onStale`（`CanvasRegion` 重读工作区，不报错）；别的错误报出来。
- 一个电路第一次显示，等它所有种类都答复过一次再画、再适合视图，不出半张图；之后的改动不等。

## 编辑时画面怎么变

- 平移缩放：只改视口，下一帧重画，不发任何请求，没有去抖，没有「正在绘制」。
- 提交的编辑（连线、删除、移动）：手势的结果（新线、隐藏删掉的对象、移到新位置的对象）立刻画在当前修订上，编辑回复（只带改动电路的 `DocumentChange`）到了就换成新修订的画面。线宽冲突的点在回复里，和新画面一起变色。种类变了的元件（改属性、放了新种类）等为新种类发的那次 `symbols`，期间用旧图。
- 移动：拖动中选中的元件和导线按位移画在新位置；`movePreview`（每帧至多一个，同时只有一个在路上，见 `useMovePreview.ts`）回来 Java 做完连通检查的改线：要删的线不画，要加的线用强调色画在交互层。松手发 `edit move`。
- 放置：幻影画模板键的符号（`template` 不再回 PNG，窗口把幻影的键并进 `symbols` 请求）。每次点击排队，按顺序从上一个放置产生的修订提交，提交完成前幻影留在点的位置。
- 撤销、重做、AI 的改动：和编辑回复一样，`DocumentChange` 到了就画。

## observe 不在出图路径上

画面、命中测试、端口标记、适合视图、连接面板都不读 observe。连接面板和信号追踪读 `connections`（`useConnections`）：请求带选中元件和导线的 id、追踪点击的位置，回答是 observe 的 focus 里这些对象要的那部分（它们所在的位网络、网络上的元件端口、经过的导线束和导线，见 [logisim-runtime README](../crates/logisim-runtime/README.md) 的 Connections 一节）；同一修订里每个种子只读一次，答复累加，不挡画面；被拒 `STALE_REVISION` 同样走 `onStale`。整页 observe 只剩 AI 的工具、窗口的「整理」和对话里的观察引用在读。

## 数字

Release 宿主，生产构建，headless Chrome 1600×1000，课程工程的 713 件页面：

- 打开页面：一次 `symbols`，369 种、请求 60 KB、回复 175 KB（gzip 13 KB），宿主 11–28 ms；点击到画面出现 63–72 ms（dpr 1 / 2，含第一次编译符号的 20–27 ms）。
- 平移缩放：适合视图和 100% 下都是 60 fps（dpr 2），主线程每帧 3–6 ms；100% 时画一帧 0.4–0.6 ms。
- 编辑，从输入到新画面画进 canvas：手势结果在下一帧（3–14 ms）；带上回复的画面：连线 36–39、删除 32–35、放置 49、改属性 46–67、撤销 43–44 ms，移动 76–94 ms（拖动中已经画在新位置）。其中回复到画完 10–25 ms（解析 200 KB 的 `DocumentChange`、React 更新、等下一帧）。这组是线宽冲突并进回复之前量的，回复现在多 4–10 ms（下面）。
- 选中一个元件：一次 `connections`，3–72 KB（寄存器一类端口多的元件最大），宿主 2–4 ms，这个修订第一次读要先建网络索引，再多 5–7 ms；以前是整页 observe，3.6 MB、宿主 140 ms（同修订再读 17–21 ms），窗口还要解析 3.6 MB。（调试宿主、Vite 开发服务器量的。）

`scripts/workbench/editing-latency.mts`（合成的课程尺寸工程，350 件页 / 713 件页，p50）：编辑一次一个请求，回复到了就是带线宽冲突的完整新画面：移动 32 / 47、连线 19 / 23、放置 25 / 27、删除 16 / 19 ms；改属性出了新种类，加上那次 `symbols` 共 26 / 32 ms；整页 `symbols` 6 / 11 ms（220 / 446 种，89 / 184 KB）。回复里多的 4–10 ms 是让 worker 跟上新修订、算冲突（读文件 2、就地应用 3–5、`width-errors` 不到 1 ms；移动本来就要 worker 做连通检查，只多 1 ms），以前这一步在之后为冲突发的那次 `symbols` 里：那时回复先到（连线 12 / 14、放置 16 / 19、删除 11 / 14、改属性 16 / 21 ms），冲突颜色要到连线 19 / 25、放置 24 / 31、删除 17 / 23、改属性 24 / 32 ms 才对。选中一个元件的 `connections` 6 / 10 ms、9 / 13 KB，同修订再选 2 / 3 ms；整页 observe 40 / 75 ms。改这条路径之前（编辑 + 视口 PNG）是 60 / 79、45 / 51、56 / 55、44 / 48、53 / 58 ms，还不含 webview 解码 PNG。

## 测量

```sh
cargo build --release -p vibe-workbench-host
VIBE_WORKBENCH_RESOURCES="$PWD" VIBE_VERIFY_HOST="$PWD/target/release/vibe-workbench-host" \
  node scripts/workbench/editing-latency.mts 10            # 350 件页
VIBE_WORKBENCH_RESOURCES="$PWD" VIBE_VERIFY_HOST="$PWD/target/release/vibe-workbench-host" \
  node scripts/workbench/editing-latency.mts 10 core_c     # 713 件页
```

宿主带 `VIBE_WORKBENCH_TIMING=1` 时每个请求在 stderr 打一行 `timing <op> <总>ms <阶段>=<ms> …`，脚本最后汇总各阶段 p50。窗口一侧的帧率和输入到出图要在真实浏览器里量：浏览器预览窗格不在前台时 `requestAnimationFrame` 被节流到 4 fps 甚至暂停，量不准，用 headless Chrome（playwright-core）开生产构建（`vite preview`，宿主要用 `VIBE_WORKBENCH_DEV_PORT` 放行它的端口）。

## 还没做

- 仿真画面也由窗口画（第二阶段）：导线和元件的运行值换成窗口画，Java 只给值。现在运行中仍是整块视口的 PNG 帧，视口变化后 100 ms 才向宿主报告新视口。
- 选中对象一直留着时，每次编辑之后为新修订再读一次 `connections`（小请求，在回复之后，不挡画面）。
- 外部 jar 内容变了而 `<lib>` 没变时 `paletteIdentity` 不变，窗口不会丢那份缓存（宿主会重启 worker）；画不出的种类也一直缓存到调色板变化。
