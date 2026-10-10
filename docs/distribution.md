# 独立桌面应用包

Windows 使用安装程序，Linux 解压后打开 `vibe-logisim`，即可打开文件夹、创建或编辑电路、运行仿真、预览资料。无需安装 Node、Python、Java、Codex、Logisim 或 Poppler。AI 面板提供 ChatGPT 登录和取消入口，浏览器完成登录后自动更新连接；退出登录在 AI 设置里。未登录不影响人工编辑和仿真。

提供 Windows x64 安装程序与 Linux x64 压缩包，两平台由 CI 分别运行打包程序验收。Linux 仍需桌面图形库（Electron 的 GTK/NSS 等）、glibc，AI 隔离需要 systemd 用户服务。macOS 暂无分发包；当前包未签名，版本更新仅提示，不自动安装。

## 构建

在开发机准备 Node、Python 3.12+，并执行 `npm --prefix apps/desktop ci`。构建器固定版本和 SHA-256，构建时下载核心运行环境；内置 AI 运行时随包提供，Codex 在首次选择时下载。课程运行文件必须由构建者显式提供：

```sh
python3 scripts/distribution/build.py \
  --output /tmp/vibe-release \
  --course-runtime workspaces/hust-riscv/original/course-package/logisim-ita-cn-20200118.exe
```

默认输出 `vibe-logisim-<版本>-linux-x64.tar.xz` 和 SHA-256 文件，版本来自 `apps/desktop/package.json`。传入 `--target win32-x64` 在 Windows 上构建 NSIS 安装程序；支持当前用户安装、开始菜单快捷方式和卸载。卸载保留账户和会话。默认缓存 `/tmp/vibe-distribution-cache`，可用 `--cache` 更改；`--unpacked` 支持跨平台生成应用目录，便于先验收再压缩。构建拒绝覆盖已有产物。

构建器只选择产品目录中的源码和明确列出的第三方文件，不复制整个仓库、开发机的环境、账户、会话或个人电路。`runtime-lock.json` 是运行环境输入清单，npm 锁文件固定 Electron、PDF.js、elkjs；产物另有版本来源和文件摘要清单。当前锁定的 Logisim-ITA 发布物与开发机已有运行文件摘要一致。

## 运行边界

| 包内位置 | 职责 |
| --- | --- |
| `resources/app/electron/` | 桌面宿主与受限 PDF 预览进程 |
| `resources/product/` | 电路服务、界面、Java 桥接源码和两种 Logisim 运行文件 |
| `resources/runtime/python/` | 独立 CPython，不加载用户的 Python 包或 PYTHONPATH |
| `resources/runtime/java/` | Temurin JDK，负责 Java 运行及按运行时摘要编译桥接 |
| `resources/codex-runtime.json` | 可选 Codex 的版本、平台、下载地址、SHA-256 与程序清单 |
| `resources/third-party/` | 依赖许可证、来源说明及 Logisim-ITA 对应源码下载说明 |

`runtime-paths.cjs` 是开发环境与独立包的唯一切换点。独立包缺文件时明确失败，不回退到用户机器上的另一个版本。应用与工具可整体移动；缓存、Java 编译输出、对话与账户存入用户数据目录，工作区源码仍属于用户选定的文件夹。开发启动保持既有状态目录和登录来源。

分组布局的 elkjs 随产品放在 `resources/product/apps/desktop/node_modules/elkjs/`，包含求解器、包信息与许可证。Python 服务通过 `VIBE_LOGISIM_LAYOUT_NODE` 调用应用自身的 Electron（Node 模式），无需系统 Node 或运行时下载依赖。

`agent-process.cjs` 负责 Linux 进程隔离。AI 读写用户工作目录；包内工具只读挂载。独立应用拥有自己的登录，不复制或共享开发机的轮换认证文件。Linux 独立包的应用数据位于 `$XDG_CONFIG_HOME/vibe-logisim`（默认 `~/.config/vibe-logisim`），与开发版 `vibe-logisim-desktop` 的账户和会话映射分离。开发环境依旧沿用原有本机 Codex 配置。此处没有缩减直接文件编辑、脚本或可选电路工具的能力。

Codex 首次使用时按清单下载到用户数据目录的 `runtimes/codex/<摘要前缀>`。下载使用应用的系统代理设置，显示实际接收字节；可取消或重试。归档必须通过 SHA-256 校验后才解压，并拒绝路径穿越、链接与特殊文件。完整安装后才原子替换运行目录，重启复用已安装版本。中断或失败不会清除账户和会话，也不阻塞画图、仿真和查看历史。

