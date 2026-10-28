package com.cburch.logisim.circuit;

import com.cburch.logisim.comp.Component;
import com.cburch.logisim.comp.EndData;
import com.cburch.logisim.data.Bounds;
import com.cburch.logisim.data.Location;
import com.cburch.logisim.file.LogisimFile;
import com.cburch.logisim.instance.Instance;
import com.cburch.logisim.instance.Port;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.w3c.dom.Element;
import org.w3c.dom.Node;

/**
 * What the editor's connection panel and signal tracing read about chosen
 * objects of one circuit: the bit nets they are on, every component end on
 * those nets, and the wire bundles and wires the nets pass through. It is the
 * part of an observation's focus (components, wires, wireBundles, bitNets)
 * those objects need, with the same IDs; the chosen components come whole,
 * the others on their nets marked partial with only the ends on them and
 * without those ends' net bits, which the nets' contacts hold. The circuit's
 * nets are computed once per loaded revision (ExactRuntimeObserver.NetIndex);
 * a request only picks its part and writes it.
 *
 * Request children: {@code <component x y factory/>} (every component of that
 * factory at that location), {@code <wire x0 y0 x1 y1/>} (the wire between
 * those points, either way round), {@code <point x y radius/>} (every
 * component with an end that close). Reply (JSON): {"focus": {components, wires, wireBundles, bitNets}};
 * crates/logisim-runtime/README.md, Connections, has the fields.
 */
public final class CircuitConnections {
    private static final class Contact {
        final Component component;
        final int end, bit;

        Contact(Component component, int end, int bit) {
            this.component = component;
            this.end = end;
            this.bit = bit;
        }
    }

    private final Map<Component, String> ids;
    private final ExactRuntimeObserver.NetIndex nets;
    /** Each component's place in observation order. */
    private final Map<Component, Integer> order = new IdentityHashMap<>();
    private final Map<String, List<Component>> placed = new HashMap<>();
    private final Map<String, Wire> wires = new HashMap<>();
    private final Map<String, Wire> wiresById = new HashMap<>();
    private final Map<String, ExactRuntimeObserver.NetRecord> netsById = new HashMap<>();
    private final Map<String, List<Contact>> contacts = new HashMap<>();
    /** The bit net of each bit of each end of each component (null where none). */
    private final Map<Component, String[][]> endNets = new IdentityHashMap<>();
    /** Each component's ends as JSON without their net bits, and the net bits, written when first asked for. */
    private final Map<Component, String[][]> ends = new IdentityHashMap<>();

    private CircuitConnections(Circuit circuit) {
        List<Component> sorted = ExactRuntimeObserver.sortedComponents(circuit);
        for (int i = 0; i < sorted.size(); i++) order.put(sorted.get(i), i);
        ids = ExactRuntimeObserver.assignComponentIds(circuit);
        com.cburch.logisim.file.WorkerTiming.mark("connections.ids");
        nets = new ExactRuntimeObserver.NetIndex(
            circuit, ids, new ExactRuntimeObserver.Coverage(), new ArrayList<Object>(), false);
        nets.compute();
        com.cburch.logisim.file.WorkerTiming.mark("connections.nets");
        for (Component component : sorted) {
            placed.computeIfAbsent(place(component.getLocation(), component.getFactory().getName()),
                k -> new ArrayList<>()).add(component);
            String[][] bits = netsOf(component);
            endNets.put(component, bits);
            for (int end = 0; end < bits.length; end++)
                for (int bit = 0; bit < bits[end].length; bit++)
                    if (bits[end][bit] != null)
                        contacts.computeIfAbsent(bits[end][bit], k -> new ArrayList<>())
                            .add(new Contact(component, end, bit));
        }
        // In observe's order.
        Comparator<Contact> byId = Comparator.comparing((Contact contact) -> ids.get(contact.component))
            .thenComparingInt(contact -> contact.end).thenComparingInt(contact -> contact.bit);
        for (List<Contact> joined : contacts.values()) joined.sort(byId);
        for (ExactRuntimeObserver.NetRecord net : nets.threadNets.values()) netsById.put(net.id, net);
        for (ExactRuntimeObserver.NetRecord net : nets.pointNets.values()) netsById.put(net.id, net);
        for (Wire wire : nets.wires) {
            wiresById.put(nets.wireIds.get(wire), wire);
            wires.put(span(wire.getEnd0(), wire.getEnd1()), wire);
            wires.put(span(wire.getEnd1(), wire.getEnd0()), wire);
        }
    }

