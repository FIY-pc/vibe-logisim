# 第三方组件

本项目源码以 GPL-3.0 发布（见 LICENSE）。Logisim 桥接代码需要外部 Logisim 运行文件及课程组件库；它们未包含在源码中，其原有许可不因本仓库的许可证而改变。安装位置和兼容版本见 [开发说明](docs/development.md)。

前端使用锁文件固定版本的 Marked、DOMPurify 和 Lucide。生成的本地资源及各自许可证一起保存在 `apps/desktop/circuit-lens/web/vendor/`；`scripts/ui/vendor.cjs` 从安装的 npm 包重新生成这些资源。

Electron 和 Playwright 通过 npm 安装，依赖包中保留各自许可证。

独立应用包另包含 [CPython 独立构建](https://github.com/astral-sh/python-build-standalone)、[Eclipse Temurin](https://github.com/adoptium/temurin21-binaries)、[官方 Codex 运行包](https://github.com/openai/codex/releases/tag/rust-v0.154.0) 和 [PDF.js](https://github.com/mozilla/pdf.js)。版本与下载摘要由 `scripts/distribution/runtime-lock.json` 和 npm 锁文件固定；程序许可证保留在各自运行目录，Codex 的 Apache-2.0 许可证另行随包附带。PDF.js 为 Apache-2.0；其浏览器资源无需可选 Node canvas 组件。

[Logisim-ITA v2.16.2.2](https://github.com/Logisim-Ita/Logisim/releases/tag/v2.16.2.2) 的上游标注 GPL-3.0；本地验收包同时保存该标签的源码归档，内含许可证。课程发布的 HUST 修改版运行文件 `logisim-ita-cn-20200118.exe` 按课程原样附带、不作修改，由 Java 作为 jar 加载；课程没有随它发布对应源码。它是课程给全体学生的公开教学材料，本项目只是把它和编辑器放在一起分发，如课程组提出要求会随时移除并改为让用户自行放置该文件。详见 [分发说明](docs/distribution.md)。
