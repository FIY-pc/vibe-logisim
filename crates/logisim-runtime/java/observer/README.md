# 原生电路观察器

`ExactRuntimeObserver.java` 编译进 Logisim 的 `com.cburch.logisim.circuit` 包，从原生计算得到的连接、位网络、元件和层级读取信息。它不另写一套连通算法。

观察依赖具体运行文件；安装位置和校验摘要见 [开发说明](../../../../docs/native-workbench.md)。桌面应用由 `crates/logisim-runtime` 管理编译与常驻 Java worker。

单独调试默认运行时：

```sh
crates/logisim-runtime/java/observer/run.sh --compact /absolute/path/to/design.circ main 0 0 800 600
```

`run-precompiled.sh` 用于已准备好的 classes 与运行文件，路径由 `VIBE_OBSERVER_CLASSES` 和 `VIBE_OBSERVER_RUNTIME_JAR` 指定。

除端口和位网络外，每个元件带 `storage`（`delay`：寄存器、触发器，以及所有输入都只到达内部存储的子电路；`state`：计数器、随机源、输出经自身逻辑回到自己的存储；没有这个字段就是组合逻辑，ROM/RAM 也算组合查表），子电路实例的输入端带 `registered`（该信号在内部只到达存储）。这两个字段按定义电路自己的网络递归算出，和元件名、电路名无关；布局器靠它们划分流水级。

元件属性只带 `name` 和 `standard`（保存格式的值）。显示文本和可选值列表不在观察里：可选值要为每个属性向原生编辑器要一个下拉框，大页面上这曾是观察的主要开销；需要时对具体元件发 `properties` 请求。

返回的对象 ID 属于观察时的电路版本。静态连接不证明时序行为、整机功能或外部评测结果；动态运行由服务内独立的仿真模块负责。