    /** The nets of a component's end bits, as NetIndex assigns them (its endBitNet). */
    private String[][] netsOf(Component component) {
        String[][] bits = new String[component.getEnds().size()][];
        for (int end = 0; end < bits.length; end++) {
            EndData data = component.getEnd(end);
            int width = ExactRuntimeObserver.width(data.getWidth());
            bits[end] = new String[Math.max(0, width)];
            WireBundle bundle = nets.circuit.wires.getWireBundle(data.getLocation());
            if (bundle != null && (!bundle.isValid() || bundle.threads == null)) continue;
            for (int bit = 0; bit < width; bit++) {
                ExactRuntimeObserver.NetRecord net = bundle == null
                    ? nets.pointNets.get(data.getLocation().getX() + "," + data.getLocation().getY() + "#" + bit)
                    : bit < bundle.threads.length ? nets.threadNets.get(bundle.threads[bit].find()) : null;
                if (net != null) bits[end][bit] = net.id;
            }
        }
        return bits;
    }

    /** The connections of a circuit of the file as it is now. */
    public static CircuitConnections of(LogisimFile file, String name) {
        Circuit circuit = file.getCircuit(name);
        if (circuit == null) throw new IllegalArgumentException("找不到电路");
        return new CircuitConnections(circuit);
    }

    private static String place(Location at, String factory) {
        return at.getX() + "," + at.getY() + "," + factory;
    }

    private static String span(Location from, Location to) {
        return from.getX() + "," + from.getY() + "," + to.getX() + "," + to.getY();
    }

