# 数字电路工作参考

按当前问题读取。它们是设计线索和工具的语义说明，不是流程或课程答案。

- [学科知识与设计选择](digital-design.md)：组合表示、时序状态、数据通路、教学约束，以及原始课程来源。
- [原生运行与独立 Java 检查](java-runtime.md)：工具实际使用的 JAR、CLI 语义、引脚 API 和进程退出。
- [整理器](arrangement.md)：`arrange_circuit` 默认按信号流怎么排、组织参数的含义、它按什么判断更清楚。
- 工作目录就是用户打开的文件夹，`.circ` 是可修改的完整工程，不限于空白模块：组件、导线、电路定义和子电路实例都可以用脚本或 `write_file` 生成、改写、删除。
- 用户提供的任务书、工作簿和图像是文件夹中的普通文件。Excel 公式没有缓存不意味着结果为零。
- 用脚本或 `write_file` 改写一个打开的 `.circ` 后，下一次电路工具调用和用户的画布读到的就是新内容；文件载入成功不代表行为正确。元件 ID 由位置决定：未移动的元件保持原 ID，移动或删除后旧 ID 失效；导线 ID 是文件里的顺序号，增删导线后会变。
- place_component、connect、set_attributes、move_components、delete_objects 和 arrange_circuit 直接修改文件并立即生效，用户在画布上同步看到；undo_edit 撤回最近一步。
- simulate_circuit 是每个向量独立的组合传播；trace_circuit 是另起状态的时钟执行，都不是用户屏幕上正在运行的那一实例。
- 每个回合的文件改动记成一条文件夹历史，用户可以查看和撤销。
