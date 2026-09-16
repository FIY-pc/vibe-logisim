package com.cburch.logisim.file;

import com.cburch.logisim.circuit.*;
import com.cburch.logisim.comp.*;
import com.cburch.logisim.data.*;
import com.cburch.logisim.instance.*;
import com.cburch.logisim.proj.Project;
import com.cburch.logisim.std.wiring.Pin;
import com.cburch.logisim.std.wiring.Clock;
import com.cburch.logisim.std.memory.StudioMemory;
import java.io.*;
import java.util.*;
import java.awt.event.MouseEvent;
import java.awt.image.BufferedImage;
import javax.imageio.ImageIO;
import javax.xml.parsers.*;
import javax.xml.transform.*;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.stream.StreamResult;
import org.w3c.dom.*;

/** A single native root instance, retained across bounded stdin commands. */
public final class CircuitSession {
    private final Circuit circuit;
    private final Project project;
    private CircuitState state;
    private final CircuitSessionView view;
    private int ticks;
    private Element memoryRequest;
    private CircuitFrame.Viewport viewport;
    private boolean running, automatic = true, pending;
    private double frequency = 2, actualFrequency;
    private long version, commandSequence, nextTick, rateStart = System.nanoTime();
    private int rateTicks;
    private String failure;

    private CircuitSession(LogisimFile file, Element init) {
        circuit = file.getCircuit(init.getAttribute("circuit"));
        if (circuit == null) throw new IllegalArgumentException("Unknown circuit");
        project = new Project(file);
        view = new CircuitSessionView(circuit, init);
        reset();
    }

    private void reset() {
        state = new CircuitState(project, circuit);
        ticks = 0;
        // Floating inputs are not invented as zeros. All stimuli are explicit.
        state.getPropagator().propagate();
        pending = false;
        rateStart = System.nanoTime(); rateTicks = 0; actualFrequency = 0;
    }

    private void settle() {
        pending = true;
        if (automatic) {
            state.getPropagator().propagate(); pending = StudioPropagation.pending(state);
            if (state.getPropagator().isOscillating()) running = false;
        }
    }

    private void tick() {
        state.getPropagator().tick(); ticks++; rateTicks++; settle(); version++;
    }

