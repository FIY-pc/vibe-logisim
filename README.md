# Vibe Logisim

人与 AI 共同设计、理解和修改电路的桌面工作区，面向教学电路，兼容 HUST 课程使用的 Logisim 运行环境。

打开本地文件夹，在左栏选择 `.circ`，在画布上编辑和运行，在右栏与 AI 讨论同一份电路。资料、脚本和设计记录直接放在工作区里；会话属于文件夹，切换电路不会换会话。

目前已经实现：

- 文件树内拖动文件和文件夹、回收站删除、拖到对话引用；文件预览、变化同步、改动查看和撤销。
- 组件库、连续放置、属性与 ROM 编辑、导线连接与整理、子电路导航及封装接口编辑。
- 原生 Logisim 渲染与仿真、实例信号观察、画面留存，以及大画布按视野重绘。
- 本地 Codex 对话、模型与思考深度选择；按文件夹新建、查找、重命名和归档对话，各自恢复未发送内容；AI 直接修改工作区文件。

这是仍在打磨的开发版本。大电路编辑延迟和交互细节还需要改进；已有功能不等于所有电路或课程任务都能自动完成。

## 启动

已加入 Linux 独立应用包构建：解压后直接打开程序，内置电路运行环境和 Codex，AI 面板可登录 ChatGPT，PDF 无需外部工具。完整包目前用于本地验收，尚未公开发布；构建与使用边界见 [独立应用包](docs/distribution.md)。

以下是源码开发启动方式：

当前支持 Linux 开发环境，需要 Node.js 22+、npm、Python 3.11+、JDK 17+。内嵌 AI 还依赖本机可用的 Codex、`codex-code-mode-host` 和 systemd 用户服务。

1. 按 [开发说明](docs/development.md) 安装两个匹配版本的 Logisim 运行文件；它们未随源码分发。
2. 安装桌面依赖并启动：

```sh
npm --prefix apps/desktop ci
apps/desktop/run
```

应用内点击“打开文件夹”，再选择或新建电路。课程电路引用的组件库应放在 `.circ` 同目录。

## 源码导航

| 目录 | 职责 |
| --- | --- |
| `apps/desktop/electron/` | 桌面宿主、文件夹工作区、文件历史和 AI 连接 |
| `apps/desktop/circuit-lens/web/` | 画布、文件树、属性、仿真和对话界面 |
| `apps/desktop/circuit-lens/studio/` | 电路文档、编辑、历史、仿真与协作服务 |
| `apps/desktop/circuit-lens/native/` | 原生 Logisim 操作与渲染桥接源码 |
| `apps/desktop/circuit-lens/observer/` | 从真实运行时读取电路结构及连接 |
| `apps/desktop/circuit-knowledge/` | 可选的电路设计参考 |
| `apps/desktop/test/` | 桌面操作及服务验证脚本 |
| `scripts/ui/` | 本地 UI 依赖资源生成 |
| `scripts/distribution/` | 固定运行环境、校验下载和独立应用包构建 |

继续开发前阅读 [架构说明](docs/architecture.md)。第三方运行文件及前端依赖见 [THIRD_PARTY.md](THIRD_PARTY.md)。当前尚未选定本项目源码的开源许可证。
