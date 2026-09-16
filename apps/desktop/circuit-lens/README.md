# Circuit Lens

Vibe Logisim 的本地电路服务。常规入口是 [桌面应用](../README.md)。

服务由 `server.py` 进入 `studio/bootstrap.py`，只监听本地地址。调试时可使用独立状态目录：

```sh
python3 apps/desktop/circuit-lens/server.py --no-browser --port 0 --state-dir /tmp/vibe-local-debug /absolute/path/to/design.circ
```

`studio` 的包边界见 [服务结构](studio/README.md)，全局状态归属见 [架构说明](../../../docs/architecture.md)。顶层 `workbench.py`、`simulation.py` 等是兼容入口；新功能应放在归属明确的包中。

静态连接与动态运行依赖匹配的原生 Logisim，不自行猜测交叉点、Tunnel 或 Splitter 的电气语义。缺失运行环境时，能读取几何不代表已读取连接或验证功能。

`lensctl.py --help` 列出外部代理可用的查询、编辑和运行入口；这些能力不限制模型直接修改文件或编写自己的工具。
