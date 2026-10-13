package com.cburch.logisim.file;

import com.cburch.logisim.circuit.CircuitState;
import com.cburch.logisim.comp.Component;
import com.cburch.logisim.data.Value;
import java.util.*;
import org.w3c.dom.*;

/** Captures settled command/tick boundaries independently of screen rendering. */
final class CircuitTrace {
    private static final int LIMIT = 512;
    private final List<String> keys = new ArrayList<>();
    private final List<Component> components = new ArrayList<>();
    private final List<Integer> ports = new ArrayList<>();
    private final Deque<Sample> samples = new ArrayDeque<>();
    private String id = UUID.randomUUID().toString();
    private long sequence;
    private boolean recording;
    private record Sample(long sequence, int tick, String cause, List<String> values) { }

    void configure(String selection, Map<String, Component> available) {
        List<String> nextKeys = new ArrayList<>();
        List<Component> nextComponents = new ArrayList<>();
        List<Integer> nextPorts = new ArrayList<>();
        if (!selection.isEmpty()) for (String key : selection.split(",", -1)) {
            String[] parts = key.split(":", -1);
            if (parts.length != 2) throw new IllegalArgumentException("Select a component port");
            Component c = available.get(parts[0]);
            int port = Integer.parseInt(parts[1]);
            if (c == null || port < 0 || port >= c.getEnds().size() || nextKeys.contains(key))
                throw new IllegalArgumentException("Signal selection changed; select it again");
            nextKeys.add(key); nextComponents.add(c); nextPorts.add(port);
            if (nextKeys.size() > 32) throw new IllegalArgumentException("Watch at most 32 signals");
        }
        keys.clear(); keys.addAll(nextKeys);
        components.clear(); components.addAll(nextComponents);
        ports.clear(); ports.addAll(nextPorts);
        reset(); recording = !keys.isEmpty();
    }
    void clear() { keys.clear(); components.clear(); ports.clear(); reset(); recording = false; }
    void reset() { samples.clear(); sequence = 0; id = UUID.randomUUID().toString(); }
    void stop() { recording = false; }
    void capture(CircuitState state, int ticks, String cause) {
        if (!recording) return;
        List<String> values = new ArrayList<>();
        for (int i = 0; i < components.size(); i++) {
            Value v = state.getValue(components.get(i).getEnd(ports.get(i)).getLocation());
            values.add(v.toDisplayString(2));
        }
        samples.addLast(new Sample(sequence++, ticks, cause, values));
        if (samples.size() > LIMIT) samples.removeFirst();
    }
    Element element(Document doc) {
        Element trace = doc.createElement("trace");
        trace.setAttribute("id", id); trace.setAttribute("recording", String.valueOf(recording));
        trace.setAttribute("total", String.valueOf(sequence));
        trace.setAttribute("dropped", String.valueOf(sequence - samples.size()));
        for (int i = 0; i < keys.size(); i++) {
            Element signal = doc.createElement("signal");
            signal.setAttribute("key", keys.get(i));
            signal.setAttribute("width", String.valueOf(components.get(i).getEnd(ports.get(i)).getWidth().getWidth()));
            trace.appendChild(signal);
        }
        for (Sample s : samples) {
            Element sample = doc.createElement("sample");
            sample.setAttribute("sequence", String.valueOf(s.sequence));
            sample.setAttribute("tick", String.valueOf(s.tick)); sample.setAttribute("cause", s.cause);
            sample.setTextContent(String.join("|", s.values)); trace.appendChild(sample);
        }
        return trace;
    }
}
