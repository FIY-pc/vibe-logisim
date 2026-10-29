package com.cburch.logisim.circuit;

import com.cburch.logisim.comp.Component;
import com.cburch.logisim.data.Location;
import com.cburch.logisim.proj.Project;
import com.cburch.logisim.tools.move.MoveGesture;
import com.cburch.logisim.tools.move.MoveResult;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.locks.Lock;
import org.w3c.dom.Element;

/**
 * A move of components and wires as Logisim's select tool makes one: its
 * MoveGesture finds the wires that keep the moved ends connected to what
 * they were connected to (MoveGesture.forceRequest, as SelectTool does when
 * the mouse is released), and the move is the translation plus that
 * replacement of wires. Nothing here changes the loaded circuit for good.
 *
 * Request {@code <move circuit dx dy connect components wires/>}: the ids to
 * move, space-separated; connect="false" moves without keeping connections
 * (Logisim's shift-drag). Reply (JSON): {"remove": [wire ids], "add":
 * [[x0, y0, x1, y1], …], "unconnected": [[x, y], …]}: the document wires the
 * move takes out (a wire that keeps a part comes back as that part in "add"),
 * the segments it adds, at their place after the move, and where a moved end
 * touched something the gesture found no route back to (the end's place
 * before the move; SelectTool marks it there and at the end's new place).
 */
public final class CircuitMoves {
    private CircuitMoves() {}

    /** The reply, and whether the circuit's wires were split and restored on the way (its caches are stale). */
    public static final class Moved {
        public final byte[] reply;
        public final boolean disturbed;

        Moved(byte[] reply, boolean disturbed) {
            this.reply = reply;
            this.disturbed = disturbed;
        }
    }

    public static Moved move(Circuit circuit, DocumentIds.Sheet sheet, Element request, Map<String, MoveGesture> gestures) {
        int dx = Integer.parseInt(request.getAttribute("dx")), dy = Integer.parseInt(request.getAttribute("dy"));
        String[] componentIds = DocumentIds.split(request.getAttribute("components"));
        String[] wireIds = DocumentIds.split(request.getAttribute("wires"));
        Set<Component> selected = new LinkedHashSet<>(DocumentIds.components(sheet, Arrays.asList(componentIds)));
        boolean[] chosen = new boolean[sheet.wireCount()];
        for (String id : wireIds) {
            int k = sheet.wire(id);
            if (k < 0) throw new IllegalArgumentException("找不到导线: " + id);
            chosen[k] = true;
        }
        if ("false".equals(request.getAttribute("connect")) || dx == 0 && dy == 0)
            return new Moved(reply(Collections.emptyList(), Collections.emptyList(), Collections.emptyList()), false);
        // A native wire that only partly lies on moved wires (two wires in line
        // that the load merged) is split there for the gesture, then put back.
        Set<Wire> partial = new LinkedHashSet<>();
        for (int k = 0; k < chosen.length; k++) {
            if (!chosen[k]) continue;
            for (Wire wire : sheet.natives(circuit, k)) {
                if (covered(sheet, chosen, wire)) selected.add(wire);
                else partial.add(wire);
            }
        }
        MoveResult result;
        if (partial.isEmpty()) {
            List<String> key = new ArrayList<>(Arrays.asList(componentIds));
            key.addAll(Arrays.asList(wireIds));
            Collections.sort(key);
            String name = circuit.getName() + "\n" + String.join(" ", key);
            MoveGesture gesture = gestures.get(name);
            if (gesture == null) {
                gesture = new MoveGesture(null, circuit, selected);
                gestures.put(name, gesture);
            }
            result = gesture.forceRequest(dx, dy);
        } else {
            List<Wire> pieces = new ArrayList<>();
            for (Wire wire : partial) {
                for (Wire piece : pieces(sheet, wire)) {
                    pieces.add(piece);
                    if (covered(sheet, chosen, piece)) selected.add(piece);
                }
            }
            replace(circuit, partial, pieces);
            try {
                result = new MoveGesture(null, circuit, selected).forceRequest(dx, dy);
            } finally {
                replace(circuit, pieces, partial);
            }
        }
        if (result == null) throw new IllegalStateException("移动被中断");
        List<Wire> removed = new ArrayList<>(), added = new ArrayList<>();
        ReplacementMap replacements = result.getReplacementMap();
        for (Component component : replacements.getRemovals()) if (component instanceof Wire) removed.add((Wire) component);
        for (Component component : replacements.getAdditions()) if (component instanceof Wire) added.add((Wire) component);
        return new Moved(document(sheet, chosen, removed, added, result.getUnconnectedLocations()), !partial.isEmpty());
    }

    /** Whether the moved document wires cover a native wire end to end. */
    private static boolean covered(DocumentIds.Sheet sheet, boolean[] chosen, Wire wire) {
        int[] span = span(wire);
        List<int[]> runs = new ArrayList<>();
        for (int k : sheet.covering(wire)) if (chosen[k]) runs.add(span(sheet.from(k), sheet.to(k)));
        return subtract(span, runs).isEmpty();
    }

    /** A native wire cut at every document wire end inside it. */
    private static List<Wire> pieces(DocumentIds.Sheet sheet, Wire wire) {
        int[] span = span(wire);
        TreeSet<Integer> cuts = new TreeSet<>(Arrays.asList(span[0], span[1]));
        for (int k : sheet.covering(wire)) {
            for (int end : span(sheet.from(k), sheet.to(k))) if (end > span[0] && end < span[1]) cuts.add(end);
        }
        List<Wire> result = new ArrayList<>();
        Integer previous = null;
        for (int cut : cuts) {
            if (previous != null) result.add(segment(wire, previous, cut));
            previous = cut;
        }
        return result;
    }

