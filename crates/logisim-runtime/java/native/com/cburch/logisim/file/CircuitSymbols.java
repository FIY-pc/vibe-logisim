package com.cburch.logisim.file;

import com.cburch.logisim.circuit.Circuit;
import com.cburch.logisim.circuit.CircuitState;
import com.cburch.logisim.circuit.NativePortSemantics;
import com.cburch.logisim.circuit.WireWidths;
import com.cburch.logisim.comp.Component;
import com.cburch.logisim.comp.ComponentDrawContext;
import com.cburch.logisim.comp.EndData;
import com.cburch.logisim.data.Attribute;
import com.cburch.logisim.data.AttributeSet;
import com.cburch.logisim.data.Bounds;
import com.cburch.logisim.data.Location;
import com.cburch.logisim.proj.Project;
import com.cburch.logisim.tools.AddTool;
import java.awt.Color;
import java.awt.Graphics;
import java.awt.RenderingHints;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import org.w3c.dom.Element;
import org.w3c.dom.Node;

/**
 * The picture of each kind of component, recorded once from the runtime's own
 * painting (Component.draw) as vector ops the window replays. A kind is drawn
 * from a component of the circuit when the host names one by location and
 * factory, or from one made of its library tool and attributes otherwise. The
 * draw context is CircuitRenderer's (print view, no state, colors on) except
 * for its circuit, which answers every connection question with yes and has the
 * recorder mark what depends on the answer (see RecordingGraphics2D "U").
 *
 * Reply (JSON): {"symbols": [{bounds, ink, ports, ops} | {error}], "widthErrors": [[x, y], …]};
 * bounds and ink are {x, y, width, height} relative to the component location,
 * bounds as Component.getBounds() and ink what the ops can touch; ports are
 * {index, x, y, width, direction}.
 */
final class CircuitSymbols {
    private CircuitSymbols() {}

    /** The circuit the recorded painting sees. */
    private static final class Probe extends Circuit {
        RecordingGraphics2D.Recording recording;
        int x, y;

        Probe() { super("symbol"); }

        @Override public boolean isConnected(Location at, Component ignore) {
            if (recording != null) recording.condition(at.getX() - x, at.getY() - y);
            return true;
        }
    }

    static byte[] describe(LogisimFile file, Project project, Element request) {
        Circuit circuit = file.getCircuit(request.getAttribute("circuit"));
        if (circuit == null) throw new IllegalArgumentException("找不到电路");
        Probe probe = new Probe();
        CircuitState own = project.getCircuitState(circuit);
        // Components made here are in no circuit; their painting keeps its data off the project.
        CircuitState loose = new CircuitState(project, probe);
        Map<String, Component> placed = null;
        StringBuilder out = new StringBuilder(32 * 1024).append("{\"symbols\":[");
        boolean first = true;
        for (Node n = request.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (!(n instanceof Element) || !((Element) n).getTagName().equals("symbol")) continue;
            Element item = (Element) n;
            if (!first) out.append(',');
            first = false;
            int start = out.length();
            try {
                if (item.hasAttribute("factory")) {
                    if (placed == null) placed = placed(circuit);
                    Component component = placed.get(item.getAttribute("x") + "," + item.getAttribute("y") + "," + item.getAttribute("factory"));
                    if (component == null) throw new IllegalArgumentException("元件已改变，请重新读取");
                    symbol(component, probe, own, out);
                }
                else symbol(create(file, request, item), probe, loose, out);
            } catch (Exception | LinkageError error) {
                out.setLength(start);
                out.append("{\"error\":");
                String message = error.getMessage();
                RecordingGraphics2D.str(out, message == null || message.isEmpty() ? error.toString() : message);
                out.append('}');
            } finally {
                probe.recording = null;
            }
        }
        out.append("],\"widthErrors\":[");
        first = true;
        for (Location point : WireWidths.conflicts(circuit)) {
            if (!first) out.append(',');
            first = false;
            out.append('[').append(point.getX()).append(',').append(point.getY()).append(']');
        }
        return out.append("]}").toString().getBytes(StandardCharsets.UTF_8);
    }

    /** The circuit's components by location and factory name, the first of a stack. */
    private static Map<String, Component> placed(Circuit circuit) {
        Map<String, Component> placed = new HashMap<>();
        for (Component c : circuit.getNonWires()) {
            Location at = c.getLocation();
            placed.putIfAbsent(at.getX() + "," + at.getY() + "," + c.getFactory().getName(), c);
        }
        return placed;
    }

