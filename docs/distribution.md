# 分发构建

Windows x64 提供当前用户 NSIS 安装程序与便携 zip；Linux x64 提供 Debian 安装包与便携 tar.gz；macOS Apple Silicon / Intel 提供 DMG 和包含 `.app` 的 ZIP。包内包含 Node.js、裁剪 Java、Logisim-ITA、已编译桥接和内置 AI 运行时。人工编辑和仿真不需要模型服务。

## 构建与产物

准备 [开发环境](development.md)，在目标平台执行：

```sh
npm ci
npm run package:desktop
npm run test:product
npm run test:desktop
```

构建脚本下载并校验锁定输入，使用 `jlink` 裁剪 Java，编译桥接，打包 TypeScript 运行时并构建 Tauri。构建只复制明确的产品资源，不包含账户、会话、个人工程或开发机配置。`config/runtime-lock.json` 固定 Java 和 Logisim；`scripts/workbench/runtime-lock.json` 固定 Node.js。

| 平台    | `.workbench-cache/release/` 中的产物      | 启动                       |
| ------- | ----------------------------------------- | -------------------------- |
| Windows | `vibe-logisim-<版本>-win32-x64-setup.exe` | 安装后从开始菜单打开       |
| Windows | `vibe-logisim-<版本>-win32-x64.zip`       | 解压后运行 `start.cmd`     |
| Linux   | `vibe-logisim-<版本>-linux-x64.deb`       | 通过系统包管理器安装后打开 |
| Linux   | `vibe-logisim-<版本>-linux-x64.tar.gz`    | 解压后运行 `./start.sh`    |
| macOS Apple Silicon | `vibe-logisim-<版本>-darwin-arm64.dmg` / `.zip` | 拖入“应用程序”后打开 `.app` |
| macOS Intel | `vibe-logisim-<版本>-darwin-x64.dmg` / `.zip` | 拖入“应用程序”后打开 `.app` |

每个平台另生成 `SHA256SUMS-<平台>.txt`。Tauri 原始安装包保存在 `target/release/bundle/`；本地桌面检查使用 `.workbench-cache/Vibe-Logisim-<平台>` 及同名归档。

Windows 安装程序可安装 WebView2；便携包需要系统已安装 WebView2。Windows 10 1903 及以后支持包内 Java 使用的 UTF-8 进程代码页。Linux CI 在 Ubuntu 24.04 上构建，目标系统需要 GTK 3、WebKitGTK 4.1 和兼容 glibc。Linux AI 命令隔离需要 systemd 用户会话。

macOS 目标为 13.5 及以上（与内置 Node.js 24 的最低系统版本一致），使用系统 WKWebView，按架构分别构建，不能只交叉编译外壳后混用另一架构的 Node/Java。Temurin 的 `Contents/Home` 被裁剪为独立运行时；包内 Mach-O（Node、Java、原生扩展）先签名，Tauri 再签名整个 `.app`。默认使用 ad-hoc 本地签名，适用于开发预览，不等于 Developer ID 签名或 Apple 公证。从网络下载的预览包可能需要在“系统设置 → 隐私与安全性”中批准打开。

正式签名可通过 `APPLE_SIGNING_IDENTITY` 指定已导入当前钥匙串的 Developer ID 证书；应用与所有内置运行时使用同一身份。公证使用 Tauri 的 Apple 公证环境配置。发布正式 macOS 安装包前，应完成 Developer ID 签名、公证，并在下载后的应用上验证 Gatekeeper。

macOS 的 AI 命令使用 `/bin/bash --noprofile --norc`，优先使用包内 Node/Java，不继承模型凭据或 shell 配置。与 Windows 一样，这不是文件系统沙箱；命令拥有当前用户的文件权限。取消、超时和正常退出会结束命令进程组，命令不得自行脱离进程组成为后台服务。系统 HTTP/HTTPS 代理通过 `scutil --proxy` 读取，支持排除列表；PAC/WPAD 和纯 SOCKS 配置会给出不支持的提示。

## 资源与状态

Java 桥接以 JAR 分发，避免“完整运行时摘要 + Java 包目录”让 Windows 自带解压器报 `0x80010135`。Windows 打包会检查内部文件路径不超过 140 字符，为解压位置预留空间；便携版仍建议放在较短目录（例如 `D:\Vibe`）。运行时也兼容旧版解压类目录。

| `workbench/` 资源目录内    | 内容                                   |
| -------------------------- | -------------------------------------- |
| `packages/agent-runtime/`  | 打包的 AI 进程、模型资料和电路参考知识 |
| `config/runtime-lock.json` | Java 与 Logisim 的版本锁定清单         |
| `runtimes/node/`           | Node.js 与许可证                       |
| `runtimes/java/`           | 裁剪 Java 与原有法律声明               |
| `native/`                  | Logisim、桥接源码与预编译类            |
| `third-party/`             | 依赖许可证、包信息与 Logisim 对应源码  |
| `product.json`             | 平台、运行时版本及来源摘要             |

资源整体可移动，缺失时明确失败。应用状态使用 Tauri 应用数据目录，工程源文件属于用户选择的文件夹。`VIBE_WORKBENCH_STATE` 可指定独立状态目录；`VIBE_WORKBENCH_RESOURCES` 可指定完整资源目录。它们都支持含空格和非 ASCII 字符的路径。

