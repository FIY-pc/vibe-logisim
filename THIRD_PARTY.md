# 第三方组件

本项目的 Logisim 桥接代码需要外部 Logisim 运行文件及课程组件库；它们未包含在此次源码提交中，也不因本仓库将来选择许可证而改变其原有许可。安装位置和兼容版本见 [开发说明](docs/development.md)。

前端使用锁文件固定版本的 Marked、DOMPurify 和 Lucide。生成的本地资源及各自许可证一起保存在 `apps/desktop/circuit-lens/web/vendor/`；`scripts/ui/vendor.cjs` 从安装的 npm 包重新生成这些资源。

Electron 和 Playwright 通过 npm 安装，依赖包中保留各自许可证。本仓库当前未选择自身源码的开源许可证。
