# 线上部署验收：2026-11-02 关卡评测与演示课堂

目标服务：`https://lovej.site/vibe-classroom`，发布代码 `01e3e1e`，bundle SHA-256 为
`10454f8f3bba4ed8917f69c842983db5938052a7d3d80437758e993181d1535b`。
数据库在线备份与密钥、环境文件备份位于 `backups/20261102-054723-before-01e3e1e`；
追加评测环境前的 `classroom.env` 另存于 `backups/classroom.env.pre-grader-*`。

## 本次发布内容

- 课堂服务新增章节、关卡、提交与评测接口（`63c2cab`），以及判题版本 `grading_version`
  迁移与教师按学生筛选提交记录（`01e3e1e`）。桌面端新增“章节关卡 / 学习记录”双标签：
  教师发布图文关卡、上传 circ 模板与公开/隐藏用例、参考电路试评、学生闯关情况矩阵；
  学生下载模板、提交评测、查看逐用例结果。
- 服务端评测组件：`grader/Logisim-ITA.jar`（`9eb1aae5…bb34`）与
  `grader/grader-bridge.jar`（`264e6603…14c`），`classroom.env` 追加
  `CLASSROOM_GRADER_JAVA=/usr/bin/java`（服务器 OpenJDK 17.0.20.1）与
  `CLASSROOM_GRADER_CLASSPATH=<上述两 jar，冒号分隔>`，重启后 `/curriculum` 返回
  `gradingAvailable=true`。

## 本地验证

- `npm run check` 通过；课堂服务测试 8 项通过、1 项按环境跳过；
  `CLASSROOM_TEST_GRADER_CP` 指向本地 jar 时真实 Logisim 全加器真值表测试通过
  （并拒绝外部库、jar 库与递归子电路）。
- 工作台 UI 场景 31 项全部通过，其中课堂场景新增端到端覆盖：教师发布章节与关卡
  （模板上传、Markdown 导入、隐藏用例）、学生下载模板并保存到工作文件夹、提交评测、
  隐藏用例脱敏展示、教师闯关情况与按学生筛选提交记录。
- 部署 bundle 冒烟（本地真实 JVM）：错误电路 1/8 判 failed、全加器 8/8 判 passed、
  隐藏用例仅返回“隐藏用例”标题、教师进度与参考电路试评正常。

## 线上验证（公网 HTTPS，临时账号）

使用临时教师 `smoke-39fd4e96-*` 与两名临时学生、独立课堂验证后按 ID 精确清理：

- 健康检查通过；未配置前 `gradingAvailable=false` 的路径在配置评测组件后变为 true。
- 常量 0 电路 1/8 判 failed；真实全加器电路 8/8 判 passed（两名学生各一次）。
- 学生读取关卡只见 6 组公开用例与“2 组隐藏”计数；学生结果中隐藏用例只含通过状态，
  无输入、预期与用例标题；教师读取同一提交可见完整用例与提交电路副本。
- 教师进度矩阵、按学生筛选提交记录、参考电路试评（8 行输出）均正常。
- 清理脚本（`cleanup-smoke-v2.py`，含 assessment_* 三表）确认临时账号、课堂、章节、
  关卡、提交与去重内容删除；清理后剩余 2 个账号与 2 个课堂，为发布前既有真实数据。

## 演示课堂（保留）

为教师演示创建课堂“数字电路课堂”（课堂码见本地 `demo-owned.json`，不入库）：

- 章节“组合逻辑基础”：第 1 关 半加器（4 组公开用例）、第 2 关 全加器设计
  （8 组用例，2 组隐藏，含框图插图）。
- 章节“常用中规模器件”：第 3 关 二选一数据选择器（8 组用例，2 组隐藏）、
  第 4 关 4 位数值比较器（10 组用例，3 组隐藏，说明中提示 Comparator 默认有符号
  比较需改 unsigned——该行为由线上/本地评测实测确认）。
- 演示账号：教师 `demo-teacher`，学生 `demo-student-1/2/3`（王小明、李华、陈晨），
  密码统一为本地 `demo-owned.json` 中记录的值，供演示登录，建议演示后修改。
- 示例提交 10 次全部由服务端真实 JVM 评测：王小明半加器/全加器通过、选择器先
  6/8 失败后 8/8 通过、比较器未提交；李华半加器通过、全加器 4/8 失败（教师可打开
  其提交查看逐用例差异与隐藏用例仅反馈通过情况）；陈晨四关全部通过。
- 教师端“学生闯关情况”因此呈现通过、失败、重试与未提交四种状态，适合现场演示。

验证与创建过程没有调用付费模型；除演示课堂与演示账号外未留下其他测试数据。
服务在发布与验证期间保持 active，健康检查通过。

## 桌面端打包

同一提交 `01e3e1e` 的工作台已重新打包（版本 `0.6.0-beta.3`，本机 Node 22 需
`--experimental-strip-types` 运行打包脚本，Rust 工具链取自
`~/.rustup/toolchains/1.99.0-x86_64-pc-windows-msvc`）：

- 安装包 `.workbench-cache/release/vibe-logisim-0.6.0-beta.3-win32-x64-setup.exe`
  （104656360 字节，`ccd724ce14116c7f74b112a867f3aac2d1f660e48ff450b67d63ee6e8aa981ab`）
- 便携包 `.workbench-cache/release/vibe-logisim-0.6.0-beta.3-win32-x64.zip`
  （126795694 字节，`ea02670db6c0c6597fd6167d1fa6ac04415396950a3b0beafa331b525cb05849`）
- 校验和文件 `SHA256SUMS-win32-x64.txt` 与二者同目录。

便携包按既有检查从压缩包外解压并真实启动验收通过：前端挂载与 IPC、内置 Java
仿真、内置 Node 启动、关闭重开后的草稿恢复；不依赖系统 PATH 中的运行时。
演示课堂与评测功能在桌面端的使用方式：标题栏“课堂”入口填写
`https://lovej.site/vibe-classroom` 登录演示账号。
