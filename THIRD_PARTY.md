# 第三方组件

本项目的 Logisim 桥接代码需要外部 Logisim 运行文件及课程组件库；它们未包含在此次源码提交中，也不因本仓库将来选择许可证而改变其原有许可。安装位置和兼容版本见 [开发说明](docs/development.md)。

前端使用锁文件固定版本的 Marked、DOMPurify 和 Lucide。生成的本地资源及各自许可证一起保存在 `apps/desktop/circuit-lens/web/vendor/`；`scripts/ui/vendor.cjs` 从安装的 npm 包重新生成这些资源。

Electron 和 Playwright 通过 npm 安装，依赖包中保留各自许可证。本仓库当前未选择自身源码的开源许可证。

独立应用包另包含 [CPython 独立构建](https://github.com/astral-sh/python-build-standalone)、[Eclipse Temurin](https://github.com/adoptium/temurin21-binaries)、[官方 Codex 运行包](https://github.com/openai/codex/releases/tag/rust-v0.154.0) 和 [PDF.js](https://github.com/mozilla/pdf.js)。版本与下载摘要由 `scripts/distribution/runtime-lock.json` 和 npm 锁文件固定；程序许可证保留在各自运行目录，Codex 的 Apache-2.0 许可证另行随包附带。PDF.js 为 Apache-2.0；其浏览器资源无需可选 Node canvas 组件。

[Logisim-ITA v2.16.2.2](https://github.com/Logisim-Ita/Logisim/releases/tag/v2.16.2.2) 的上游标注 GPL-3.0；本地验收包同时保存该标签的源码归档，内含许可证。HUST 修改版课程运行文件的对应源码和再分发许可尚未确立，不能由标准版许可推定。当前完整包仅为本地验收产物，没有公开发布授权结论；详见 [分发说明](docs/distribution.md)。
