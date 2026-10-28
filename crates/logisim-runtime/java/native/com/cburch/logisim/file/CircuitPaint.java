package com.cburch.logisim.file;

import com.cburch.logisim.circuit.CircuitState;
import com.cburch.logisim.circuit.WirePaint;
import com.cburch.logisim.comp.Component;
import com.cburch.logisim.comp.ComponentDrawContext;
import com.cburch.logisim.data.Location;
import java.awt.Color;
import java.awt.Graphics;
import java.awt.RenderingHints;
import java.util.HashMap;
import java.util.Map;

/**
 * The live picture of a run's view, recorded as vector ops
 * (RecordingGraphics2D) the way Logisim paints its canvas for the run's state:
 * not the print view, so wires take the colors of their values and
 * components show theirs. A frame carries only what changed since the last
 * frame sent, and everything on a full frame (a new instance shown):
 *
 * <pre>
 * {"wires": [[x1, y1, x2, y2, color], …],   each wire as CircuitWires.draw stroked it
 *  "dots": [[x, y, color], …],              each junction it filled
 *  "components": {id: [op, …], …}}          each component, relative to its location
 * </pre>
 *
 * The ops are the editor's symbol ops; a live circuit answers connection
 * questions itself, so there is no "U".
 */
final class CircuitPaint {
    /** One frame's recording, taken under the session lock. */
    static final class Recorded {
        /** The ops of the wires and junctions, in root space. */
        final String wires;
        /** Each component's ops by id; null where its painting failed. */
        final String[] ids, ops;

        Recorded(String wires, String[] ids, String[] ops) {
            this.wires = wires;
            this.ids = ids;
            this.ops = ops;
        }
    }

    /** The picture sent last, by key. */
    private final Map<String, String> wires = new HashMap<>(), dots = new HashMap<>(), components = new HashMap<>();

    private static RecordingGraphics2D graphics(RecordingGraphics2D.Recording recording) {
        RecordingGraphics2D g = new RecordingGraphics2D(recording);
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(Color.BLACK);
        return g;
    }

    private static ComponentDrawContext context(CircuitSessionView view, CircuitState state, Graphics g) {
        ComponentDrawContext context = new ComponentDrawContext(null, view.circuit, state, g, g, false);
        context.setShowState(true);
        context.setShowColor(true);
        return context;
    }

    /** Records the view as the canvas paints it in `state`. */
    static Recorded record(CircuitSessionView view, CircuitState state) {
        RecordingGraphics2D.Recording wires = new RecordingGraphics2D.Recording();
        RecordingGraphics2D g = graphics(wires);
        WirePaint.draw(view.circuit, context(view, state, g));
        g.dispose();
        String[] ids = new String[view.components.size()], ops = new String[ids.length];
        int i = 0;
        for (Map.Entry<String, Component> entry : view.components.entrySet()) {
            Component component = entry.getValue();
            Location at = component.getLocation();
            RecordingGraphics2D.Recording recording = new RecordingGraphics2D.Recording();
            RecordingGraphics2D root = graphics(recording);
            root.translate(-at.getX(), -at.getY());
            // Circuit.draw paints each component on its own copy of the base graphics.
            Graphics own = root.create();
            ids[i] = entry.getKey();
            try {
                ComponentDrawContext context = context(view, state, root);
                context.setGraphics(own);
                component.draw(context);
                ops[i] = recording.ops.toString();
            } catch (RuntimeException | LinkageError error) {
                // One component that cannot paint its state does not stop the run's picture.
                ops[i] = null;
            }
            own.dispose();
            i++;
        }
        return new Recorded(wires.ops.toString(), ids, ops);
    }

    /**
     * The picture JSON of `now`: everything when {@code full}, otherwise what
     * changed since the last frame sent. `now` counts as sent.
     */
    String delta(Recorded now, boolean full) {
        if (full) {
            wires.clear();
            dots.clear();
            components.clear();
        }
        StringBuilder out = new StringBuilder(full ? 1 << 18 : 1 << 12);
        StringBuilder junctions = new StringBuilder(full ? 1 << 13 : 256);
        out.append("{\"wires\":[");
        String s = now.wires, color = "#000000";
        boolean wire = false, dot = false;
        for (int open = s.indexOf('['), end; open >= 0; open = s.indexOf('[', end + 1)) {
            end = close(s, open);
            if (s.charAt(open + 3) != '"') continue;
            switch (s.charAt(open + 2)) {
                case 'C':
                    color = s.substring(open + 6, end - 1);
                    break;
                case 'L': {
                    String key = s.substring(open + 5, end);
                    if (color.equals(wires.put(key, color))) break;
                    if (wire) out.append(',');
                    wire = true;
                    out.append('[').append(key).append(",\"").append(color).append("\"]");
                    break;
                }
                case 'o': {
                    String[] v = s.substring(open + 5, end).split(",");
                    StringBuilder key = new StringBuilder(16);
                    RecordingGraphics2D.num(key, Double.parseDouble(v[0]) + Double.parseDouble(v[2]) / 2);
                    key.append(',');
                    RecordingGraphics2D.num(key, Double.parseDouble(v[1]) + Double.parseDouble(v[3]) / 2);
                    String at = key.toString();
                    if (color.equals(dots.put(at, color))) break;
                    if (dot) junctions.append(',');
                    dot = true;
                    junctions.append('[').append(at).append(",\"").append(color).append("\"]");
                    break;
                }
                default:
                    break;
            }
        }
        out.append("],\"dots\":[").append(junctions).append("],\"components\":{");
        boolean component = false;
        for (int i = 0; i < now.ids.length; i++) {
            String ops = now.ops[i];
            if (ops == null || ops.equals(components.put(now.ids[i], ops))) continue;
            if (component) out.append(',');
            component = true;
            RecordingGraphics2D.str(out, now.ids[i]);
            out.append(":[").append(ops).append(']');
        }
        return out.append("}}").toString();
    }

    /** The index of the bracket that closes the op opening at `open`. */
    private static int close(String s, int open) {
        int depth = 0;
        boolean quoted = false;
        for (int i = open; i < s.length(); i++) {
            char c = s.charAt(i);
            if (quoted) {
                if (c == '\\') i++;
                else if (c == '"') quoted = false;
            } else if (c == '"') quoted = true;
            else if (c == '[') depth++;
            else if (c == ']' && --depth == 0) return i;
        }
        return s.length() - 1;
    }
}