    private static Component create(LogisimFile file, Element request, Element item) {
        AddTool tool = CircuitPalette.tool(file, item.getAttribute("library"), item.getAttribute("tool"), request);
        AttributeSet attrs = (AttributeSet) tool.getAttributeSet().clone();
        setAll(attrs, item);
        return tool.getFactory().createComponent(Location.create(0, 0), attrs);
    }

    /**
     * Sets every attribute the item names that the set has and can take, in as
     * many passes as attributes appear (a gate's inputs, a splitter's bits).
     * A key comes from a saved component or a template, so it carries values
     * the edit path does not take (fonts, read-only ones); a picture needs no
     * validation, only the same values.
     */
    @SuppressWarnings({"rawtypes", "unchecked"})
    private static void setAll(AttributeSet attrs, Element item) {
        Map<String, String> pending = new LinkedHashMap<>();
        for (Node n = item.getFirstChild(); n != null; n = n.getNextSibling())
            if (n instanceof Element && ((Element) n).getTagName().equals("set"))
                pending.put(((Element) n).getAttribute("name"), ((Element) n).getAttribute("value"));
        boolean progressed = true;
        while (progressed && !pending.isEmpty()) {
            progressed = false;
            for (Attribute attr : new ArrayList<Attribute<?>>(attrs.getAttributes())) {
                String raw = pending.remove(attr.getName());
                if (raw == null) continue;
                progressed = true;
                if (attrs.isReadOnly(attr)) continue;
                try {
                    Object value = attr.parse(raw);
                    if (value != null && !value.equals(attrs.getValue(attr))) attrs.setValue(attr, value);
                } catch (RuntimeException ignored) {
                    // A value this runtime cannot take: draw with its own.
                }
            }
        }
    }

    private static void box(StringBuilder out, double x, double y, double width, double height) {
        out.append("{\"x\":");
        RecordingGraphics2D.num(out, x);
        out.append(",\"y\":");
        RecordingGraphics2D.num(out, y);
        out.append(",\"width\":");
        RecordingGraphics2D.num(out, width);
        out.append(",\"height\":");
        RecordingGraphics2D.num(out, height);
        out.append('}');
    }

    private static void symbol(Component component, Probe probe, CircuitState state, StringBuilder out) {
        Location at = component.getLocation();
        RecordingGraphics2D.Recording recording = new RecordingGraphics2D.Recording();
        RecordingGraphics2D g = new RecordingGraphics2D(recording);
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.translate(-at.getX(), -at.getY());
        g.setColor(Color.BLACK);
        probe.recording = recording;
        probe.x = at.getX();
        probe.y = at.getY();
        ComponentDrawContext context = new ComponentDrawContext(null, probe, state, g, g, true);
        context.setShowState(false);
        context.setShowColor(true);
        // Circuit.draw paints each component on its own copy of the base graphics.
        Graphics own = g.create();
        context.setGraphics(own);
        component.draw(context);
        own.dispose();
        probe.recording = null;

        Bounds bounds = component.getBounds();
        out.append("{\"bounds\":");
        box(out, bounds.getX() - at.getX(), bounds.getY() - at.getY(), bounds.getWidth(), bounds.getHeight());
        out.append(",\"ink\":");
        if (recording.empty()) box(out, bounds.getX() - at.getX(), bounds.getY() - at.getY(), bounds.getWidth(), bounds.getHeight());
        else box(out, recording.minX, recording.minY, recording.maxX - recording.minX, recording.maxY - recording.minY);
        out.append(",\"ports\":[");
        int index = 0;
        Map<String, Object> direction = new LinkedHashMap<>();
        for (EndData end : component.getEnds()) {
            if (index > 0) out.append(',');
            direction.clear();
            NativePortSemantics.putDirection(direction, component, index);
            out.append("{\"index\":").append(index)
                .append(",\"x\":").append(end.getLocation().getX() - at.getX())
                .append(",\"y\":").append(end.getLocation().getY() - at.getY())
                .append(",\"width\":").append(end.getWidth().getWidth())
                .append(",\"direction\":");
            RecordingGraphics2D.str(out, String.valueOf(direction.get("direction")));
            out.append('}');
            index++;
        }
        out.append("],\"ops\":").append(recording.json()).append('}');
    }
}
