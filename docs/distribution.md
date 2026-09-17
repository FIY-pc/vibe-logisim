# 独立桌面应用包

普通使用者解压一个包，打开 `vibe-logisim`，即可打开文件夹、创建或编辑电路、运行仿真、预览资料。无需安装 Node、Python、Java、Codex、Logisim 或 Poppler。AI 面板提供 ChatGPT 登录和取消入口，浏览器完成登录后自动更新连接；退出登录在 AI 设置里。未登录不影响人工编辑和仿真。

目前提供 **Linux x86_64 本地验收构建**，不是已公开发布的安装器。基础系统仍需桌面图形库（Electron 的 GTK/NSS 等）、glibc 和 systemd 用户服务；AI 继续使用 systemd 隔离。其他发行版、Windows、macOS、自动更新和签名尚未验收。

## 构建

在开发机准备 Node、Python 3.12+，并执行 `npm --prefix apps/desktop ci`。构建器固定版本和 SHA-256，第一次构建下载运行环境，应用使用时不下载运行环境。课程运行文件必须由构建者显式提供：

```sh
python3 scripts/distribution/build.py \
  --output /tmp/vibe-release \
  --course-runtime workspaces/hust-riscv/original/course-package/logisim-ita-cn-20200118.exe
```

输出是 `vibe-logisim-0.1.0-linux-x64.tar.gz` 和 SHA-256 文件。默认缓存 `/tmp/vibe-distribution-cache`，可用 `--cache` 更改；`--unpacked` 只生成应用目录，便于先验收再压缩。构建拒绝覆盖已有产物。

构建器只选择产品目录中的源码和明确列出的第三方文件，不复制整个仓库、开发机的环境、账户、会话或个人电路。`runtime-lock.json` 是运行环境输入清单，npm 锁文件固定 Electron、PDF.js；产物另有版本来源和文件摘要清单。当前锁定的 Logisim-ITA 发布物与开发机已有运行文件摘要一致。

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

`agent-process.cjs` 负责 Linux 进程隔离。AI 读写用户工作目录；包内工具只读挂载。独立应用拥有自己的登录，不复制或共享开发机的轮换认证文件。Linux 独立包的应用数据位于 `$XDG_CONFIG_HOME/vibe-logisim`（默认 `~/.config/vibe-logisim`），与开发版 `vibe-logisim-desktop` 的账户和会话映射分离。开发环境依旧沿用原有本机 Codex 配置。此处没有缩减直接文件编辑、脚本或可选电路工具的能力。

PDF.js 在没有 Node 权限、无远程网络的独立 Chromium 进程里渲染 PDF 和提取文字，支持翻页、引用和失败后重试；不再调用系统 Poppler。长时间未返回的预览会终止，原资料保留。

## 验收

解压后运行：

```sh
node apps/desktop/test/e2e-packaged.cjs /path/to/vibe-logisim-0.1.0-linux-x64/vibe-logisim
```

脚本在仓库外、全新应用状态和包含空格的文件夹运行真正的打包程序。将系统 Python、Java、Codex、Poppler 命令设为调用即失败；从 UI 放元件、连线、切换输入、核对与门四种真值、关闭重开，再从文件树打开两页 PDF 并检查图像和文字。还通过真实内置 App Server 发起/取消登录，仅拦截浏览器打开，不提交凭据或发起模型生成。报告和截图留在脚本返回的临时目录。

这些证据覆盖一个真实的小电路任务和本机打包环境，不能代替干净发行版矩阵测试、完成登录后的模型构建质量或复杂课设验收。

## 公开分发尚缺的材料

目前没有给产物自动增加上传或发布步骤。课程 `logisim-ita-cn-20200118.exe` 的原始分发许可和对应修改源码未明确，不能把标准 Logisim-ITA 的许可自动套用到它上面；项目自身开源许可证也尚未选定。当前完整包明确标记为本地验收用途。标准 Logisim-ITA 为 GPL-3.0，包内附对应标签源码；其他运行环境的许可证保留在各自目录。正式发布前还需要完成整个发行包的第三方来源与许可核对。