    private void command(Element request) {
        String op = request.getTagName();
        if (op.equals("view")) { view.navigate(request, state); memoryRequest = null; viewport = null; version++; return; }
        if (request.hasAttribute("viewId") && !view.id.equals(request.getAttribute("viewId")))
            throw new IllegalArgumentException("运行视图已切换，请重新选择对象");
        if (op.equals("viewport")) { viewport = CircuitFrame.Viewport.from(request); version++; return; }
        Map<String, Component> components = view.components;
        CircuitState local = view.resolve(state);
        if (op.equals("reset")) reset();
        else if (op.equals("tick")) {
            running = false; tick();
        } else if (op.equals("play")) {
            if (state.getPropagator().isOscillating()) throw new IllegalArgumentException("Circuit is oscillating; reset or edit it first");
            automatic = true; settle();
            running = !state.getPropagator().isOscillating();
            nextTick = System.nanoTime() + (long)(1e9 / frequency);
            rateStart = System.nanoTime(); rateTicks = 0; actualFrequency = 0;
        } else if (op.equals("pause")) running = false;
        else if (op.equals("configure")) {
            if (request.hasAttribute("frequency")) {
                double value = Double.parseDouble(request.getAttribute("frequency"));
                if (!Double.isFinite(value) || value < .25 || value > 4096) throw new IllegalArgumentException("Frequency must be 0.25–4096 ticks/s");
                frequency = value; nextTick = System.nanoTime() + (long)(1e9 / frequency);
                rateStart = System.nanoTime(); rateTicks = 0; actualFrequency = 0;
            }
            if (request.hasAttribute("automatic")) {
                automatic = request.getAttribute("automatic").equals("true");
                if (automatic) settle(); else running = false;
            }
        } else if (op.equals("step")) {
            running = false; automatic = false;
            StudioPropagation.step(state); pending = StudioPropagation.pending(state);
        } else if (op.equals("poke")) {
            Component c = components.get(request.getAttribute("componentId"));
            if (c == null) throw new IllegalArgumentException("Unknown input");
            view.checkInput(c);
            InstancePoker poker;
            if (c.getFactory() instanceof Pin && Pin.FACTORY.isInputPin(Instance.getInstanceFor(c))) poker = new Pin.PinPoker();
            else if (c.getFactory() instanceof Clock) poker = new Clock.ClockPoker();
            else throw new IllegalArgumentException("Only input pins and clocks can be poked");
            int x = Integer.parseInt(request.getAttribute("x")), y = Integer.parseInt(request.getAttribute("y"));
            if (!c.getBounds().expand(2).contains(x, y)) throw new IllegalArgumentException("Click outside component");
            InstanceState instance = local.getInstanceState(c);
            // A plain AWT event source avoids the native GUI's subcircuit-clone dialog.
            java.awt.Canvas source = new java.awt.Canvas();
            MouseEvent press = new MouseEvent(source, MouseEvent.MOUSE_PRESSED, 0, 0, x, y, 1, false, MouseEvent.BUTTON1);
            MouseEvent release = new MouseEvent(source, MouseEvent.MOUSE_RELEASED, 0, 0, x, y, 1, false, MouseEvent.BUTTON1);
            poker.init(instance, press); poker.mousePressed(instance, press); poker.mouseReleased(instance, release);
            local.markComponentAsDirty(c); settle();
        } else if (op.equals("memory") || op.equals("memory-write")) {
            Component c = components.get(request.getAttribute("componentId"));
            if (c == null || !c.getFactory().getName().equals("RAM")) throw new IllegalArgumentException("Select RAM in this instance");
            if (op.equals("memory-write")) { StudioMemory.write(c, local, request); settle(); }
            memoryRequest = request;
        } else if (op.equals("input") || op.equals("pulse") || op.equals("button")) {
            Component c = components.get(request.getAttribute("componentId"));
            if (c == null) throw new IllegalArgumentException("Unknown input");
            if (op.equals("pulse") || op.equals("button")) {
                if (!c.getFactory().getName().equals("Button")) throw new IllegalArgumentException("Not a button");
                Value[] values = op.equals("pulse") ? new Value[] {Value.TRUE, Value.FALSE} : new Value[] {request.getAttribute("value").equals("1") ? Value.TRUE : Value.FALSE};
                for (Value v : values) {
                    local.getInstanceState(c).setData(new InstanceDataSingleton(v));
                    local.markComponentAsDirty(c);
                    settle();
                }
            } else {
                if (!(c.getFactory() instanceof Pin) || !Pin.FACTORY.isInputPin(Instance.getInstanceFor(c)))
                    throw new IllegalArgumentException("Not an input pin");
                view.checkInput(c);
                BitWidth width = c.getAttributeSet().getValue(StdAttr.WIDTH);
                String bits = request.getAttribute("bits");
                if (bits.length() != width.getWidth() || !bits.matches("[01x]+")) throw new IllegalArgumentException("Input value out of range");
                Value[] values = new Value[bits.length()];
                for (int i = 0; i < values.length; i++) {
                    char bit = bits.charAt(bits.length() - 1 - i);
                    values[i] = bit == '0' ? Value.FALSE : bit == '1' ? Value.TRUE : Value.UNKNOWN;
                }
                Pin.FACTORY.setValue(local.getInstanceState(c), Value.create(values));
                local.markComponentAsDirty(c);
                settle();
            }
        } else if (!op.equals("sample")) throw new IllegalArgumentException("Unknown command");
        version++;
    }

    private void metadata(Element root) {
        root.setAttribute("viewId", view.id);
        root.setAttribute("circuit", view.circuit.getName());
        root.setAttribute("commandSequence", String.valueOf(commandSequence));
        root.setAttribute("ticks", String.valueOf(ticks));
        root.setAttribute("running", String.valueOf(running));
        root.setAttribute("automatic", String.valueOf(automatic));
        root.setAttribute("pending", String.valueOf(pending));
        root.setAttribute("frequency", String.valueOf(frequency));
        root.setAttribute("actualFrequency", String.valueOf(actualFrequency));
        root.setAttribute("oscillating", String.valueOf(state.getPropagator().isOscillating()));
        if (failure != null) root.setAttribute("failure", failure);
    }

    private BufferedImage sample(Document result) throws Exception {
        Element root = result.getDocumentElement();
        metadata(root);
        CircuitState state = view.resolve(this.state);
        Circuit circuit = view.circuit;
        Map<String, Component> components = view.components;
        for (Map.Entry<String, Component> entry : components.entrySet()) {
            Component c = entry.getValue();
            Element item = result.createElement("component");
            item.setAttribute("id", entry.getKey());
            if (c.getFactory() instanceof Pin && Pin.FACTORY.isInputPin(Instance.getInstanceFor(c))) {
                item.setAttribute("control", view.nested() ? "parent-input" : "input");
                Value value = Pin.FACTORY.getValue(state.getInstanceState(c));
                Element input = result.createElement("input");
                input.setAttribute("width", String.valueOf(value.getWidth())); input.setAttribute("bits", value.toDisplayString(2));
                if (value.isFullyDefined()) input.setAttribute("value", Integer.toUnsignedString(value.toIntValue()));
                item.appendChild(input);
            }
            if (c.getFactory().getName().equals("Button")) item.setAttribute("control", "pulse");
            if (c.getFactory() instanceof Clock) item.setAttribute("control", "clock");
            for (int i = 0; i < c.getEnds().size(); i++) {
                Value v = state.getValue(c.getEnd(i).getLocation());
                Element port = result.createElement("port");
                port.setAttribute("index", String.valueOf(i));
                port.setAttribute("width", String.valueOf(v.getWidth()));
                port.setAttribute("bits", v.toDisplayString(2));
                if (v.isFullyDefined()) port.setAttribute("value", Integer.toUnsignedString(v.toIntValue()));
                item.appendChild(port);
            }
            root.appendChild(item);
        }
        if (memoryRequest != null) root.appendChild(StudioMemory.page(components.get(memoryRequest.getAttribute("componentId")), state, memoryRequest, result));
        Element render = result.createElement("render");
        BufferedImage bitmap = CircuitFrame.draw(circuit, state, viewport, render);
        root.appendChild(render);
        return bitmap;
    }

