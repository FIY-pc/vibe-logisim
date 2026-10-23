# Logisim 原生运行参考

适用于产品支持的 Logisim-ITA 2.16.2.2 和 HUST 20200118 运行文件。其他分支的 CLI 和 Java API 可能不同。此文件是按需参考，不要求采用某条验证路径。

## 已有原生能力

`simulate_circuit` 用真实 Logisim `Pin.setValue` 和 `Propagator.propagate` 运行指定组合输入，每组使用全新状态；`trace_circuit` 用原生时钟推进同一个状态。它们不是 Python/JavaScript 逻辑替身。运行结果的 `execution` 来自执行 JVM，包含实际加载的 `runtimeJarSha256`、`runtimeVersion` 和 `artifactSha256`；宿主核对这些值与请求的文件相符，`runtimeProfile.status=observed` 表示已实际执行。`expected` 来自调用方，只比较指定案例，不证明未覆盖行为。

要与工作区中的某个运行文件核对，可用 `sha256sum path/to/runtime.jar` 与结果的 `execution.runtimeJarSha256` 比较；扩展名可以是 `.jar` 或含 Java 类的课程 `.exe`。运行环境相同不意味着两个验证器独立：独立检查仍应自行确定期望、覆盖案例，并按需另写脚本。

## 脚本生成的大批量输入

`simulate_circuit` 可直接读取工作区里的 JSON 文件，不需要自行编写 Java 入口或多次发送输入批次。`vectorsFile` 相对于打开的文件夹，文件内容是与 `vectors` 相同的数组：

```json
[{"inputs":{"A":0,"B":1},"expected":{"Y":1}}]
```

先用普通 Python/JavaScript 脚本按照自己的规格生成完整数组，再调用 `simulate_circuit({circuit:"实际电路名", vectorsFile:"checks/inputs.json"})`。`vectors` 和 `vectorsFile` 只传一个；内联最多 1,024 组，文件最多 131,072 组、32 MiB。工具读取数据，不执行文件里的代码。

每组仍使用全新原生状态。结果的计数覆盖全部输入，返回行优先保留反例和未知；`vectorsFile.sha256` 标识实际读取的文件字节。没有 `expected` 的行只是运行观察，完整空间和预期是否正确仍由输入文件决定。时序任务继续使用 `trace_circuit`，独立 Java/CLI 路径也仍然可用。

## CLI 的实际含义

- `java -jar runtime.jar -help` / `-version` 会输出帮助/版本，但这两种支持的运行文件返回 **255**。不能仅凭退出码把它算作 API 调用错误。
- `-tty table circuit.circ` 输出随仿真推进的值，并不会自动枚举输入引脚的所有组合。没有结束条件时可能持续运行。需要这种时序输出时自行设置有界运行；不要把等待退出当作组合真值表检查。
- 无窗口 Java 检查使用 `-Djava.awt.headless=true`。`Project` 会启动后台线程，正常返回 `main`，甚至主线程抛异常，都不保证 JVM 退出；一次性命令应在统一成功/失败出口调用 `System.exit(code)`。

## 独立组合检查的最小 Java 入口

以下可保存为临时目录中的 `PinCheck.java`，按任务修改或复用。它接受 `.circ`、电路名称和全部输入的 `label=value`，输出原生位串；不会生成期望或将未知位当成零。有状态电路应另行设计时钟/复位/采样过程。

```java
import java.io.File;
import java.util.*;
import com.cburch.logisim.file.*;
import com.cburch.logisim.proj.Project;
import com.cburch.logisim.circuit.*;
import com.cburch.logisim.comp.Component;
import com.cburch.logisim.data.*;
import com.cburch.logisim.instance.*;
import com.cburch.logisim.std.wiring.Pin;

public final class PinCheck {
    public static void main(String[] args) {
        int exit = 1;
        try {
            Loader loader = new Loader(null) {
                @Override public void showError(String message) { throw new IllegalStateException(message); }
            };
            LogisimFile file = loader.openLogisimFile(new File(args[0]));
            Circuit circuit = file.getCircuit(args[1]);
            if (circuit == null) throw new IllegalArgumentException("Unknown circuit");
            Map<String, Long> values = new HashMap<>();
            for (int i = 2; i < args.length; i++) {
                String[] pair = args[i].split("=", 2);
                if (values.put(pair[0], Long.parseUnsignedLong(pair[1])) != null)
                    throw new IllegalArgumentException("Duplicate input");
            }
            CircuitState state = new CircuitState(new Project(file), circuit);
            Map<String, Component> outputs = new TreeMap<>();
            Set<String> labels = new HashSet<>();
            for (Component c : circuit.getNonWires()) {
                if (!(c.getFactory() instanceof Pin)) continue;
                String label = c.getAttributeSet().getValue(StdAttr.LABEL);
                if (label.isEmpty() || !labels.add(label)) throw new IllegalArgumentException("Pins need unique labels");
                if (!Pin.FACTORY.isInputPin(Instance.getInstanceFor(c))) { outputs.put(label, c); continue; }
                Long value = values.remove(label);
                BitWidth width = c.getAttributeSet().getValue(StdAttr.WIDTH);
                if (value == null || width.getWidth() > 32 || Long.compareUnsigned(value, 1L << width.getWidth()) >= 0)
                    throw new IllegalArgumentException("Missing or out-of-range input: " + label);
                Pin.FACTORY.setValue(state.getInstanceState(c), Value.createKnown(width, value.intValue()));
            }
            if (!values.isEmpty()) throw new IllegalArgumentException("Unknown inputs: " + values.keySet());
            state.getPropagator().propagate();
            if (state.getPropagator().isOscillating()) throw new IllegalStateException("Oscillating circuit");
            for (Map.Entry<String, Component> out : outputs.entrySet())
                System.out.println(out.getKey() + "=" + Pin.FACTORY.getValue(state.getInstanceState(out.getValue())).toDisplayString(2));
            exit = 0;
        } catch (Throwable error) { error.printStackTrace(System.err); }
        System.exit(exit);
    }
}
```

编译与执行示例（替换实际路径和引脚标签）：

```sh
javac -encoding UTF-8 -cp runtime.jar -d /tmp/pin-check /tmp/PinCheck.java
java -Djava.awt.headless=true -cp runtime.jar:/tmp/pin-check PinCheck circuit.circ main A=1 B=0
```

关键 API 是 `StdAttr.LABEL`（不是 `Pin.ATTR_LABEL`）和 `Instance.getInstanceFor(component)`（不能将 Component 强转成 Instance）。比较结果时保留 `x`、`E` 等未知/错误状态。例子只展示顶层 Pin 传播；子电路观察、按钮、ROM 激励和时序采样可参考原生工具，也可按自己的任务编写验证器。