模型服务配置存于用户状态目录，不写入分发资源。应用更新只提示，不自动下载安装。

## 检查

`test:product` 将资源与宿主复制到仓库外的临时目录，清除子进程 `PATH` 中的系统运行时，检查包内 Node、Java、编辑和仿真。

`test:desktop` 解压便携包到含空格与非 ASCII 字符的路径，在独立状态中启动实际 Tauri 窗口。它检查前端挂载、IPC、原生逻辑门测试、内置运行时启动和关闭重开后的草稿身份。Linux 需要显示服务，CI 使用 Xvfb。这些检查不发送远端模型请求，也不代替交互体验检查。

macOS 检查从 ZIP 解压 `.app`，验证签名，并在不设置资源路径覆盖的情况下启动真正的包内程序，验证 `Contents/Resources/workbench` 定位。`npm run test:desktop -- --dmg` 另将实际 DMG 只读挂载、复制应用、卸载镜像，再验证启动和恢复。`node scripts/workbench/macos-command-check.mts` 检查真实 bash、中文路径、脚本修改、输出保存和取消/超时；资源构建也会用包内 Node/Java 再运行此检查。

Windows CI 还运行 `node scripts/workbench/verify-portable-paths.mts`，通过 Windows 自带 ZIP 组件将便携包解压到较深的目录，检查内部路径预算及 JAR 分发，再验证解压后的应用启动、仿真与重启恢复。

Windows CI 另从相同源码构建版本 `0.0.0` 的安装器，实际安装、升级到当前版本、重开、检查草稿恢复并卸载。必须先在同一任务中构建并验证当前版本；基线复用已经验证的产品资源和前端，只重新编译版本信息并生成安装器，避免重复下载、裁剪运行时和执行命令回归。它验证安装器升级流程，不代表历史版本数据迁移兼容性。检查使用正常资源查找，不覆盖用户的安装与状态目录。此脚本只能在临时 Windows CI 环境运行：

```sh
node scripts/workbench/package.mts --upgrade-baseline
npm run test:windows-install
```

`VIBE_WORKBENCH_INSTALL_CHECK` 只供上述检查使用，并要求显式绝对状态路径。正常启动不运行合成电路检查。

## CI 与发布

[Workbench 工作流](../.github/workflows/native-workbench.yml) 是唯一构建与发布入口。所有 PR 和主分支推送都执行契约、Rust、TypeScript、UI、原生工具、Windows 运行时与长路径状态检查；桌面检查按变更范围分层，保留可下载包与精简检查报告，不使用付费模型。

| 变更或触发方式 | 桌面检查 |
| --- | --- |
| 仅 `apps/workbench/src/`、`docs/` 或 `README.md` | Linux x64、macOS ARM 打包、资源搬移、真实启动和重启恢复；保留 macOS DMG 检查 |
| 包含其他路径，包括原生代码、AI 运行时、依赖、构建脚本、CI 配置或未知目录 | 上述检查，加 Windows x64 便携包/安装/升级/卸载与 macOS Intel 完整检查 |
| 发布标签或默认手动运行 | 四个平台完整检查 |

范围判断读取实际 Git diff，重命名同时考虑旧、新路径，不能取得有效比较基线时使用完整矩阵。手动运行可取消 `full_desktop` 来复现常规两平台流程，但发布标签始终执行完整矩阵。同一 PR 的新提交会取消过期运行；主分支、发布与手动运行不会被自动取消。

Rust 依赖使用 `Swatinem/rust-cache`，缓存按工具链、依赖和平台区分，不再每个提交保存一份完整副本。PR 也保留已编译依赖，包括后续测试或资源下载失败的情况，让失败重跑和后续提交能继续复用；缓存可见范围由 GitHub 的分支隔离规则控制。产品资源、安装包和用户状态均不缓存。首次运行或依赖变化时仍可能冷编译。

版本采用 `年.月.当月发布序号`，例如 `26.11.1`、`26.11.2`、`26.12.1`。每次发布递增序号，新功能和修复可以在同一版本交付。常规发布不使用 beta 或 rc 后缀；开发预览使用 PR 构建产物。

发布前执行：

```sh
npm run release:version -- 26.11.1
# 编写 docs/releases/v26.11.1.md 后检查
npm run release:version -- --check
```

该命令统一更新所有 npm 工作区、npm/Cargo 锁文件、Rust 工作区和 Tauri 配置。发布说明以最近一次发行版为比较基线，按“新增、改进、修复、升级说明”组织；没有内容的栏目省略。说明用户可见的变化、适用范围和必要的升级操作，避免内部实现过程、未经验证的效果描述及宣传用语。

版本提交合入主分支后，推送指向该提交的 `v<版本>` 标签。工作流检查版本一致性和发布说明，在集成、桌面启动、重启与安装升级检查通过后发布八个安装/归档产物与 `SHA256SUMS`。只有标签推送触发发布，手动运行工作流只构建和检查。已发布的标签和同名附件不覆盖，后续修复使用新版本。

每个安装包和便携包都包含 Logisim 对应源码与依赖许可证，详见 [第三方组件](../THIRD_PARTY.md)。历史版本的实现与说明保存在对应 Git 标签。
