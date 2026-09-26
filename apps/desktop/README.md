# Vibe Logisim Desktop

产品介绍见 [仓库首页](../../README.md)，安装与验证见 [开发说明](../../docs/development.md)。

```sh
npm --prefix apps/desktop ci
apps/desktop/run
```

启动脚本可以直接接收工作区文件夹或 `.circ` 文件。传入文件夹时恢复该文件夹自己的“当前电路”；传入 `.circ` 时打开指定文件，不会因为参数无法识别而退回到上一次打开的工程。

```sh
apps/desktop/run <课程文件夹>
apps/desktop/run <课程文件夹>/cpu21-riscv.circ
```

桌面入口为 `electron/main.cjs`。Electron 管理本地文件夹、窗口、文件预览及 Codex 进程；`circuit-lens/studio` 管理电路文档、原生渲染、编辑与运行；`circuit-lens/web` 是共享的操作界面。

Electron 和本地服务共享界面，但浏览器入口不能代替桌面的文件系统与 AI 能力。工作区资料直接来自用户打开的本地文件夹。
