# 第三方组件

本项目源码以 [GPL-3.0](LICENSE) 发布。依赖的原有许可不因本仓库许可证而改变。npm 与 Cargo 锁文件固定应用依赖；`config/runtime-lock.json` 和 `scripts/workbench/runtime-lock.json` 固定下载运行时的版本、来源与 SHA-256。

| 组件                                      | 用途与许可                                                    | 随包材料                                                        |
| ----------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| Tauri 2                                   | 桌面窗口与系统集成，MIT / Apache-2.0                          | Rust 依赖遵循 Cargo 锁文件；源码中的许可证声明保留              |
| React、Lucide、react-markdown、remark-gfm | 界面、图标和 Markdown 显示，各依赖保留原有 MIT / ISC 等许可证 | `third-party/frontend/` 包含前端依赖信息与许可证                |
| PDF.js                                    | 本地 PDF 阅读，Apache-2.0                                     | 前端资源随应用提供，许可证位于 `third-party/frontend/`          |
| Node.js                                   | 独立 AI 运行时进程，MIT 及其包含的第三方许可                  | `runtimes/node/LICENSE`                                         |
| Pi SDK                                    | 内置模型协议与工具回合，MIT                                   | `third-party/node/` 中的包信息和许可证                          |
| Models.dev                                | 模型名称与能力元数据，MIT                                     | 随 AI 运行时保留快照与许可证；不决定模型服务实际可用的模型      |
| Eclipse Temurin                           | Java 运行时，GPL-2.0 with Classpath Exception 及其第三方许可  | 裁剪后的 `runtimes/java/legal/`                                 |
| Logisim-ITA 2.16.2.2                      | 电路加载、绘制与仿真，GPL-3.0                                 | `native/Logisim-ITA.jar` 与 `third-party/logisim/source.tar.gz` |
| HUST 2020 版 Logisim（2.15.0.2）          | 加载与仿真由 2.15 版保存的电路，原样附带                      | `native/logisim-ita-cn-20200118.exe`                            |
| Codex                                     | 可选的 ChatGPT / Responses 运行时，Apache-2.0                 | `third-party/codex-LICENSE`；程序首次使用时按清单下载           |

上表中的路径相对于应用的 `workbench` 资源目录。Windows 便携包将其放在 `resources/workbench`；安装程序使用系统应用资源目录。第三方 Node 依赖的版本和许可证信息分别列于 `third-party/node/packages.json` 与 `third-party/frontend/packages.json`。

Logisim 对应源码来自 [v2.16.2.2 标签](https://github.com/Logisim-Ita/Logisim/tree/v2.16.2.2)，源归档随每个应用包提供。HUST 2020 版运行文件按发布方原样附带、不作修改，由 Java 作为 jar 加载，只用于 `source` 为 2.15.x 的文件；发布方没有随它提供对应源码。如权利人提出要求，会移除并改为由用户自行放置该文件。用户可以通过 `VIBE_LOGISIM_JAR` 指定其他支持的运行文件；该文件及其外部组件库遵循各自许可，不自动进入分发包。

Windows 的 Java 启动程序附加 UTF-8 进程代码页声明，以支持非 ASCII 安装路径。此修改会使原签名失效；具体改动记录随 Java 运行时提供。Windows WebView2 与 Linux WebKitGTK 使用操作系统提供的 WebView，不包含在便携包内。
