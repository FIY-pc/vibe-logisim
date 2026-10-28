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
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.awt.event.MouseEvent;
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
    private final CircuitTrace trace = new CircuitTrace();
    private boolean running, automatic = true, pending;
    private double frequency = 2, actualFrequency;
    private long version, commandSequence, nextTick, rateStart = System.nanoTime();
    private int rateTicks;
    private String failure, failureCode;
    // Buttons pressed through this session, in the state that holds them. They are
    // released before the view changes, while their component IDs still resolve.
    private final Map<Component, CircuitState> held = new LinkedHashMap<>();
    // What the frames sent last: the instance shown and each component's values.
    // Only the frame thread reads and writes these, under the session lock.
    private long sentGeneration = -1;
    private final Map<String, String> sent = new HashMap<>();

    private CircuitSession(LogisimFile file, Element init) {
        circuit = file.getCircuit(init.getAttribute("circuit"));
        if (circuit == null) throw new SessionError("UNKNOWN_CIRCUIT", "Unknown circuit");
        project = new Project(file);
        view = new CircuitSessionView(circuit, init);
        reset();
        // The clock the run starts with, so no command has to set it before the first frame.
        if (init.hasAttribute("frequency")) setFrequency(init.getAttribute("frequency"));
    }

    private void setFrequency(String text) {
        double value;
        try { value = Double.parseDouble(text); }
        catch (NumberFormatException error) { value = Double.NaN; }
        if (!Double.isFinite(value) || value < .25 || value > 4096) throw new SessionError("FREQUENCY_RANGE", "Frequency must be 0.25–4096 ticks/s");
        frequency = value; nextTick = System.nanoTime() + (long)(1e9 / frequency);
        rateStart = System.nanoTime(); rateTicks = 0; actualFrequency = 0;
    }

    private void reset() {
        state = new CircuitState(project, circuit);
        ticks = 0;
        // Floating inputs are not invented as zeros. All stimuli are explicit.
        state.getPropagator().propagate();
        pending = false; held.clear(); failure = null; failureCode = null;
        rateStart = System.nanoTime(); rateTicks = 0; actualFrequency = 0;
    }

    private void play() {
        if (state.getPropagator().isOscillating()) throw new SessionError("OSCILLATING", "Circuit is oscillating; reset or edit it first");
        automatic = true; settle();
        running = !state.getPropagator().isOscillating();
        nextTick = System.nanoTime() + (long)(1e9 / frequency);
        rateStart = System.nanoTime(); rateTicks = 0; actualFrequency = 0;
    }

    private void setAutomatic(boolean value) {
        automatic = value;
        if (automatic) settle(); else running = false;
    }

    private void press(Component c, CircuitState local, Value value, String cause) {
        local.getInstanceState(c).setData(new InstanceDataSingleton(value));
        local.markComponentAsDirty(c);
        settle();
        trace.capture(local, ticks, cause);
    }

    private void release() {
        for (Map.Entry<Component, CircuitState> entry : held.entrySet())
            press(entry.getKey(), entry.getValue(), Value.FALSE, "button");
        held.clear();
    }

    private void settle() {
        pending = true;
        if (automatic) {
            state.getPropagator().propagate(); pending = StudioPropagation.pending(state);
            if (state.getPropagator().isOscillating()) running = false;
        }
    }

    private void tick() {
        state.getPropagator().tick(); ticks++; rateTicks++; settle();
        trace.capture(view.resolve(state), ticks, "tick"); version++;
    }

    private void command(Element request) {
        String op = request.getTagName();
        if (op.equals("view")) { view.navigate(request, state, this::release); trace.clear(); memoryRequest = null; version++; return; }
        Map<String, Component> components = view.components;
        CircuitState local = view.resolve(state);
        if (op.equals("trace")) {
            trace.configure(request.getAttribute("signals"), components);
            trace.capture(local, ticks, "start");
        } else if (op.equals("trace-stop")) trace.stop();
        else if (op.equals("reset")) { reset(); trace.reset(); trace.capture(view.resolve(state), ticks, "reset"); }
        else if (op.equals("tick")) {
            running = false; tick();
        } else if (op.equals("play")) play();
        else if (op.equals("pause")) running = false;
        // Toggles read this session's own state, so rapid requests cannot act on a stale frame.
        else if (op.equals("toggle-clock")) { if (running) running = false; else play(); }
        else if (op.equals("toggle-propagation")) setAutomatic(!automatic);
        else if (op.equals("configure")) {
            if (request.hasAttribute("frequency")) setFrequency(request.getAttribute("frequency"));
            if (request.hasAttribute("automatic")) setAutomatic(request.getAttribute("automatic").equals("true"));
        } else if (op.equals("step")) {
            running = false; automatic = false;
            StudioPropagation.step(state); pending = StudioPropagation.pending(state);
        } else if (op.equals("poke")) {
            Component c = components.get(request.getAttribute("componentId"));
            if (c == null) throw new SessionError("INPUT_NOT_OPERABLE", "Unknown input");
            view.checkInput(c);
            InstancePoker poker;
            if (c.getFactory() instanceof Pin && Pin.FACTORY.isInputPin(Instance.getInstanceFor(c))) poker = new Pin.PinPoker();
            else if (c.getFactory() instanceof Clock) poker = new Clock.ClockPoker();
            else throw new SessionError("INPUT_NOT_OPERABLE", "Only input pins and clocks can be poked");
            int x = Integer.parseInt(request.getAttribute("x")), y = Integer.parseInt(request.getAttribute("y"));
            if (!c.getBounds().expand(2).contains(x, y)) throw new SessionError("INPUT_OUTSIDE", "Click outside component");
            InstanceState instance = local.getInstanceState(c);
            // A plain AWT event source avoids the native GUI's subcircuit-clone dialog.
            java.awt.Canvas source = new java.awt.Canvas();
            MouseEvent press = new MouseEvent(source, MouseEvent.MOUSE_PRESSED, 0, 0, x, y, 1, false, MouseEvent.BUTTON1);
            MouseEvent release = new MouseEvent(source, MouseEvent.MOUSE_RELEASED, 0, 0, x, y, 1, false, MouseEvent.BUTTON1);
            poker.init(instance, press); poker.mousePressed(instance, press); poker.mouseReleased(instance, release);
            local.markComponentAsDirty(c); settle();
        } else if (op.equals("memory") || op.equals("memory-write")) {
            Component c = components.get(request.getAttribute("componentId"));
            if (c == null || !c.getFactory().getName().equals("RAM")) throw new SessionError("NOT_RAM", "Select RAM in this instance");
            // Validate the page here: the frame thread renders it later and must not fail on it.
            StudioMemory.page(c, local, request, request.getOwnerDocument());
            if (op.equals("memory-write")) { StudioMemory.write(c, local, request); settle(); }
            memoryRequest = request;
        } else if (op.equals("input") || op.equals("pulse") || op.equals("button")) {
            Component c = components.get(request.getAttribute("componentId"));
            // Releasing a button that is not held (another instance is shown, or a
            // reset already let go of it) has nothing to release.
            boolean release = op.equals("button") && !request.getAttribute("value").equals("1");
            if (release && (c == null || !held.containsKey(c))) { version++; return; }
            if (c == null) throw new SessionError("INPUT_NOT_OPERABLE", "Unknown input");
            if (op.equals("pulse") || op.equals("button")) {
                if (!c.getFactory().getName().equals("Button")) throw new SessionError("INPUT_NOT_OPERABLE", "Not a button");
                Value[] values = op.equals("pulse") ? new Value[] {Value.TRUE, Value.FALSE} : new Value[] {request.getAttribute("value").equals("1") ? Value.TRUE : Value.FALSE};
                for (Value v : values) press(c, local, v, op);
                if (values[values.length - 1] == Value.TRUE) held.put(c, local); else held.remove(c);
            } else {
                if (!(c.getFactory() instanceof Pin) || !Pin.FACTORY.isInputPin(Instance.getInstanceFor(c)))
                    throw new SessionError("INPUT_NOT_OPERABLE", "Not an input pin");
                view.checkInput(c);
                BitWidth width = c.getAttributeSet().getValue(StdAttr.WIDTH);
                String bits = request.getAttribute("bits");
                if (bits.length() != width.getWidth() || !bits.matches("[01x]+")) throw new SessionError("INPUT_FORMAT", "Input value out of range");
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
        if (Arrays.asList("poke", "input", "step", "memory-write").contains(op))
            trace.capture(view.resolve(state), ticks, op);
        version++;
    }

    private void metadata(Element root) {
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
        if (failureCode != null) root.setAttribute("failureCode", failureCode);
    }

    /** A value as the frames carry it: binary digits, most significant first; `-` without width. */
    private static String bits(Value value) {
        return value.getWidth() == 0 ? "-" : value.toDisplayString(2).replace(" ", "");
    }

    /**
     * Fills a frame: the shown instance, the components whose values changed
     * since the last frame and the waveform's new samples, or everything when the
     * frame is full (the first one of an instance).
     */
    private CircuitPaint.Recorded sample(Document result) throws Exception {
        Element root = result.getDocumentElement();
        metadata(root);
        boolean full = view.generation != sentGeneration;
        if (full) { sentGeneration = view.generation; sent.clear(); }
        root.setAttribute("full", String.valueOf(full));
        for (String id : view.ids) {
            Element instance = result.createElement("instance");
            instance.setAttribute("id", id);
            root.appendChild(instance);
        }
        CircuitState state = view.resolve(this.state);
        Map<String, Component> components = view.components;
        StringBuilder ports = new StringBuilder();
        for (Map.Entry<String, Component> entry : components.entrySet()) {
            Component c = entry.getValue();
            String control = null, input = null;
            if (c.getFactory() instanceof Pin && Pin.FACTORY.isInputPin(Instance.getInstanceFor(c))) {
                control = view.nested() ? "parent-input" : "input";
                input = bits(Pin.FACTORY.getValue(state.getInstanceState(c)));
            }
            if (c.getFactory().getName().equals("Button")) control = "pulse";
            if (c.getFactory() instanceof Clock) control = "clock";
            ports.setLength(0);
            for (int i = 0; i < c.getEnds().size(); i++) {
                if (i > 0) ports.append('|');
                ports.append(bits(state.getValue(c.getEnd(i).getLocation())));
            }
            String text = ports.toString(), key = control + "\n" + input + "\n" + text;
            if (key.equals(sent.put(entry.getKey(), key))) continue;
            Element item = result.createElement("component");
            item.setAttribute("id", entry.getKey());
            if (control != null) item.setAttribute("control", control);
            if (input != null) item.setAttribute("input", input);
            item.setTextContent(text);
            root.appendChild(item);
        }
        if (memoryRequest != null) root.appendChild(StudioMemory.page(components.get(memoryRequest.getAttribute("componentId")), state, memoryRequest, result));
        Element waveform = trace.element(result, full);
        if (waveform != null) root.appendChild(waveform);
        return CircuitPaint.record(view, state);
    }

    private static final ThreadLocal<Transformer> XML = ThreadLocal.withInitial(() -> {
        try {
            Transformer transformer = TransformerFactory.newInstance().newTransformer();
            transformer.setOutputProperty(OutputKeys.OMIT_XML_DECLARATION, "yes");
            return transformer;
        } catch (TransformerConfigurationException error) {
            throw new IllegalStateException(error);
        }
    });

    private static String xml(Document result) throws Exception {
        StringWriter xml = new StringWriter();
        XML.get().transform(new DOMSource(result), new StreamResult(xml));
        return xml.toString();
    }

    private static void print(PrintStream protocol, String line) {
        synchronized (protocol) { protocol.println(line); protocol.flush(); }
    }

    private static void send(Document result, PrintStream protocol) throws Exception {
        print(protocol, xml(result));
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
                    synchronized (this) { running = false; failure = error.toString(); failureCode = "CLOCK_FAILURE"; version++; }
                }
            }
        }, "studio-clock");
        clock.setDaemon(true); clock.start();
        Thread frames = new Thread(() -> {
            long rendered = -1;
            CircuitPaint paint = new CircuitPaint();
            try {
                DocumentBuilder builder = DocumentBuilderFactory.newInstance().newDocumentBuilder();
                while (true) {
                    Document result = null; CircuitPaint.Recorded recorded = null;
                    long started = 0, captured = 0;
                    synchronized (this) {
                        if (version != rendered) {
                            // The time the frame holds the circuit, not the wait for the clock to let go.
                            started = System.nanoTime();
                            result = builder.newDocument(); result.appendChild(result.createElement("frame"));
                            recorded = sample(result); rendered = version; captured = System.nanoTime();
                        }
                    }
                    if (result != null) {
                        // What changed, its JSON and the XML do not hold the live circuit lock.
                        Element picture = result.createElement("paint");
                        picture.setTextContent(paint.delta(recorded, result.getDocumentElement().getAttribute("full").equals("true")));
                        result.getDocumentElement().appendChild(picture);
                        String xml = xml(result), root = "<frame";
                        // The timing covers the serialization, so it joins the root tag afterwards.
                        print(protocol, root + " captureMs=\"" + (captured - started) / 1e6 + "\" encodeMs=\""
                            + (System.nanoTime() - captured) / 1e6 + "\"" + xml.substring(root.length()));
                    }
                    Thread.sleep(16);
                }
            } catch (Throwable error) {
                error.printStackTrace(System.err);
                try {
                    Document result = DocumentBuilderFactory.newInstance().newDocumentBuilder().newDocument();
                    result.appendChild(result.createElement("frame-error"));
                    synchronized (this) {
                        running = false; failure = error.toString(); failureCode = SessionError.code(error);
                        metadata(result.getDocumentElement());
                    }
                    send(result, protocol);
                } catch (Exception ignored) { }
            }
        }, "studio-frames");
        frames.setDaemon(true); frames.start();
    }

    /**
     * The check mode: one circuit snapshot per request, without a run of its own.
     *
     * The class that serves a live run also answers bounded vector and trace
     * checks, so one native entry point and one line protocol cover every
     * simulation. Each request loads its own copy of its artifact: trace program
     * stimuli mutate ROM contents, and no state may carry over to the next
     * check. The reply is {@code ok<TAB>base64(result)} or
     * {@code error<TAB>message}; a rejected circuit ends the process so nothing
     * is served after a native failure.
     */
    private static void verifyLoop(Path runtime, String runtimeSha, DocumentBuilder parser, PrintStream protocol) throws Exception {
        if (!digest(runtime).equals(runtimeSha)) {
            reply(protocol, "error", "运行时已改变");
            System.exit(2);
        }
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
        String line;
        while ((line = in.readLine()) != null) {
            try {
                if (line.length() > 2_000_000) throw new IllegalArgumentException("请求过长");
                Element request = parser.parse(new ByteArrayInputStream(Base64.getDecoder().decode(line))).getDocumentElement();
                reply(protocol, "ok", verify(request, runtime, runtimeSha, parser));
            } catch (Throwable error) {
                error.printStackTrace(System.err);
                String message = error.getMessage() == null ? error.toString() : error.getMessage();
                reply(protocol, "error", message);
                System.exit(2);
            }
        }
        System.exit(0);
    }

    private static byte[] verify(Element request, Path runtime, String runtimeSha, DocumentBuilder parser) throws Exception {
        String artifactText = request.getAttribute("artifact"), artifactSha = request.getAttribute("digest");
        if (artifactText.isEmpty() || artifactSha.isEmpty()) throw new IllegalArgumentException("缺少电路快照身份");
        Path artifact = Paths.get(artifactText).toAbsolutePath().normalize();
        if (!digest(artifact).equals(artifactSha)) throw new IllegalArgumentException("电路快照已改变");
        Element operation = null;
        for (Node child = request.getFirstChild(); child != null; child = child.getNextSibling())
            if (child instanceof Element) { operation = (Element) child; break; }
        if (operation == null || !(operation.getTagName().equals("simulate") || operation.getTagName().equals("trace")))
            throw new IllegalArgumentException("校验只接受 simulate 或 trace");
        List<String> loaderMessages = new ArrayList<>();
        LogisimFile file = NativeCircuitLoader.openChecked(artifact.toFile(), loaderMessages);
        for (String message : loaderMessages) System.err.println("loader: " + message);
        Document result = parser.newDocument();
        Element root = result.createElement("result");
        root.setAttribute("runtimeJarSha256", runtimeSha);
        root.setAttribute("runtimeVersion", String.valueOf(com.cburch.logisim.Main.VERSION));
        root.setAttribute("artifactSha256", artifactSha);
        result.appendChild(root);
        if (operation.getTagName().equals("simulate")) CircuitWorkbench.simulate(file, operation, result);
        else CircuitWorkbench.trace(file, operation, result);
        // The result names the snapshot it read, so a caller can tell it ran on the bytes it sent.
        if (!digest(artifact).equals(artifactSha) || !digest(runtime).equals(runtimeSha))
            throw new IllegalStateException("原生仿真输入在执行期间发生变化");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        TransformerFactory.newInstance().newTransformer().transform(new DOMSource(result), new StreamResult(bytes));
        return bytes.toByteArray();
    }

    private static void reply(PrintStream protocol, String status, String message) {
        reply(protocol, status, message.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private static void reply(PrintStream protocol, String status, byte[] payload) {
        synchronized (protocol) {
            protocol.println(status + "\t" + Base64.getEncoder().encodeToString(payload));
            protocol.flush();
        }
    }

    private static String digest(Path path) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(path));
        StringBuilder hex = new StringBuilder();
        for (byte b : bytes) hex.append(String.format("%02x", b & 255));
        return hex.toString();
    }

    public static void main(String[] args) throws Exception {
        System.setProperty("java.awt.headless", "true");
        // The host reads UTF-8 whatever the platform's encoding (labels, messages).
        PrintStream protocol = new PrintStream(new BufferedOutputStream(new FileOutputStream(FileDescriptor.out), 1 << 16), false, "UTF-8");
        System.setOut(System.err);
        DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
        f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        f.setFeature("http://xml.org/sax/features/external-general-entities", false);
        DocumentBuilder parser = f.newDocumentBuilder();
        // {artifact} {init}                   a live run
        // --verify {runtime} {runtime digest} circuit checks
        if (args.length == 3 && args[0].equals("--verify")) {
            verifyLoop(Paths.get(args[1]).toAbsolutePath().normalize(), args[2], parser, protocol);
            return;
        }
        // The first frame's fonts, text and XML writing load beside the project.
        Document warm = parser.newDocument();
        warm.appendChild(warm.createElement("warm"));
        Thread warmUp = new Thread(() -> {
            try {
                CircuitPaint.warmUp(new File(args[0]));
                xml(warm);
            } catch (Throwable ignored) {
                // Only time is lost.
            }
        }, "warm-up");
        warmUp.setDaemon(true);
        warmUp.start();
        List<String> loaderMessages = new ArrayList<>();
        CircuitSession session;
        try {
            session = new CircuitSession(NativeCircuitLoader.openChecked(new File(args[0]), loaderMessages), parser.parse(new File(args[1])).getDocumentElement());
        } catch (Throwable error) {
            // The host learns why the run could not start instead of only seeing the exit.
            error.printStackTrace(System.err);
            for (String message : loaderMessages) System.err.println("loader: " + message);
            Document result = parser.newDocument();
            Element failure = result.createElement("start-error"); result.appendChild(failure);
            failure.setAttribute("error", error.toString());
            String code = SessionError.code(error);
            if (code != null) failure.setAttribute("code", code);
            if (error.getMessage() != null) failure.setAttribute("message", error.getMessage());
            send(result, protocol);
            System.exit(1);
            return;
        }
        for (String message : loaderMessages) System.err.println("loader: " + message);
        session.startWorkers(protocol);
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
        String line;
        while ((line = in.readLine()) != null) {
            Document result = parser.newDocument();
            Element ack = result.createElement("ack"); result.appendChild(ack);
            try {
                Element request = parser.parse(new ByteArrayInputStream(line.getBytes("UTF-8"))).getDocumentElement();
                // One ack per line, in the order the lines came: the host pairs them by order.
                synchronized (session) {
                    session.commandSequence++;
                    session.command(request);
                    session.metadata(ack);
                }
            } catch (Throwable error) {
                error.printStackTrace(System.err);
                ack.setAttribute("error", error.toString());
                String code = SessionError.code(error);
                if (code != null) ack.setAttribute("code", code);
                if (error.getMessage() != null) ack.setAttribute("message", error.getMessage());
            }
            send(result, protocol);
        }
        System.exit(0);
    }
}
