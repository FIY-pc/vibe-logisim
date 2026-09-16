# 开发与验证

## 环境

当前桌面开发版在 Linux 上使用。需要 Node.js 22+、npm、Python 3.11+（服务使用标准库）、JDK 17+ 的 `java` 和 `javac`。前端 npm 依赖版本由锁文件固定。

内嵌 AI 需要 `codex`、`codex-code-mode-host` 在 PATH 中，已有可用的本地 Codex 登录或服务商配置，以及可用的 `systemd-run --user` 隔离环境。没有这些条件时不能完整使用 AI 对话。PDF 预览还使用 Poppler 的 `pdftotext`、`pdftoppm` 和 `pdfinfo`。

## Logisim 运行文件

桥接层依赖特定版本的 Logisim 内部接口。当前仍使用以下本地路径；运行文件与课程库未在此仓库分发，需从自己可用的 Logisim / 课程安装包准备，不能随意替换为其他版本。

| 文件 | 仓库内安装路径 | SHA-256 |
| --- | --- | --- |
| Logisim-ITA 2.16.2.2 | `apps/desktop/circuit-lens/native/Logisim-ITA.jar` | `9eb1aae5e87cf0c6e4af845dde00624338c6dce25d945b6482cad017aa6cbb34` |
| HUST 20200118 课程运行文件 | `workspaces/hust-riscv/original/course-package/logisim-ita-cn-20200118.exe` | `b2400702fb9e8e4c71c512d7e09678a788039f402be55164209cde4cee8fc996` |

请准备两个运行文件：基础环境检查使用前者，新建电路及 `source="2.15.*"` 的课程电路使用后者。课程 `.exe` 含 Java 运行类，由 Java 加载，不通过 Wine 启动。它们都是被 Git 忽略的本地依赖。

课程组件库 `cs3410.jar`、`riscv-probe.jar` 与引用它们的 `.circ` 放在同一目录。当前只加载已支持摘要的课程库；任意外部库和不同 Logisim 分支尚不保证兼容。详见 `studio/project/package.py`。

## 启动

从仓库根目录运行：

```sh
npm --prefix apps/desktop ci
apps/desktop/run
```

安装会将锁定版本的前端依赖生成到 `web/vendor/`；需要联网下载 npm/Electron 依赖。桌面打开本地文件夹后，可从文件树选择或新建电路。AI 使用同一工作目录，资料直接放入文件夹。

可选环境变量：

| 变量 | 用途 |
| --- | --- |
| `VIBE_LOGISIM_PYTHON` | Python 可执行文件 |
| `VIBE_LOGISIM_CODEX` | Codex 可执行文件 |
| `VIBE_LOGISIM_STATE_DIR` | 独立的本地电路服务状态目录 |
| `VIBE_LOGISIM_MODEL` / `VIBE_LOGISIM_EFFORT` | 模型与思考深度初始值 |

会话、认证与运行状态不属于源码。保持原生 Codex 的认证来源，不复制轮换凭据到多个独立活跃配置。

## 有针对性的验证

不消耗模型额度、也不需要课程电路的文件夹行为验证：

```sh
node --test apps/desktop/electron/folder-workspace.test.cjs apps/desktop/electron/folder-import.test.cjs
```

`apps/desktop/test/` 保存桌面和原生运行验证脚本。许多历史脚本依赖本地 `exports/`、`archive/` 下的课程样本；它们没有随仓库分发，不能把干净检出直接运行这些脚本的缺样本失败解释成产品回归。现有 `npm run test:e2e` 也是需要样本的浏览器服务验证，不覆盖完整 Electron 体验。

交互改动优先在独立临时文件夹和独立状态目录启动真实 Electron，通过鼠标/键盘走用户流程，核对保存文件、原生行为与重开结果。AI 状态可用明确标注的回放验证；真实模型回合单独考虑额度和必要性。

当前没有打包安装器、跨平台验收或完整自动化发布流程；这一提交提供可继续开发的源码基线。
