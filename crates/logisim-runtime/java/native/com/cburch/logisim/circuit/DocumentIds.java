package com.cburch.logisim.circuit;

import com.cburch.logisim.comp.Component;
import com.cburch.logisim.data.Location;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;

/**
 * The document's names for what a loaded project holds. The document
 * (crates/circuit-document) names every component and every wire element of
 * a circuit; nothing here invents a name. The host sends a circuit's
 * component ids in element order when the project loads whole, and the id of
 * each component it adds with a change. A whole load adds a circuit's
 * components in element order (XmlCircuitReader), the order Circuit.comps
 * keeps, so the two lists pair up one to one.
 *
 * Wire {@code w<k>} is the circuit's k-th wire element, kept as its two ends.
 * The native wires a load makes of them are repaired (split at junctions,
 * merged where two meet in line with nothing else there), so a native wire
 * and a document wire are related by where they overlap: {@link
 * Sheet#covering} and {@link Sheet#natives}.
 */
public final class DocumentIds {
    private static final Field COMPS;

    static {
        try {
            COMPS = Circuit.class.getDeclaredField("comps");
            COMPS.setAccessible(true);
        } catch (ReflectiveOperationException error) {
            throw new IllegalStateException(error);
        }
    }

    /** A stretch of a native wire between document wire ends, and the document wire on it. */
    public static final class Atom {
        public final Location from, to;
        /** The native wire it is part of: its bundle is the atom's. */
        public final Wire wire;
        /** The lowest-numbered document wire over it; null when none is. */
        public final String id;
        final int index;

        Atom(Location from, Location to, Wire wire, int index) {
            this.from = from;
            this.to = to;
            this.wire = wire;
            this.index = index;
            this.id = index < 0 ? null : wireId(index);
        }
    }

    /** One circuit: its components by id and its wire elements in order. */
    public static final class Sheet {
        private final Map<String, Component> components = new HashMap<>();
        private final Map<Component, String> ids = new IdentityHashMap<>();
        /** Wire elements in file order, {x0, y0, x1, y1} each. */
        private int[][] wires = new int[0][];
        /** Wires with length by line: "h<y>" and "v<x>" to their indices. */
        private Map<String, int[]> lines;

        public Component component(String id) { return components.get(id); }
        public String id(Component component) { return ids.get(component); }
        /** Every component's id. */
        public Map<Component, String> ids() { return ids; }

        public int wireCount() { return wires.length; }
        public Location from(int k) { return Location.create(wires[k][0], wires[k][1]); }
        public Location to(int k) { return Location.create(wires[k][2], wires[k][3]); }
        /** Whether wire k has length: one of none is no native wire. */
        public boolean conducts(int k) { return wires[k][0] != wires[k][2] || wires[k][1] != wires[k][3]; }
        /** The index of a wire id, or -1. */
        public int wire(String id) {
            if (!id.startsWith("w")) return -1;
            try {
                int k = Integer.parseInt(id.substring(1));
                return k >= 0 && k < wires.length && id.equals(wireId(k)) ? k : -1;
            } catch (NumberFormatException error) {
                return -1;
            }
        }
        /** The native wires the document's wires make, before any repair: those with length. */
        public List<Wire> nativeWires() {
            List<Wire> result = new ArrayList<>(wires.length);
            for (int k = 0; k < wires.length; k++) if (conducts(k)) result.add(Wire.create(from(k), to(k)));
            return result;
        }

        public void put(String id, Component component) {
            Component previous = components.put(id, component);
            if (previous != null) ids.remove(previous);
            ids.put(component, id);
        }
        public Component remove(String id) {
            Component component = components.remove(id);
            if (component != null) ids.remove(component);
            return component;
        }
        public void wires(int[][] wires) {
            this.wires = wires;
            lines = null;
        }

        private static String line(boolean vertical, int at) { return (vertical ? "v" : "h") + at; }

        /** Low and high end of wire k along its line. */
        private int low(int k) { return wires[k][0] == wires[k][2] ? Math.min(wires[k][1], wires[k][3]) : Math.min(wires[k][0], wires[k][2]); }
        private int high(int k) { return wires[k][0] == wires[k][2] ? Math.max(wires[k][1], wires[k][3]) : Math.max(wires[k][0], wires[k][2]); }

        private Map<String, int[]> lines() {
            if (lines != null) return lines;
            Map<String, List<Integer>> found = new HashMap<>();
            for (int k = 0; k < wires.length; k++) {
                if (!conducts(k)) continue;
                boolean vertical = wires[k][0] == wires[k][2];
                found.computeIfAbsent(line(vertical, vertical ? wires[k][0] : wires[k][1]), x -> new ArrayList<>()).add(k);
            }
            lines = new HashMap<>();
            for (Map.Entry<String, List<Integer>> entry : found.entrySet())
                lines.put(entry.getKey(), entry.getValue().stream().mapToInt(Integer::intValue).toArray());
            return lines;
        }

        /** The document wires that overlap a native wire over some length, in file order. */
        public int[] covering(Wire wire) {
            Location a = wire.getEnd0(), b = wire.getEnd1();
            boolean vertical = a.getX() == b.getX();
            int[] candidates = lines().get(line(vertical, vertical ? a.getX() : a.getY()));
            if (candidates == null) return new int[0];
            int lo = vertical ? Math.min(a.getY(), b.getY()) : Math.min(a.getX(), b.getX());
            int hi = vertical ? Math.max(a.getY(), b.getY()) : Math.max(a.getX(), b.getX());
            int[] result = new int[candidates.length];
            int n = 0;
            for (int k : candidates) if (Math.max(lo, low(k)) < Math.min(hi, high(k))) result[n++] = k;
            return Arrays.copyOf(result, n);
        }

