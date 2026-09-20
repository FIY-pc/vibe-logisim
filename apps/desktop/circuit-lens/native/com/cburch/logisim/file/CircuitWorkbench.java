package com.cburch.logisim.file;

import com.cburch.logisim.analyze.model.*;
import com.cburch.logisim.circuit.*;
import com.cburch.logisim.comp.Component;
import com.cburch.logisim.data.*;
import com.cburch.logisim.instance.*;
import com.cburch.logisim.proj.Project;
import com.cburch.logisim.std.gates.CircuitBuilder;
import com.cburch.logisim.std.wiring.Pin;
import com.cburch.logisim.std.memory.Rom;
import com.cburch.hex.HexModel;
import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import javax.xml.parsers.*;
import javax.xml.transform.*;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.stream.StreamResult;
import org.w3c.dom.*;

/** Native combinational synthesis and pin-vector execution. No arbitrary code protocol. */
public final class CircuitWorkbench {
    private static String digest(Path path) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(path));
        StringBuilder hex = new StringBuilder();
        for (byte b : bytes) hex.append(String.format("%02x", b & 255));
        return hex.toString();
    }
    private static List<Component> pins(Circuit circuit) {
        List<Component> result = new ArrayList<>();
        for (Component c : circuit.getNonWires()) if (c.getFactory() instanceof Pin) result.add(c);
        result.sort(Comparator.comparingInt((Component c) -> c.getLocation().getY())
            .thenComparingInt(c -> c.getLocation().getX()));
        return result;
    }
    private static String label(Component c) { return c.getAttributeSet().getValue(StdAttr.LABEL); }
    private static boolean input(Component c) { return Pin.FACTORY.isInputPin(Instance.getInstanceFor(c)); }
    private static void build(LogisimFile file, Element request) throws Exception {
        Circuit circuit = file.getCircuit(request.getAttribute("circuit"));
        if (circuit == null) throw new IllegalArgumentException("Unknown circuit");
        if (!circuit.getWires().isEmpty() || circuit.getNonWires().size() != pins(circuit).size())
            throw new IllegalArgumentException("Only a pin-only empty combinational module can be filled");
        boolean defaultAppearance = circuit.getAppearance().isDefaultAppearance();
        Map<String, String> before = CircuitInterface.footprint(circuit);
        Map<String, Component> original = new LinkedHashMap<>();
        List<String> inputs = new ArrayList<>(), outputs = new ArrayList<>();
        for (Component pin : pins(circuit)) {
            String name = label(pin);
            if (name.isEmpty() || original.put(name, pin) != null)
                throw new IllegalArgumentException("Pins must have unique nonempty labels");
            if (pin.getAttributeSet().getValue(StdAttr.WIDTH).getWidth() != 1)
                throw new IllegalArgumentException("Synthesis currently supports one-bit pins");
            (input(pin) ? inputs : outputs).add(name);
        }
        if (inputs.size() > 12 || outputs.size() > 16) throw new IllegalArgumentException("Module too large");
        AnalyzerModel model = new AnalyzerModel();
        model.setVariables(inputs, outputs);
        Set<String> supplied = new HashSet<>();
        NodeList expressions = request.getElementsByTagName("expression");
        for (int i = 0; i < expressions.getLength(); i++) {
            Element item = (Element) expressions.item(i);
            String output = item.getAttribute("output");
            if (!outputs.contains(output) || !supplied.add(output)) throw new IllegalArgumentException("Invalid output " + output);
            String expression = item.getTextContent();
            model.getOutputExpressions().setExpression(output, Parser.parse(expression, model), expression);
        }
        if (!supplied.equals(new HashSet<>(outputs))) throw new IllegalArgumentException("Every output needs an expression");
        // The model owns a fully specified truth table; minimization must not introduce
        // don't-cares. Keep the original expressions in candidate metadata for review.
        for (String output : outputs) {
            Expression minimal = model.getOutputExpressions().getMinimalExpression(output);
            model.getOutputExpressions().setExpression(output, minimal);
        }
        Project project = new Project(file);
        CircuitBuilder.build(circuit, model, false, false).execute(project);
        // Keep the original pin attributes and model ordering; let the native builder lay out wires.
        CircuitMutation restore = new CircuitMutation(circuit);
        for (Component pin : pins(circuit)) {
            Component source = original.get(label(pin));
            restore.replace(pin, Pin.FACTORY.createComponent(pin.getLocation(), (AttributeSet) source.getAttributeSet().clone()));
        }
        restore.execute(project);
        // Custom appearance pin references are preserved/remapped by the host XML splice,
        // then checked by a second native load through check-interface below.
        if (defaultAppearance && !before.equals(CircuitInterface.footprint(circuit)))
            throw new IllegalStateException("Generated module changes its external port footprint; candidate rejected");
    }
    private static void simulate(LogisimFile file, Element request, Document result) {
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
            for (int i = 0; i < vectors.getLength(); i++) {
                Element vector = (Element) vectors.item(i);
                CircuitState state = new CircuitState(project, circuit);
                Set<String> supplied = new HashSet<>();
                NodeList values = vector.getElementsByTagName("input");
                for (int j = 0; j < values.getLength(); j++) {
                    Element value = (Element) values.item(j);
                    Component pin = pins.get(value.getAttribute("name"));
                    if (pin == null || !input(pin) || !supplied.add(label(pin))) throw new IllegalArgumentException("Invalid input");
                    BitWidth width = pin.getAttributeSet().getValue(StdAttr.WIDTH);
                    long number = Long.parseUnsignedLong(value.getAttribute("value"));
                    if (width.getWidth() > 32 || (width.getWidth() < 32 && number >= (1L << width.getWidth())) || number > 0xffffffffL)
                        throw new IllegalArgumentException("Input value out of range");
                    Pin.FACTORY.setValue(state.getInstanceState(pin), Value.createKnown(width, (int) number));
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
        for (Component c : circuit.getNonWires()) {
            if (c.getLocation().equals(location) && c.getFactory().getName().equals(selector.getAttribute("factory"))) {
                if (found != null) throw new IllegalArgumentException("Ambiguous component");
                found = c;
            }
        }
        if (found == null) throw new IllegalArgumentException("Unknown component");
        return found;
    }
    private static void trace(LogisimFile file, Element request, Document result) {
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
            NodeList inputNodes = request.getElementsByTagName("input");
            for (int i = 0; i < inputNodes.getLength(); i++) {
                Element item = (Element) inputNodes.item(i);
                if (inputs.put(item.getAttribute("name"), item) != null) throw new IllegalArgumentException("Duplicate input");
            }
        for (Component pin : pins(circuit)) if (input(pin)) {
            Element supplied = inputs.remove(label(pin));
            if (supplied == null) throw new IllegalArgumentException("Missing input " + label(pin));
            BitWidth width = pin.getAttributeSet().getValue(StdAttr.WIDTH);
            long number = Long.parseUnsignedLong(supplied.getAttribute("value"));
            if (width.getWidth() > 32 || number > 0xffffffffL || (width.getWidth() < 32 && number >= (1L << width.getWidth())))
                throw new IllegalArgumentException("Input out of range");
            Pin.FACTORY.setValue(state.getInstanceState(pin), Value.createKnown(width, (int) number));
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
            for (int tick = 0; tick <= ticks; tick++) {
            NodeList inputEvents = request.getElementsByTagName("input-event");
            for (int i = 0; i < inputEvents.getLength(); i++) {
                Element event = (Element) inputEvents.item(i);
                if (Integer.parseInt(event.getAttribute("tick")) != tick) continue;
                Component pin = null;
                for (Component candidate : pins(circuit)) if (input(candidate) && label(candidate).equals(event.getAttribute("name"))) pin = candidate;
                if (pin == null) throw new IllegalArgumentException("Stimulus target is not an input Pin " + event.getAttribute("name"));
                BitWidth width = pin.getAttributeSet().getValue(StdAttr.WIDTH);
                long number = Long.parseUnsignedLong(event.getAttribute("value"));
                if (width.getWidth() > 32 || number > 0xffffffffL || (width.getWidth() < 32 && number >= (1L << width.getWidth()))) throw new IllegalArgumentException("Input event out of range");
                Pin.FACTORY.setValue(state.getInstanceState(pin), Value.createKnown(width, (int) number));
                state.markComponentAsDirty(pin);
                state.getPropagator().propagate();
            }
            NodeList events = request.getElementsByTagName("button-event");
            for (int i = 0; i < events.getLength(); i++) {
                Element event = (Element) events.item(i);
                if (Integer.parseInt(event.getAttribute("tick")) != tick) continue;
                Component button = selected(circuit, event);
                if (!button.getFactory().getName().equals("Button")) throw new IllegalArgumentException("Stimulus target must be a Button");
                Value value = event.getAttribute("pressed").equals("true") ? Value.TRUE : Value.FALSE;
                state.getInstanceState(button).setData(new InstanceDataSingleton(value));
                state.markComponentAsDirty(button);
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
    public static void main(String[] args) {
        System.setProperty("java.awt.headless", "true");
        PrintStream protocol = System.out;
        System.setOut(System.err);
        try {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
            Document request = factory.newDocumentBuilder().parse(new File(args[1]));
            // Identify the runtime that actually supplied Pin, not a version
            // guessed from the selected filename or host configuration.
            Path runtime = Paths.get(Pin.class.getProtectionDomain().getCodeSource().getLocation().toURI());
            String runtimeSha = digest(runtime), artifactSha = digest(Paths.get(args[0]));
            Loader loader = new Loader(null) {
                @Override public void showError(String description) { throw new IllegalStateException(description); }
            };
            LogisimFile file = NativeCircuitLoader.open(loader, new File(args[0]));
            Document result = factory.newDocumentBuilder().newDocument();
            result.appendChild(result.createElement("result"));
            result.getDocumentElement().setAttribute("runtimeJarSha256", runtimeSha);
            result.getDocumentElement().setAttribute("runtimeVersion", String.valueOf(com.cburch.logisim.Main.VERSION));
            result.getDocumentElement().setAttribute("artifactSha256", artifactSha);
            if (request.getDocumentElement().getTagName().equals("component-catalog")) {
                CircuitPalette.catalog(file, request.getDocumentElement(), result);
            } else if (request.getDocumentElement().getTagName().equals("component-template") || request.getDocumentElement().getTagName().equals("place-component")) {
                CircuitPalette.describe(file, request.getDocumentElement(), result);
            } else if (request.getDocumentElement().getTagName().equals("check-existing-ports")) {
                Loader otherLoader = new Loader(null) { @Override public void showError(String message) { throw new IllegalStateException(message); } };
                CircuitPalette.preserveExistingPorts(file, NativeCircuitLoader.open(otherLoader, new File(args[2])), request.getDocumentElement().getAttribute("circuit"));
            } else if (request.getDocumentElement().getTagName().equals("build")) {
                build(file, request.getDocumentElement());
                try (OutputStream out = new FileOutputStream(args[2])) { file.write(out, loader); }
            } else if (request.getDocumentElement().getTagName().equals("interface")) {
                CircuitInterface.describe(file, request.getDocumentElement(), result);
            } else if (request.getDocumentElement().getTagName().equals("check-interface")) {
                Loader otherLoader = new Loader(null) {
                    @Override public void showError(String description) { throw new IllegalStateException(description); }
                };
                LogisimFile other = NativeCircuitLoader.open(otherLoader, new File(args[2]));
                String name = request.getDocumentElement().getAttribute("circuit");
                CircuitInterface.check(file, other, name);
            } else if (request.getDocumentElement().getTagName().equals("simulate")) {
                simulate(file, request.getDocumentElement(), result);
            } else if (request.getDocumentElement().getTagName().equals("trace")) {
                trace(file, request.getDocumentElement(), result);
            } else if (request.getDocumentElement().getTagName().equals("property") || request.getDocumentElement().getTagName().equals("memory")) {
                CircuitObjects.describe(file, request.getDocumentElement(), result);
            } else throw new IllegalArgumentException("Unknown operation");
            if (!artifactSha.equals(digest(Paths.get(args[0]))) || !runtimeSha.equals(digest(runtime)))
                throw new IllegalStateException("Native execution inputs changed during operation");
            TransformerFactory.newInstance().newTransformer().transform(new DOMSource(result), new StreamResult(protocol));
            System.exit(0);
        } catch (Throwable error) {
            error.printStackTrace(System.err);
            System.exit(1);
        }
    }
}