    private static void send(Document result, PrintStream protocol) throws Exception {
        Transformer transformer = TransformerFactory.newInstance().newTransformer();
        transformer.setOutputProperty(OutputKeys.OMIT_XML_DECLARATION, "yes");
        StringWriter xml = new StringWriter();
        transformer.transform(new DOMSource(result), new StreamResult(xml));
        synchronized (protocol) { protocol.println(xml); protocol.flush(); }
    }

    private void startWorkers(PrintStream protocol) {
        Thread clock = new Thread(() -> {
            while (true) {
                try {
                    synchronized (this) {
                        long now = System.nanoTime();
                        if (running && automatic) {
                            long interval = (long)(1e9 / frequency);
                            // Bounded catch-up; a slow circuit must still accept pause/input.
                            int count = 0;
                            while (running && now >= nextTick && count++ < 32) { tick(); nextTick += interval; }
                            if (now - nextTick > 100_000_000L) nextTick = now + interval;
                            if (now - rateStart >= 1_000_000_000L) {
                                actualFrequency = rateTicks * 1e9 / (now - rateStart); rateTicks = 0; rateStart = now;
                            }
                        }
                    }
                    Thread.sleep(1);
                } catch (Throwable error) {
                    synchronized (this) { running = false; failure = error.toString(); version++; }
                }
            }
        }, "studio-clock");
        clock.setDaemon(true); clock.start();
        Thread frames = new Thread(() -> {
            long rendered = -1;
            try {
                DocumentBuilder builder = DocumentBuilderFactory.newInstance().newDocumentBuilder();
                while (true) {
                    Document result = null; BufferedImage bitmap = null;
                    long started = System.nanoTime(), captured = started;
                    synchronized (this) {
                        if (version != rendered) {
                            result = builder.newDocument(); result.appendChild(result.createElement("frame"));
                            bitmap = sample(result); rendered = version; captured = System.nanoTime();
                        }
                    }
                    if (result != null) {
                        // Encoding and protocol output do not hold the live circuit lock.
                        ByteArrayOutputStream png = new ByteArrayOutputStream(); ImageIO.write(bitmap, "png", png);
                        ((Element)result.getElementsByTagName("render").item(0)).setTextContent(Base64.getEncoder().encodeToString(png.toByteArray()));
                        result.getDocumentElement().setAttribute("captureMs", String.valueOf((captured - started) / 1e6));
                        result.getDocumentElement().setAttribute("encodeMs", String.valueOf((System.nanoTime() - captured) / 1e6));
                        send(result, protocol);
                    }
                    Thread.sleep(16);
                }
            } catch (Throwable error) {
                error.printStackTrace(System.err);
                try {
                    Document result = DocumentBuilderFactory.newInstance().newDocumentBuilder().newDocument();
                    result.appendChild(result.createElement("frame-error"));
                    synchronized (this) { running = false; failure = error.toString(); metadata(result.getDocumentElement()); }
                    send(result, protocol);
                } catch (Exception ignored) { }
            }
        }, "studio-frames");
        frames.setDaemon(true); frames.start();
    }

    public static void main(String[] args) throws Exception {
        System.setProperty("java.awt.headless", "true");
        ImageIO.setUseCache(false);
        PrintStream protocol = System.out; System.setOut(System.err);
        DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
        f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        f.setFeature("http://xml.org/sax/features/external-general-entities", false);
        DocumentBuilder parser = f.newDocumentBuilder();
        Loader loader = new Loader(null) { @Override public void showError(String description) { throw new IllegalStateException(description); } };
        CircuitSession session = new CircuitSession(loader.openLogisimFile(new File(args[0])), parser.parse(new File(args[1])).getDocumentElement());
        session.startWorkers(protocol);
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
        String line;
        while ((line = in.readLine()) != null) {
            Document result = parser.newDocument(); result.appendChild(result.createElement("ack"));
            try {
                Element request = parser.parse(new ByteArrayInputStream(line.getBytes("UTF-8"))).getDocumentElement();
                synchronized (session) {
                    session.commandSequence++;
                    session.command(request);
                    session.metadata(result.getDocumentElement());
                }
            } catch (Throwable error) {
                error.printStackTrace(System.err);
                result.getDocumentElement().setAttribute("error", error.toString());
            }
            send(result, protocol);
        }
        System.exit(0);
    }
}
