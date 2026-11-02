# 主分支同步与 PR 前回归：2026-11-02

集成分支：`codex/classroom-assessment-integration`。原工作分支
`codex/presentation-9min` 保留在 `f989200`。

远端主分支从 `95acbb7` 更新为 `1556192`（课堂协作 PR #32 合并）。
集成分支通过 `aed92d9` 合并该主分支，没有冲突；该 merge 相对第一父提交
没有文件内容变化。未改写历史，未直接推送主分支。

## 本地验证

环境：Windows，Node.js 24.22.1，课堂桥接组件用 Microsoft OpenJDK 17 编译。

| 检查 | 结果 |
|---|---|
| `npm run check` | 通过，覆盖工作台、AI、布局、课堂与官网 TypeScript |
| 课堂与官网 `node --test` | 13 项通过，1 项真实 JVM 测试默认按环境跳过 |
| 配置 classpath 后单独运行 `native-grader.test.mts` | 1 项通过、无跳过；全加器八组真值表及非法库、递归电路、XML 外部实体拒绝断言通过 |
| `node scripts/workbench/verify-ui.mts` | 32 项 UI 场景通过，包括教师关卡发布、学生模板打开/提交、隐藏用例与教师进度 |
| `npm run build` | 通过；构建器提示部分分块较大及已有静态/动态混合导入警告 |
| `git diff --check origin/main...HEAD` | 通过 |

真实 JVM 测试使用本轮从源码新编译的 `grader-bridge.jar`，产物放在忽略目录
`.workbench-cache/github-integration/grader`，未把运行时、凭据或环境文件加入提交。

本次只做 Git 集成与 PR 回归，没有修改线上课堂数据、服务配置或部署版本。
完整跨平台 CI 由 PR 工作流执行。
