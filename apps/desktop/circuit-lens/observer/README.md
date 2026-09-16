# 原生电路观察器

`ExactRuntimeObserver.java` 编译进 Logisim 的 `com.cburch.logisim.circuit` 包，从原生计算得到的连接、位网络、元件和层级读取信息。它不另写一套连通算法。

观察依赖具体运行文件；安装位置和校验摘要见 [开发说明](../../../../docs/development.md)。桌面应用由 `studio/runtime/observer.py` 和常驻 worker 管理编译与调用。

单独调试默认运行时：

```sh
apps/desktop/circuit-lens/observer/run.sh --compact /absolute/path/to/design.circ main 0 0 800 600
apps/desktop/circuit-lens/observer/query.sh /absolute/path/to/design.circ main 0 0 800 600 overview
```

`run-precompiled.sh` 和 `query-precompiled.sh` 用于已准备好的 classes 与运行文件，路径由 `VIBE_OBSERVER_CLASSES` 和 `VIBE_OBSERVER_RUNTIME_JAR` 指定。

返回的对象 ID 属于观察时的电路版本。静态连接不证明时序行为、整机功能或外部评测结果；动态运行由服务内独立的仿真模块负责。
