import com.cburch.logisim.circuit.Circuit;
import com.cburch.logisim.circuit.Wire;
import com.cburch.logisim.comp.Component;
import com.cburch.logisim.comp.EndData;
import com.cburch.logisim.file.LoadFailedException;
import com.cburch.logisim.file.Loader;
import com.cburch.logisim.file.LogisimFile;
import com.cburch.logisim.file.NativeCircuitLoader;
import java.io.File;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.List;

/** Small native probe: no worker, model, application cache or source writes. */
public final class NativeWireValidation {
    private static final class CountingLoader extends Loader {
        int calls;
        CountingLoader() { super(null); }
        @Override public void showError(String message) { throw new IllegalStateException(message); }
        @Override public LogisimFile openLogisimFile(File file) throws LoadFailedException {
            calls++;
            return super.openLogisimFile(file);
        }
    }

    private static String snapshot(LogisimFile file) {
        List<String> rows = new ArrayList<>();
        rows.add("main=" + file.getMainCircuit().getName());
        for (Circuit circuit : file.getCircuits()) {
            String prefix = circuit.getName() + ":";
            rows.add(prefix + "circuit");
            for (Wire wire : circuit.getWires()) {
                rows.add(prefix + "wire:" + wire.getEnd0() + "->" + wire.getEnd1());
            }
            for (Component component : circuit.getNonWires()) {
                String part = prefix + component.getFactory().getName() + "@" + component.getLocation();
                rows.add(part);
                int index = 0;
                for (EndData end : component.getEnds()) {
                    rows.add(part + ":port=" + index++ + ":" + end.getLocation() + ":width="
                        + end.getWidth().getWidth() + ":type=" + end.getType() + ":exclusive=" + end.isExclusive());
                }
            }
        }
        String message;
        while ((message = file.getMessage()) != null) rows.add("message=" + message);
        Collections.sort(rows);
        return String.join("\n", rows);
    }

    public static void main(String[] args) throws Exception {
        PrintStream protocol = System.out;
        System.setOut(System.err);
        CountingLoader loader = new CountingLoader();
        for (int i = 1; i < args.length; i++) {
            long start = System.nanoTime();
            int before = loader.calls;
            String status, detail;
            double loadMs;
            try {
                File source = new File(args[i]);
                LogisimFile file = args[0].equals("old") ? loader.openLogisimFile(source)
                    : NativeCircuitLoader.open(loader, source);
                loadMs = (System.nanoTime() - start) / 1e6;
                detail = snapshot(file);
                status = "OK";
            } catch (Exception error) {
                loadMs = (System.nanoTime() - start) / 1e6;
                detail = error.getClass().getName() + ": " + error.getMessage();
                status = "REJECT";
            }
            protocol.println(status + "\t" + loadMs + "\t" + (loader.calls - before) + "\t"
                + Base64.getEncoder().encodeToString(detail.getBytes(StandardCharsets.UTF_8)));
        }
    }
}
