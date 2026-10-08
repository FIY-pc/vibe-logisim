# 独立桌面应用包

普通使用者解压一个包，打开 `vibe-logisim`，即可打开文件夹、创建或编辑电路、运行仿真、预览资料。无需安装 Node、Python、Java、Codex、Logisim 或 Poppler。AI 面板提供 ChatGPT 登录和取消入口，浏览器完成登录后自动更新连接；退出登录在 AI 设置里。未登录不影响人工编辑和仿真。

提供 Windows x64 与 Linux x64 压缩包，两平台由 CI 分别运行打包程序验收。Linux 仍需桌面图形库（Electron 的 GTK/NSS 等）、glibc，AI 隔离需要 systemd 用户服务。macOS 暂无分发包；当前包未签名，版本更新仅提示，不自动安装。

## 构建

在开发机准备 Node、Python 3.12+，并执行 `npm --prefix apps/desktop ci`。构建器固定版本和 SHA-256，第一次构建下载运行环境，应用使用时不下载运行环境。课程运行文件必须由构建者显式提供：

```sh
python3 scripts/distribution/build.py \
  --output /tmp/vibe-release \
  --course-runtime workspaces/hust-riscv/original/course-package/logisim-ita-cn-20200118.exe
```

默认输出 `vibe-logisim-<版本>-linux-x64.tar.gz` 和 SHA-256 文件，版本来自 `apps/desktop/package.json`。传入 `--target win32-x64` 构建 Windows ZIP。默认缓存 `/tmp/vibe-distribution-cache`，可用 `--cache` 更改；`--unpacked` 只生成应用目录，便于先验收再压缩。构建拒绝覆盖已有产物。

构建器只选择产品目录中的源码和明确列出的第三方文件，不复制整个仓库、开发机的环境、账户、会话或个人电路。`runtime-lock.json` 是运行环境输入清单，npm 锁文件固定 Electron、PDF.js、elkjs；产物另有版本来源和文件摘要清单。当前锁定的 Logisim-ITA 发布物与开发机已有运行文件摘要一致。

## 运行边界

| 包内位置 | 职责 |
| --- | --- |
| `resources/app/electron/` | 桌面宿主与受限 PDF 预览进程 |
| `resources/product/` | 电路服务、界面、Java 桥接源码和两种 Logisim 运行文件 |
| `resources/runtime/python/` | 独立 CPython，不加载用户的 Python 包或 PYTHONPATH |
| `resources/runtime/java/` | Temurin JDK，负责 Java 运行及按运行时摘要编译桥接 |
| `resources/runtime/codex/` | 官方 Codex 完整运行包，含 code mode host 等配套程序 |
| `resources/third-party/` | 来源说明及 Logisim-ITA 对应发布标签源码 |

`runtime-paths.cjs` 是开发环境与独立包的唯一切换点。独立包缺文件时明确失败，不回退到用户机器上的另一个版本。应用与工具可整体移动；缓存、Java 编译输出、对话与账户存入用户数据目录，工作区源码仍属于用户选定的文件夹。开发启动保持既有状态目录和登录来源。

分组布局的 elkjs 随产品放在 `resources/product/apps/desktop/node_modules/elkjs/`，包含求解器、包信息与许可证。Python 服务通过 `VIBE_LOGISIM_LAYOUT_NODE` 调用应用自身的 Electron（Node 模式），无需系统 Node 或运行时下载依赖。

`agent-process.cjs` 负责 Linux 进程隔离。AI 读写用户工作目录；包内工具只读挂载。独立应用拥有自己的登录，不复制或共享开发机的轮换认证文件。Linux 独立包的应用数据位于 `$XDG_CONFIG_HOME/vibe-logisim`（默认 `~/.config/vibe-logisim`），与开发版 `vibe-logisim-desktop` 的账户和会话映射分离。开发环境依旧沿用原有本机 Codex 配置。此处没有缩减直接文件编辑、脚本或可选电路工具的能力。

PDF.js 在没有 Node 权限、无远程网络的独立 Chromium 进程里渲染 PDF 和提取文字，支持翻页、引用和失败后重试；不再调用系统 Poppler。长时间未返回的预览会终止，原资料保留。

## 验收

跨平台冒烟（Linux 或 Windows 都能跑，CI 使用的就是它）：

```sh
node apps/desktop/test/e2e-smoke-packaged.cjs /path/to/vibe-logisim-<版本>-<目标>/vibe-logisim[.exe] [输出目录]
```

它在全新应用状态下启动打包程序：使用包内 Python 与 Electron 运行分组布局，打开文件夹、新建电路、放置与门和引脚、连线，实际 Ctrl+点击追踪来源并返回，用内置 Java+Logisim 跑四组真值、关闭重开、打开 AI 设置并导出诊断包。不发送模型请求。Windows 核对内置 Codex 到达登录/就绪状态；Linux 无 systemd 用户会话的 CI 容许 AI 显示不可用，不把该环境计作 AI 隔离路径通过。

Linux 上更完整的验收（含 PDF 预览与登录 URL 拦截）：

```sh
node apps/desktop/test/e2e-packaged.cjs /path/to/vibe-logisim-<版本>-linux-x64/vibe-logisim
```

脚本在仓库外、全新应用状态和包含空格的文件夹运行真正的打包程序。将系统 Python、Java、Codex、Poppler 命令设为调用即失败；从 UI 放元件、连线、切换输入、核对与门四种真值、关闭重开，再从文件树打开两页 PDF 并检查图像和文字。还通过真实内置 App Server 发起/取消登录，仅拦截浏览器打开，不提交凭据或发起模型生成。报告和截图留在脚本返回的临时目录。

这些证据覆盖一个真实的小电路任务和本机打包环境，不能代替干净发行版矩阵测试、完成登录后的模型构建质量或复杂课设验收。

## 发布

发布前在独立分支准备应用版本、README、`docs/releases/v<版本>.md` 和相关源码，通过 PR 的双平台构建与冒烟取得可检查的产物。PR 检查不运行付费模型回合。

正式发布时先准备同名 GitHub Release，再推送 `v*` 标签；`bundle` 工作流在 Windows 单元检查及两个目标的构建、实际程序冒烟通过后上传压缩包和 `.sha256`。课程运行文件不进 git，由 CI 从 `build-inputs` 预发布下载并校验 SHA-256。工作流的 main / tag / 手动触发还可能在配置了 `VIBE_TEST_*` secrets 时运行付费 AI 冒烟，发布者应明确这项额度使用。

项目源码为 GPL-3.0。标准 Logisim-ITA 为 GPL-3.0，包内附对应标签源码；CPython、Temurin、Codex（Apache-2.0）、PDF.js（Apache-2.0）的许可证保留在各自目录。课程发布的 `logisim-ita-cn-20200118.exe` 按课程原样附带、不作修改，由 Java 当作 jar 加载；它的对应源码没有随课程发布，这一点在 THIRD_PARTY.md 中如实记录。