PDF.js 在没有 Node 权限、无远程网络的独立 Chromium 进程里渲染 PDF 和提取文字，支持翻页、引用和失败后重试；不再调用系统 Poppler。长时间未返回的预览会终止，原资料保留。

## 验收

打包检查通过 `VIBE_LOGISIM_USER_DATA_DIR` 指定独立的绝对路径，并核对实际用户目录；不继承个人配置。Windows 的系统应用目录不会因修改 `APPDATA` 环境变量而改变，因此不能只依赖该变量隔离检查。正常启动未设置此项时，仍使用原有应用目录。

跨平台冒烟（Linux 或 Windows 都能跑，CI 使用的就是它）：

```sh
node apps/desktop/test/e2e-smoke-packaged.cjs /path/to/vibe-logisim-<版本>-<目标>/vibe-logisim[.exe] [输出目录]
```

它在全新应用状态下启动打包程序：使用包内 Python 与 Electron 运行分组布局，打开文件夹、新建电路、放置与门和引脚、连线，实际 Ctrl+点击追踪来源并返回，用内置 Java+Logisim 跑四组真值、关闭重开、打开 AI 设置并导出诊断包。不发送模型请求。新安装默认进入内置运行时，无需下载 Codex。

内置 AI 和按需下载的界面验收使用本地 HTTP 服务，不调用远端模型：

```sh
node apps/desktop/test/e2e-runtime-packaged.cjs /path/to/vibe-logisim[.exe] [输出目录]
node scripts/distribution/test-sdk.cjs
node --test apps/desktop/electron/runtime-installer.test.cjs
```

显式验证官方 Codex 下载、真实进程启动、登录 URL、取消登录和重启复用（会下载公开的运行包，不提交账号凭据或发送模型请求）：

```sh
node apps/desktop/test/e2e-runtime-download.cjs /path/to/vibe-logisim[.exe] [输出目录]
```

构建会输出 `.size.json`，记录逻辑文件大小、各部分占用和下载字节。`check_size.py` 设置体积上限，防止完整 Codex 或开发依赖再次进入主包。Windows CI 还检查安装、覆盖安装、开始菜单入口和卸载后保留应用数据。

这些证据覆盖一个真实的小电路任务和本机打包环境，不能代替干净发行版矩阵测试、完成登录后的模型构建质量或复杂课设验收。

## 发布

发布前在独立分支准备应用版本、README、`docs/releases/v<版本>.md` 和相关源码，通过 PR 的双平台构建与冒烟取得可检查的产物。PR 检查不运行付费模型回合。

正式发布时先准备同名 GitHub Release 草稿，再推送 `v*` 标签；`bundle` 工作流在 Windows 单元检查及两个目标的构建、实际程序冒烟通过后上传压缩包和 `.sha256`；核对附件后再公开草稿。同名附件不会自动覆盖。课程运行文件不进 git，由 CI 从 `build-inputs` 预发布下载并校验 SHA-256。付费 AI 冒烟仅在手动运行工作流并启用 `run_ai` 时使用 `VIBE_TEST_*` secrets；普通推送与标签不消耗模型额度。

项目源码为 GPL-3.0。标准 Logisim-ITA 为 GPL-3.0，对应标签源码作为同一 Release 的独立附件提供；CPython、Temurin、Codex（Apache-2.0）、PDF.js（Apache-2.0）的许可证随核心包保留。课程发布的 `logisim-ita-cn-20200118.exe` 按课程原样附带、不作修改，由 Java 当作 jar 加载；它的对应源码没有随课程发布，这一点在 THIRD_PARTY.md 中如实记录。

内置运行时的 Pi SDK 及生产依赖由 esbuild 从锁定依赖打包为 `builtin-sdk.mjs`，依赖许可证保留在 `third-party/node`，启动时不下载。ChatGPT 登录继续走 Codex；既有会话不自动迁移。Linux 内置命令使用 systemd 隔离，Windows 内置运行时暂提供文件和电路工具，不执行任意命令。

安装包的 `e2e-runtime-packaged.cjs` 使用全新应用数据和本地 HTTP 响应，检查首次连接、SDK 流式回答、重启、服务默认值及跨运行时恢复旧会话；它不调用远端模型。
