package com.cburch.logisim.circuit;

import com.cburch.logisim.tools.move.MoveGesture;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Element;

/** Run against either runtime with the bridge classes first on the class path. */
public final class WireMoveCheck {
    private static String point(int x, int y, boolean transpose) {
        return transpose ? y + "," + x : x + "," + y;
    }

    private static void check(int x, int y, boolean transpose) throws Exception {
        int[][] wires = {{x, y, x + 100, y}, {x + 100, y, x + 100, y + 100}};
        if (transpose) for (int[] wire : wires) {
            int a = wire[0], b = wire[2];
            wire[0] = wire[1]; wire[1] = a;
            wire[2] = wire[3]; wire[3] = b;
        }
        Circuit circuit = new Circuit("main");
        DocumentIds.Sheet sheet = new DocumentIds.Sheet();
        sheet.wires(wires);
        CircuitMutation mutation = new CircuitMutation(circuit);
        mutation.addAll(sheet.nativeWires());
        mutation.execute(null);
        Map<String, MoveGesture> gestures = new HashMap<>();
        // Reuse a gesture as pointer previews do, including reversing direction.
        for (int delta : new int[] {-50, 50, -50, 50}) {
            Element request = DocumentBuilderFactory.newInstance().newDocumentBuilder()
                .newDocument().createElement("move");
            request.setAttribute("dx", Integer.toString(transpose ? 0 : delta));
            request.setAttribute("dy", Integer.toString(transpose ? delta : 0));
            request.setAttribute("wires", "w1");
            String actual = new String(CircuitMoves.move(circuit, sheet, request, gestures).reply,
                StandardCharsets.UTF_8);
            String expected = "{\"remove\":" + (delta < 0 ? "[\"w0\"]" : "[]")
                + ",\"add\":[[" + point(delta < 0 ? x : x + 100, y, transpose)
                + "," + point(x + 100 + delta, y, transpose) + "]],\"unconnected\":[]}";
            if (!actual.equals(expected)) throw new AssertionError(
                "origin=" + x + "," + y + " transpose=" + transpose + " delta=" + delta
                + "\nexpected " + expected + "\nactual   " + actual);
            request.setAttribute("connect", "false");
            String detached = new String(CircuitMoves.move(circuit, sheet, request, gestures).reply,
                StandardCharsets.UTF_8);
            if (!detached.equals("{\"remove\":[],\"add\":[],\"unconnected\":[]}"))
                throw new AssertionError("Detached move must not reconnect: " + detached);
        }
        if (circuit.getWires().size() != 2)
            throw new AssertionError("Preview changed the circuit");
    }

    public static void main(String[] args) {
        try {
            for (int x : new int[] {100, -300, -120})
                for (int y : new int[] {100, -200})
                    for (boolean transpose : new boolean[] {false, true}) check(x, y, transpose);
            System.out.println("PASS: wire moves shorten and extend in both axes across positive and negative coordinates");
            System.exit(0);
        } catch (Throwable error) {
            error.printStackTrace();
            System.exit(1);
        }
    }
}