    /** The answer to one request: the seeds' nets and what they join. */
    public byte[] answer(Element request) {
        Set<Component> whole = Collections.newSetFromMap(new IdentityHashMap<>());
        Set<String> netIds = new LinkedHashSet<>();
        Set<ExactRuntimeObserver.BundleRecord> bundles = Collections.newSetFromMap(new IdentityHashMap<>());
        for (Node n = request.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (!(n instanceof Element)) continue;
            Element seed = (Element) n;
            switch (seed.getTagName()) {
                case "component": {
                    List<Component> found = placed.get(seed.getAttribute("x") + "," + seed.getAttribute("y")
                        + "," + seed.getAttribute("factory"));
                    if (found != null) whole.addAll(found);
                    break;
                }
                case "wire": {
                    Wire wire = wires.get(seed.getAttribute("x0") + "," + seed.getAttribute("y0") + ","
                        + seed.getAttribute("x1") + "," + seed.getAttribute("y1"));
                    ExactRuntimeObserver.BundleRecord bundle = wire == null ? null : bundleOf(wire);
                    if (bundle == null) break;
                    bundles.add(bundle);
                    if (bundle.bundle.threads != null)
                        for (WireThread thread : bundle.bundle.threads) {
                            ExactRuntimeObserver.NetRecord net = nets.threadNets.get(thread.find());
                            if (net != null) netIds.add(net.id);
                        }
                    break;
                }
                case "point": {
                    int x = Integer.parseInt(seed.getAttribute("x")), y = Integer.parseInt(seed.getAttribute("y"));
                    double radius = Double.parseDouble(seed.getAttribute("radius"));
                    for (Component component : order.keySet())
                        for (EndData end : component.getEnds()) {
                            Location at = end.getLocation();
                            if (Math.hypot(at.getX() - x, at.getY() - y) <= radius) whole.add(component);
                        }
                    break;
                }
                default:
                    throw new IllegalArgumentException("未知的连接种子: " + seed.getTagName());
            }
        }
        for (Component component : whole)
            for (String[] bits : endNets.get(component))
                for (String net : bits)
                    if (net != null) netIds.add(net);
        // Every end on the nets, and every bundle they pass through.
        Map<Component, BitSet> partial = new IdentityHashMap<>();
        for (String id : netIds) {
            for (Contact contact : contacts.getOrDefault(id, Collections.emptyList()))
                if (!whole.contains(contact.component))
                    partial.computeIfAbsent(contact.component, k -> new BitSet()).set(contact.end);
            ExactRuntimeObserver.NetRecord net = netsById.get(id);
            if (net == null || net.root == null) continue;
            for (CircuitWires.ThreadBundle slice : net.root.getBundles()) {
                ExactRuntimeObserver.BundleRecord bundle = nets.bundles.get(slice.b.find());
                if (bundle != null) bundles.add(bundle);
            }
        }

        StringBuilder out = new StringBuilder(16 * 1024).append("{\"focus\":{\"components\":[");
        List<Component> listed = new ArrayList<>(whole);
        listed.addAll(partial.keySet());
        listed.sort(Comparator.comparingInt(order::get));
        for (int i = 0; i < listed.size(); i++) {
            if (i > 0) out.append(',');
            component(out, listed.get(i), partial.get(listed.get(i)));
        }
        out.append("],\"wires\":[");
        List<String> wireIds = new ArrayList<>();
        for (ExactRuntimeObserver.BundleRecord bundle : bundles) wireIds.addAll(bundle.wireIds);
        Collections.sort(wireIds);
        for (int i = 0; i < wireIds.size(); i++) {
            if (i > 0) out.append(',');
            Wire wire = wiresById.get(wireIds.get(i));
            ExactRuntimeObserver.BundleRecord bundle = bundleOf(wire);
            out.append("{\"wireId\":");
            str(out, wireIds.get(i));
            out.append(",\"from\":");
            point(out, wire.getEnd0());
            out.append(",\"to\":");
            point(out, wire.getEnd1());
            out.append(",\"bundleId\":");
            if (bundle == null) out.append("null");
            else str(out, bundle.id);
            out.append('}');
        }
        out.append("],\"wireBundles\":[");
        List<ExactRuntimeObserver.BundleRecord> sortedBundles = new ArrayList<>(bundles);
        sortedBundles.sort(Comparator.comparing(bundle -> bundle.id));
        for (int i = 0; i < sortedBundles.size(); i++) {
            if (i > 0) out.append(',');
            bundle(out, sortedBundles.get(i));
        }
        out.append("],\"bitNets\":[");
        List<String> sortedNets = new ArrayList<>(netIds);
        Collections.sort(sortedNets);
        for (int i = 0; i < sortedNets.size(); i++) {
            if (i > 0) out.append(',');
            out.append("{\"netId\":");
            str(out, sortedNets.get(i));
            out.append(",\"contacts\":[");
            List<Contact> joined = contacts.getOrDefault(sortedNets.get(i), Collections.emptyList());
            for (int k = 0; k < joined.size(); k++) {
                Contact contact = joined.get(k);
                if (k > 0) out.append(',');
                out.append("{\"componentId\":");
                str(out, ids.get(contact.component));
                out.append(",\"endIndex\":").append(contact.end).append(",\"bit\":").append(contact.bit).append('}');
            }
            out.append("]}");
        }
        return out.append("]}}").toString().getBytes(StandardCharsets.UTF_8);
    }

    private ExactRuntimeObserver.BundleRecord bundleOf(Wire wire) {
        WireBundle bundle = nets.circuit.wires.getWireBundle(wire.getEnd0());
        return bundle == null ? null : nets.bundles.get(bundle.find());
    }

    /**
     * A component with all its ends, or marked partial with only the ends in
     * `only` and without their net bits, which the nets' contacts hold.
     */
    private void component(StringBuilder out, Component component, BitSet only) {
        String factory = component.getFactory().getName();
        out.append("{\"componentId\":");
        str(out, ids.get(component));
        out.append(",\"factoryName\":");
        str(out, factory);
        String display = ExactRuntimeObserver.safeDisplayName(component.getFactory());
        if (display != null && !display.equals(factory)) {
            out.append(",\"displayName\":");
            str(out, display);
        }
        String label = ExactRuntimeObserver.componentLabel(component);
        if (label != null) {
            out.append(",\"selector\":{\"label\":");
            str(out, label);
            out.append('}');
        }
        out.append(",\"location\":");
        point(out, component.getLocation());
        Bounds bounds = component.getBounds();
        out.append(",\"bounds\":{\"x\":").append(bounds.getX()).append(",\"y\":").append(bounds.getY())
            .append(",\"width\":").append(bounds.getWidth()).append(",\"height\":").append(bounds.getHeight())
            .append('}');
        if (only != null) out.append(",\"partial\":true");
        out.append(",\"ends\":[");
        String[][] written = endsOf(component);
        boolean first = true;
        for (int i = 0; i < written[0].length; i++) {
            if (only != null && !only.get(i)) continue;
            if (!first) out.append(',');
            first = false;
            out.append(written[0][i]);
            if (only == null) out.append(written[1][i]);
            out.append('}');
        }
        out.append("]}");
    }

