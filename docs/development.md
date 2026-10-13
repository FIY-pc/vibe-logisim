# 开发

开发分支的应用入口为 `apps/workbench`，使用 Rust、Tauri 2、React 和 TypeScript。已发布的 Electron 应用仍保留在 `apps/desktop`；其开发说明可查阅 [v0.5.0 文档](https://github.com/FIY-pc/vibe-logisim/blob/v0.5.0/docs/development.md)。

## 启动

安装 Node.js 24、rustup 和 JDK 17+，以及 [Tauri 平台依赖](https://v2.tauri.app/start/prerequisites/)。Rust 版本由 `rust-toolchain.toml` 固定。

```sh
npm ci
npm run setup
npm run desktop
```

浏览器开发运行 `npm run dev`。它同时启动 React 开发服务器和本机 Rust 宿主。桌面使用 Tauri IPC；浏览器使用回环地址 HTTP/SSE，两者调用同一应用宿主。

## 修改与验证

- 界面与交互：`apps/workbench/src`。
- 文档、保存和恢复：`crates/workspace-core`。
- 应用命令、会话归属：`crates/workbench-host`。
- 原生元件、连接和仿真：`crates/logisim-adapter`。
- 模型连接、工具与会话：`packages/agent-runtime`。

命令类型在 Rust 中定义；修改后执行 `npm run contracts`，生成 TypeScript 与模型编辑 schema。`npm run check:contracts` 检查生成文件是否一致。

`npm run check` 检查 TypeScript，`npm run test:core` 检查文档边界，`npm run test:native` 使用临时电路、真实 Java 运行时和本地模型夹具检查跨进程行为。`npm run test:ui` 验证 React 的交互状态与异步边界，`npm run test:compatibility` 检查外部库、自定义外观与合成大电路。对话准备、取消、网络和安装器检查使用 `npm run test:runtime`。这些命令不调用远端模型。

开发状态、外部运行时和分发资源不进入 Git。详细配置、持久化边界、分发命令和验证范围见 [工作台开发说明](native-workbench.md)，模块职责见 [架构](architecture.md)。
