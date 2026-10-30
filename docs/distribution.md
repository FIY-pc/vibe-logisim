# 分发构建

Windows x64 提供当前用户 NSIS 安装程序与便携 zip；Linux x64 提供 Debian 安装包与便携 tar.gz。包内包含 Node.js、裁剪 Java、Logisim-ITA、已编译桥接和内置 AI 运行时。人工编辑和仿真不需要模型服务。

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

每个平台另生成 `SHA256SUMS-<平台>.txt`。Tauri 原始安装包保存在 `target/release/bundle/`；本地桌面检查使用 `.workbench-cache/Vibe-Logisim-<平台>` 及同名归档。

Windows 安装程序可安装 WebView2；便携包需要系统已安装 WebView2。Windows 10 1903 及以后支持包内 Java 使用的 UTF-8 进程代码页。Linux CI 在 Ubuntu 24.04 上构建，目标系统需要 GTK 3、WebKitGTK 4.1 和兼容 glibc。Linux AI 命令隔离需要 systemd 用户会话。macOS 暂无分发包。

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

Windows CI 还运行 `node scripts/workbench/verify-portable-paths.mts`，通过 Windows 自带 ZIP 组件将便携包解压到较深的目录，检查内部路径预算及 JAR 分发，再验证解压后的应用启动、仿真与重启恢复。

Windows CI 另从相同源码构建版本 `0.0.0` 的安装器，实际安装、升级到当前版本、重开、检查草稿恢复并卸载。检查使用正常资源查找，不覆盖用户的安装与状态目录。此脚本只能在临时 Windows CI 环境运行：

```sh
node scripts/workbench/package.mts --upgrade-baseline
npm run test:windows-install
```

`VIBE_WORKBENCH_INSTALL_CHECK` 只供上述检查使用，并要求显式绝对状态路径。正常启动不运行合成电路检查。

## CI 与发布

[Workbench 工作流](../.github/workflows/native-workbench.yml) 是唯一构建与发布入口。PR 和主分支推送执行契约、Rust、TypeScript、UI、原生工具和双平台打包检查，保留可下载包与精简检查报告；不发布 Release，也不使用付费模型。

发布时同步根目录及两个 npm 工作区的 `package.json`、`package-lock.json`、`Cargo.toml` 的工作区版本和 Tauri 配置，提交非空的 `docs/releases/v<版本>.md`，再推送同名 `v<版本>` 标签。工作流拒绝版本不一致或发布说明缺失；所有集成、桌面启动、重启与安装升级检查通过后，才下载双平台产物，核对四个预期文件名与 SHA-256，生成合并的 `SHA256SUMS` 并上传 GitHub Release。只有标签推送触发发布，手动运行工作流只构建和检查。不存在的 Release 按标签创建，带预发行后缀的标签标记为预发行；已有 Release 保留其草稿/公开状态，不覆盖同名附件。

每个安装包和便携包都包含 Logisim 对应源码与依赖许可证，详见 [第三方组件](../THIRD_PARTY.md)。历史版本的实现与说明保存在对应 Git 标签。
