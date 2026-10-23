package com.cburch.logisim.file;

import com.cburch.logisim.circuit.*;
import com.cburch.logisim.comp.Component;
import com.cburch.logisim.data.*;
import com.cburch.logisim.instance.*;
import com.cburch.logisim.proj.Project;
import com.cburch.logisim.std.wiring.Pin;
import com.cburch.logisim.std.memory.Rom;
import com.cburch.hex.HexModel;
import java.util.*;
import org.w3c.dom.*;

/** Pin-vector execution and tick traces on a fresh state; {@link CircuitSession} runs both in its verify mode. */
public final class CircuitWorkbench {
    private static List<Component> pins(Circuit circuit) {
        List<Component> result = new ArrayList<>();
        for (Component c : circuit.getNonWires()) if (c.getFactory() instanceof Pin) result.add(c);
        result.sort(Comparator.comparingInt((Component c) -> c.getLocation().getY())
            .thenComparingInt(c -> c.getLocation().getX()));
        return result;
    }
    private static String label(Component c) { return c.getAttributeSet().getValue(StdAttr.LABEL); }
    private static boolean input(Component c) { return Pin.FACTORY.isInputPin(Instance.getInstanceFor(c)); }
    private static IllegalArgumentException inputRangeError(Component pin, String raw, String context, int bits, long maximum) {
        return new IllegalArgumentException(context + " input \"" + label(pin) + "\" value " + raw
            + " is outside its native " + bits + "-bit unsigned range 0.." + maximum
            + "; correct the stimulus value or the circuit pin width.");
    }
    private static Value inputValue(Component pin, Element supplied, String context) {
        BitWidth width = pin.getAttributeSet().getValue(StdAttr.WIDTH);
        int bits = width.getWidth();
        if (bits < 1 || bits > 32)
            throw new IllegalArgumentException(context + " input \"" + label(pin) + "\" has unsupported native width " + bits);
        long maximum = (1L << bits) - 1;
        String raw = supplied.getAttribute("value");
        long number;
        try { number = Long.parseUnsignedLong(raw); }
        catch (NumberFormatException invalid) { throw inputRangeError(pin, raw, context, bits, maximum); }
        if (number < 0 || number > maximum) throw inputRangeError(pin, raw, context, bits, maximum);
        return Value.createKnown(width, (int) number);
    }
    static void simulate(LogisimFile file, Element request, Document result) {
        Circuit circuit = file.getCircuit(request.getAttribute("circuit"));
        if (circuit == null) throw new IllegalArgumentException("Unknown circuit");
        Map<String, Component> pins = new LinkedHashMap<>();
        for (Component pin : pins(circuit)) {
            if (label(pin).isEmpty() || pins.put(label(pin), pin) != null)
                throw new IllegalArgumentException("Pins must have unique labels");
        }
        Project project = new Project(file);
        try {
            NodeList vectors = request.getElementsByTagName("vector");
            int offset = request.hasAttribute("vectorOffset") ? Integer.parseInt(request.getAttribute("vectorOffset")) : 0;
            for (int i = 0; i < vectors.getLength(); i++) {
                Element vector = (Element) vectors.item(i);
                CircuitState state = new CircuitState(project, circuit);
                Set<String> supplied = new HashSet<>();
                NodeList values = vector.getElementsByTagName("input");
                for (int j = 0; j < values.getLength(); j++) {
                    Element value = (Element) values.item(j);
                    Component pin = pins.get(value.getAttribute("name"));
                    if (pin == null || !input(pin) || !supplied.add(label(pin))) throw new IllegalArgumentException("Invalid input");
                    Pin.FACTORY.setValue(state.getInstanceState(pin), inputValue(pin, value, "vectors[" + (offset + i) + "].inputs"));
                }
                for (Component pin : pins.values()) if (input(pin) && !supplied.contains(label(pin)))
                    throw new IllegalArgumentException("Missing input " + label(pin));
                state.getPropagator().propagate();
                Element row = result.createElement("vector");
                row.setAttribute("index", String.valueOf(i));
                row.setAttribute("oscillating", String.valueOf(state.getPropagator().isOscillating()));
                for (Component pin : pins.values()) if (!input(pin)) {
                    Value value = Pin.FACTORY.getValue(state.getInstanceState(pin));
                    Element out = result.createElement("output");
                    out.setAttribute("name", label(pin));
                    out.setAttribute("bits", value.toDisplayString(2));
                    if (value.isFullyDefined()) out.setAttribute("value", Integer.toUnsignedString(value.toIntValue()));
                    row.appendChild(out);
                }
                result.getDocumentElement().appendChild(row);
            }
        } finally {
            project.getSimulator().shutDown();
        }
    }
    private static Component selected(Circuit circuit, Element selector) {
        Location location = Location.create(Integer.parseInt(selector.getAttribute("x")), Integer.parseInt(selector.getAttribute("y")));
        Component found = null;
        int matches = 0;
        for (Component c : circuit.getNonWires()) {
            if (!c.getLocation().equals(location) || !c.getFactory().getName().equals(selector.getAttribute("factory"))) continue;
            matches++;
            found = c;
        }
        // (x, y, factory) is the whole selector; stacked exact copies are unaddressable by design.
        if (matches > 1) throw new IllegalArgumentException("元件定位有歧义: " + location + " 处堆叠了 "
                + matches + " 个 " + selector.getAttribute("factory") + "；请删除或移开重复元件后重试");
        if (found == null) throw new IllegalArgumentException("找不到元件: " + selector.getAttribute("factory") + " " + location);
        return found;
    }
    private static final class TraceEvent {
        final Component component;
        final Value value;
        TraceEvent(Component component, Value value) {
            this.component = component;
            this.value = value;
        }
    }
    static void trace(LogisimFile file, Element request, Document result) {
        Circuit circuit = file.getCircuit(request.getAttribute("circuit"));
        if (circuit == null) throw new IllegalArgumentException("Unknown circuit");
        int ticks = Integer.parseInt(request.getAttribute("ticks"));
        if (ticks < 1 || ticks > 10000) throw new IllegalArgumentException("Invalid tick limit");
        NodeList programs = request.getElementsByTagName("program");
        if (programs.getLength() == 1) {
            Element program = (Element) programs.item(0);
            Component rom = selected(circuit, program);
            if (!(rom.getFactory() instanceof Rom)) throw new IllegalArgumentException("Program target must be ROM");
            HexModel memory = rom.getAttributeSet().getValue(Rom.CONTENTS_ATTR);
            if (memory.getLastOffset() >= 4096) throw new IllegalArgumentException("Program stimulus supports ROM up to 4096 words");
            for (long i = 0; i <= memory.getLastOffset(); i++) memory.set(i, 0);
            NodeList words = program.getElementsByTagName("word");
            if (words.getLength() > memory.getLastOffset() + 1) throw new IllegalArgumentException("Program exceeds ROM");
            for (int i = 0; i < words.getLength(); i++)
                memory.set(i, (int) Long.parseUnsignedLong(((Element) words.item(i)).getAttribute("value")));
        }
        Project project = new Project(file);
        try {
            CircuitState state = new CircuitState(project, circuit);
            Map<String, Element> inputs = new HashMap<>();
            Map<String, Component> inputPins = new HashMap<>();
            NodeList inputNodes = request.getElementsByTagName("input");
            for (int i = 0; i < inputNodes.getLength(); i++) {
                Element item = (Element) inputNodes.item(i);
                if (inputs.put(item.getAttribute("name"), item) != null) throw new IllegalArgumentException("Duplicate input");
            }
        for (Component pin : pins(circuit)) if (input(pin)) {
            inputPins.put(label(pin), pin);
            Element supplied = inputs.remove(label(pin));
            if (supplied == null) throw new IllegalArgumentException("Missing input " + label(pin));
            Pin.FACTORY.setValue(state.getInstanceState(pin), inputValue(pin, supplied, "inputs"));
        }
        if (!inputs.isEmpty()) throw new IllegalArgumentException("Unknown input");
        NodeList watches = request.getElementsByTagName("watch");
        Map<String, Location> points = new LinkedHashMap<>();
        for (int i = 0; i < watches.getLength(); i++) {
            Element watch = (Element) watches.item(i);
            Component c = selected(circuit, watch);
            int index = Integer.parseInt(watch.getAttribute("port"));
            points.put(watch.getAttribute("name"), c.getEnd(index).getLocation());
        }
        state.getPropagator().propagate();
        NodeList resets = request.getElementsByTagName("reset");
        if (resets.getLength() == 1) {
            Component button = selected(circuit, (Element) resets.item(0));
            if (!button.getFactory().getName().equals("Button")) throw new IllegalArgumentException("Reset target must be a Button");
            for (Value value : new Value[] {Value.TRUE, Value.FALSE}) {
                state.getInstanceState(button).setData(new InstanceDataSingleton(value));
                state.markComponentAsDirty(button);
                state.getPropagator().propagate();
            }
        }
        // Bind and validate once; append in XML order so each tick retains event order.
        Map<Integer, List<TraceEvent>> inputEventsByTick = new HashMap<>();
        NodeList inputEvents = request.getElementsByTagName("input-event");
        for (int i = 0, count = inputEvents.getLength(); i < count; i++) {
            Element event = (Element) inputEvents.item(i);
            int tick = Integer.parseInt(event.getAttribute("tick"));
            // Events outside this trace were ignored by the original tick loop.
            if (tick < 0 || tick > ticks) continue;
            Component pin = inputPins.get(event.getAttribute("name"));
            if (pin == null) throw new IllegalArgumentException("Stimulus target is not an input Pin " + event.getAttribute("name"));
            inputEventsByTick.computeIfAbsent(tick, ignored -> new ArrayList<>())
                .add(new TraceEvent(pin, inputValue(pin, event, "input event at tick " + tick)));
        }
        Map<Integer, List<TraceEvent>> buttonEventsByTick = new HashMap<>();
        NodeList buttonEvents = request.getElementsByTagName("button-event");
        for (int i = 0, count = buttonEvents.getLength(); i < count; i++) {
            Element event = (Element) buttonEvents.item(i);
            int tick = Integer.parseInt(event.getAttribute("tick"));
            if (tick < 0 || tick > ticks) continue;
            Component button = selected(circuit, event);
            if (!button.getFactory().getName().equals("Button")) throw new IllegalArgumentException("Stimulus target must be a Button");
            Value value = event.getAttribute("pressed").equals("true") ? Value.TRUE : Value.FALSE;
            buttonEventsByTick.computeIfAbsent(tick, ignored -> new ArrayList<>())
                .add(new TraceEvent(button, value));
        }
            for (int tick = 0; tick <= ticks; tick++) {
            for (TraceEvent event : inputEventsByTick.getOrDefault(tick, Collections.emptyList())) {
                Pin.FACTORY.setValue(state.getInstanceState(event.component), event.value);
                state.markComponentAsDirty(event.component);
                state.getPropagator().propagate();
            }
            for (TraceEvent event : buttonEventsByTick.getOrDefault(tick, Collections.emptyList())) {
                state.getInstanceState(event.component).setData(new InstanceDataSingleton(event.value));
                state.markComponentAsDirty(event.component);
                state.getPropagator().propagate();
            }
            Element sample = result.createElement("sample");
            sample.setAttribute("tick", String.valueOf(tick));
            sample.setAttribute("oscillating", String.valueOf(state.getPropagator().isOscillating()));
            for (Map.Entry<String, Location> entry : points.entrySet()) {
                Value value = state.getValue(entry.getValue());
                Element signal = result.createElement("signal");
                signal.setAttribute("name", entry.getKey());
                signal.setAttribute("bits", value.toDisplayString(2));
                if (value.isFullyDefined()) signal.setAttribute("value", Integer.toUnsignedString(value.toIntValue()));
                sample.appendChild(signal);
            }
            result.getDocumentElement().appendChild(sample);
            if (state.getPropagator().isOscillating()) break;
            if (tick < ticks) {
                state.getPropagator().tick();
                state.getPropagator().propagate();
            }
            }
        } finally {
            project.getSimulator().shutDown();
        }
    }
}