        /** The native wires of the circuit that overlap document wire k over some length. */
        public List<Wire> natives(Circuit circuit, int k) {
            List<Wire> result = new ArrayList<>();
            if (!conducts(k)) return result;
            boolean vertical = wires[k][0] == wires[k][2];
            int at = vertical ? wires[k][0] : wires[k][1];
            for (Wire wire : circuit.getWires()) {
                Location a = wire.getEnd0(), b = wire.getEnd1();
                if ((a.getX() == b.getX()) != vertical) continue;
                if ((vertical ? a.getX() : a.getY()) != at) continue;
                int lo = vertical ? Math.min(a.getY(), b.getY()) : Math.min(a.getX(), b.getX());
                int hi = vertical ? Math.max(a.getY(), b.getY()) : Math.max(a.getX(), b.getX());
                if (Math.max(lo, low(k)) < Math.min(hi, high(k))) result.add(wire);
            }
            return result;
        }

        /**
         * The circuit's native wires cut at every document wire end inside
         * them, each piece named by the lowest-numbered document wire over it;
         * ordered by that number, then along the wire. Pieces meet only at
         * their ends, as native wires do, so a crossing without an end is no
         * connection here either.
         */
        public List<Atom> atoms(Circuit circuit) {
            List<Atom> result = new ArrayList<>();
            for (Wire wire : new java.util.LinkedHashSet<Wire>(circuit.getWires())) {
                Location a = wire.getEnd0(), b = wire.getEnd1();
                boolean vertical = a.getX() == b.getX();
                int lo = vertical ? a.getY() : a.getX(), hi = vertical ? b.getY() : b.getX();
                if (lo > hi) { int t = lo; lo = hi; hi = t; }
                int[] over = covering(wire);
                java.util.TreeSet<Integer> cuts = new java.util.TreeSet<>();
                cuts.add(lo);
                cuts.add(hi);
                for (int k : over) {
                    if (low(k) > lo && low(k) < hi) cuts.add(low(k));
                    if (high(k) > lo && high(k) < hi) cuts.add(high(k));
                }
                Integer previous = null;
                for (int cut : cuts) {
                    if (previous != null) {
                        int index = -1;
                        for (int k : over) if (low(k) <= previous && high(k) >= cut) { index = k; break; }
                        Location from = vertical ? Location.create(a.getX(), previous) : Location.create(previous, a.getY());
                        Location to = vertical ? Location.create(a.getX(), cut) : Location.create(cut, a.getY());
                        result.add(new Atom(from, to, wire, index));
                    }
                    previous = cut;
                }
            }
            result.sort((x, y) -> {
                int byIndex = Integer.compare(x.index < 0 ? Integer.MAX_VALUE : x.index, y.index < 0 ? Integer.MAX_VALUE : y.index);
                if (byIndex != 0) return byIndex;
                int byY = Integer.compare(x.from.getY(), y.from.getY());
                return byY != 0 ? byY : Integer.compare(x.from.getX(), y.from.getX());
            });
            return result;
        }
    }

    public static String wireId(int k) { return "w" + k; }

    private final Map<Circuit, Sheet> sheets = new IdentityHashMap<>();

    /** The circuit's names; empty for a circuit the document does not list. */
    public Sheet sheet(Circuit circuit) {
        return sheets.computeIfAbsent(circuit, k -> new Sheet());
    }

    /**
     * Names a circuit loaded whole: `ids` are the document's component ids in
     * element order, paired with the circuit's components in the order the
     * load added them.
     */
    @SuppressWarnings("unchecked")
    public void loaded(Circuit circuit, String[] ids, int[][] wires) {
        List<Component> order;
        try {
            order = (List<Component>) COMPS.get(circuit);
        } catch (IllegalAccessException error) {
            throw new IllegalStateException(error);
        }
        if (order.size() != ids.length)
            throw new IllegalStateException("电路 \"" + circuit.getName() + "\" 载入了 " + order.size()
                + " 个元件，文档有 " + ids.length + " 个");
        Sheet sheet = new Sheet();
        for (int i = 0; i < ids.length; i++) sheet.put(ids[i], order.get(i));
        sheet.wires(wires);
        sheets.put(circuit, sheet);
    }

    /** Ids as the host writes them: space-separated. */
    public static String[] split(String text) {
        text = text.trim();
        return text.isEmpty() ? new String[0] : text.split(" +");
    }

    /** Wires as the host writes them: "x0,y0,x1,y1" separated by spaces. */
    public static int[][] wires(String text) {
        String[] items = split(text);
        int[][] wires = new int[items.length][];
        for (int i = 0; i < items.length; i++) {
            String[] parts = items[i].split(",");
            if (parts.length != 4) throw new IllegalArgumentException("无效的导线: " + items[i]);
            wires[i] = new int[] {Integer.parseInt(parts[0]), Integer.parseInt(parts[1]),
                Integer.parseInt(parts[2]), Integer.parseInt(parts[3])};
        }
        return wires;
    }

    /** The components with these ids; an unknown id is an error naming it. */
    public static List<Component> components(Sheet sheet, Collection<String> ids) {
        List<Component> result = new ArrayList<>(ids.size());
        for (String id : ids) {
            Component component = sheet.component(id);
            if (component == null) throw new IllegalArgumentException("找不到元件: " + id);
            result.add(component);
        }
        return result;
    }

    /** The component with this id; an unknown id is an error naming it. */
    public static Component component(Sheet sheet, String id) {
        Component component = sheet.component(id);
        if (component == null) throw new IllegalArgumentException("找不到元件: " + id);
        return component;
    }
}