    /** Takes wires out and puts others in without a transaction's repair: the gesture sees them as they are. */
    private static void replace(Circuit circuit, Iterable<Wire> out, Iterable<Wire> in) {
        CircuitTransaction access = new CircuitTransaction() {
            @Override protected Map<Circuit, Integer> getAccessedCircuits() {
                return Collections.singletonMap(circuit, READ_WRITE);
            }
            @Override protected void run(CircuitMutator mutator, Project project) {}
        };
        Map<Circuit, Lock> locks = CircuitLocker.acquireLocks(access, new CircuitMutatorImpl());
        try {
            for (Wire wire : out) circuit.mutatorRemove(wire);
            for (Wire wire : in) circuit.mutatorAdd(wire);
        } finally {
            CircuitLocker.releaseLocks(locks);
        }
    }

    /**
     * The gesture's replacement in document terms: each document wire that a
     * removed native wire overlaps goes, and what is left of it comes back;
     * the added wires come as they are.
     */
    private static byte[] document(DocumentIds.Sheet sheet, boolean[] chosen, List<Wire> removed, List<Wire> added,
            java.util.Collection<Location> unconnected) {
        Set<Wire> kept = new HashSet<>(removed);
        kept.retainAll(added);
        TreeSet<Integer> affected = new TreeSet<>();
        for (Wire wire : removed) {
            if (kept.contains(wire)) continue;
            for (int k : sheet.covering(wire)) if (!chosen[k]) affected.add(k);
        }
        List<String> remove = new ArrayList<>();
        List<int[]> add = new ArrayList<>();
        for (int k : affected) {
            Location from = sheet.from(k), to = sheet.to(k);
            int[] span = span(from, to);
            boolean vertical = from.getX() == to.getX();
            List<int[]> cut = new ArrayList<>();
            for (Wire wire : removed) {
                if (kept.contains(wire)) continue;
                Location a = wire.getEnd0(), b = wire.getEnd1();
                if ((a.getX() == b.getX()) != vertical || (vertical ? a.getX() != from.getX() : a.getY() != from.getY())) continue;
                cut.add(span(wire));
            }
            List<int[]> runs = subtract(span, cut);
            if (runs.size() == 1 && runs.get(0)[0] == span[0] && runs.get(0)[1] == span[1]) continue;
            remove.add(DocumentIds.wireId(k));
            for (int[] run : runs) {
                Location a = vertical ? Location.create(from.getX(), run[0]) : Location.create(run[0], from.getY());
                Location b = vertical ? Location.create(from.getX(), run[1]) : Location.create(run[1], from.getY());
                add.add(new int[] {a.getX(), a.getY(), b.getX(), b.getY()});
            }
        }
        for (Wire wire : added) {
            if (kept.contains(wire)) continue;
            add.add(new int[] {wire.getEnd0().getX(), wire.getEnd0().getY(), wire.getEnd1().getX(), wire.getEnd1().getY()});
        }
        return reply(remove, add, unconnected);
    }

    private static byte[] reply(List<String> remove, List<int[]> add, java.util.Collection<Location> unconnected) {
        StringBuilder out = new StringBuilder(256).append("{\"remove\":[");
        for (int i = 0; i < remove.size(); i++) {
            if (i > 0) out.append(',');
            out.append('"').append(remove.get(i)).append('"');
        }
        out.append("],\"add\":[");
        for (int i = 0; i < add.size(); i++) {
            if (i > 0) out.append(',');
            int[] w = add.get(i);
            out.append('[').append(w[0]).append(',').append(w[1]).append(',').append(w[2]).append(',').append(w[3]).append(']');
        }
        out.append("],\"unconnected\":[");
        boolean first = true;
        for (Location at : new TreeSet<Location>(unconnected)) {
            if (!first) out.append(',');
            first = false;
            out.append('[').append(at.getX()).append(',').append(at.getY()).append(']');
        }
        return out.append("]}").toString().getBytes(StandardCharsets.UTF_8);
    }

    private static int[] span(Wire wire) { return span(wire.getEnd0(), wire.getEnd1()); }

    /** Low and high coordinate along the line of a horizontal or vertical segment. */
    private static int[] span(Location a, Location b) {
        boolean vertical = a.getX() == b.getX();
        int p = vertical ? a.getY() : a.getX(), q = vertical ? b.getY() : b.getX();
        return new int[] {Math.min(p, q), Math.max(p, q)};
    }

    private static Wire segment(Wire on, int from, int to) {
        Location a = on.getEnd0();
        boolean vertical = a.getX() == on.getEnd1().getX();
        return vertical ? Wire.create(Location.create(a.getX(), from), Location.create(a.getX(), to))
            : Wire.create(Location.create(from, a.getY()), Location.create(to, a.getY()));
    }

    /** What is left of [lo, hi] once the spans are taken out, as runs of length. */
    private static List<int[]> subtract(int[] span, List<int[]> spans) {
        List<int[]> sorted = new ArrayList<>(spans);
        sorted.sort((a, b) -> Integer.compare(a[0], b[0]));
        List<int[]> runs = new ArrayList<>();
        int at = span[0];
        for (int[] s : sorted) {
            if (s[1] <= at) continue;
            if (s[0] > at) runs.add(new int[] {at, Math.min(s[0], span[1])});
            at = Math.max(at, s[1]);
            if (at >= span[1]) break;
        }
        if (at < span[1]) runs.add(new int[] {at, span[1]});
        runs.removeIf(run -> run[1] <= run[0]);
        return runs;
    }
}