    private String[][] endsOf(Component component) {
        String[][] written = ends.get(component);
        if (written != null) return written;
        Instance instance = ExactRuntimeObserver.instanceOrNull(component);
        List<Port> ports = instance == null ? Collections.<Port>emptyList() : instance.getPorts();
        String[][] bits = endNets.get(component);
        written = new String[2][component.getEnds().size()];
        for (int index = 0; index < written[0].length; index++) {
            EndData end = component.getEnd(index);
            StringBuilder out = new StringBuilder(160);
            out.append("{\"index\":").append(index).append(",\"location\":");
            point(out, end.getLocation());
            int width = ExactRuntimeObserver.width(end.getWidth());
            out.append(",\"width\":").append(width < 0 ? "null" : Integer.toString(width));
            Map<String, Object> direction = new HashMap<>();
            NativePortSemantics.putDirection(direction, component, index);
            out.append(",\"direction\":");
            str(out, String.valueOf(direction.get("direction")));
            String role = ExactRuntimeObserver.semanticRole(component, index);
            if (role != null) {
                out.append(",\"semanticRole\":");
                str(out, role);
            }
            String tooltip = null;
            if (index < ports.size()) {
                try {
                    tooltip = ExactRuntimeObserver.emptyToNull(ports.get(index).getToolTip());
                } catch (Throwable ignored) {
                    tooltip = null;
                }
            }
            if (tooltip != null) {
                out.append(",\"runtimeTooltip\":");
                str(out, tooltip);
            }
            written[0][index] = out.toString();
            out.setLength(0);
            out.append(",\"netBits\":[");
            boolean first = true;
            for (int bit = 0; bit < bits[index].length; bit++) {
                String net = bits[index][bit];
                if (net == null) continue;
                if (!first) out.append(',');
                first = false;
                out.append("{\"bit\":").append(bit).append(",\"netId\":");
                str(out, net);
                out.append('}');
            }
            written[1][index] = out.append(']').toString();
        }
        ends.put(component, written);
        return written;
    }

    private void bundle(StringBuilder out, ExactRuntimeObserver.BundleRecord record) {
        WireBundle bundle = record.bundle;
        out.append("{\"bundleId\":");
        str(out, record.id);
        out.append(",\"valid\":").append(bundle.isValid());
        int width = ExactRuntimeObserver.width(bundle.getWidth());
        out.append(",\"width\":").append(width < 0 ? "null" : Integer.toString(width));
        out.append(",\"wireIds\":[");
        for (int i = 0; i < record.wireIds.size(); i++) {
            if (i > 0) out.append(',');
            str(out, record.wireIds.get(i));
        }
        out.append("],\"bitNets\":[");
        if (bundle.threads != null)
            for (int bit = 0; bit < bundle.threads.length; bit++) {
                if (bit > 0) out.append(',');
                ExactRuntimeObserver.NetRecord net = nets.threadNets.get(bundle.threads[bit].find());
                out.append("{\"bit\":").append(bit).append(",\"netId\":");
                if (net == null) out.append("null");
                else str(out, net.id);
                out.append('}');
            }
        out.append("]}");
    }

    private static void point(StringBuilder out, Location at) {
        out.append("{\"x\":").append(at.getX()).append(",\"y\":").append(at.getY()).append('}');
    }

    private static void str(StringBuilder out, String value) {
        ExactRuntimeObserver.Json.string(value, out);
    }
}
