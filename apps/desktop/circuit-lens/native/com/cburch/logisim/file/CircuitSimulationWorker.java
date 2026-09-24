package com.cburch.logisim.file;

import com.cburch.logisim.std.wiring.Pin;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import javax.xml.parsers.*;
import javax.xml.transform.*;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.stream.StreamResult;
import org.w3c.dom.*;

/**
 * A disposable, serial simulation process.
 *
 * The JVM is reused, but every request loads a fresh immutable artifact. The
 * loaded LogisimFile is never cached because trace program stimuli can mutate
 * ROM objects in memory. CircuitWorkbench closes the request Project's
 * Simulator in a finally block; a native rejection terminates this process so
 * a future request cannot inherit an uncertain native state.
 */
public final class CircuitSimulationWorker {
    private final PrintStream protocol;
    private final DocumentBuilderFactory parserFactory;

    private CircuitSimulationWorker(PrintStream protocol) throws Exception {
        this.protocol = protocol;
        parserFactory = DocumentBuilderFactory.newInstance();
        parserFactory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        parserFactory.setFeature("http://xml.org/sax/features/external-general-entities", false);
        parserFactory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        parserFactory.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
    }

    private static String digest(Path path) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(path));
        StringBuilder result = new StringBuilder();
        for (byte b : bytes) result.append(String.format("%02x", b & 255));
        return result.toString();
    }

    private static void reply(PrintStream protocol, String status, byte[] payload) {
        protocol.println(status + "\t" + Base64.getEncoder().encodeToString(payload));
        protocol.flush();
    }

    private static LogisimFile loadFresh(Path artifact) throws Exception {
        List<String> warnings = new ArrayList<>();
        PrintStream previous = System.out;
        ByteArrayOutputStream loaderOutput = new ByteArrayOutputStream();
        LogisimFile file;
        try {
            System.setOut(new PrintStream(loaderOutput, true, StandardCharsets.UTF_8));
            file = NativeCircuitLoader.openChecked(artifact.toFile(), warnings);
        } finally {
            System.setOut(previous);
        }
        for (String warning : warnings) System.err.println("loader: " + warning);
        return file;
    }

    private void execute(Element envelope, Path runtime, String runtimeSha) throws Exception {
        String artifactText = envelope.getAttribute("artifact");
        String artifactSha = envelope.getAttribute("digest");
        if (artifactText.isEmpty() || artifactSha.isEmpty()) throw new IllegalArgumentException("缺少电路快照身份");
        Path artifact = Paths.get(artifactText).toAbsolutePath().normalize();
        if (!digest(artifact).equals(artifactSha)) throw new IllegalArgumentException("电路快照已改变");
        Element operation = null;
        for (Node child = envelope.getFirstChild(); child != null; child = child.getNextSibling()) {
            if (child instanceof Element) { operation = (Element) child; break; }
        }
        if (operation == null || !(operation.getTagName().equals("simulate") || operation.getTagName().equals("trace")))
            throw new IllegalArgumentException("仿真 worker 只接受 simulate 或 trace");

        LogisimFile file = loadFresh(artifact);
        DocumentBuilder parser = parserFactory.newDocumentBuilder();
        Document result = parser.newDocument();
        Element root = result.createElement("result");
        result.appendChild(root);
        root.setAttribute("runtimeJarSha256", runtimeSha);
        root.setAttribute("runtimeVersion", String.valueOf(com.cburch.logisim.Main.VERSION));
        root.setAttribute("artifactSha256", artifactSha);
        java.lang.reflect.Method method = CircuitWorkbench.class.getDeclaredMethod(
            operation.getTagName(), LogisimFile.class, Element.class, Document.class);
        method.setAccessible(true);
        try {
            method.invoke(null, file, operation, result);
        } catch (java.lang.reflect.InvocationTargetException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            if (cause instanceof Error) throw (Error) cause;
            throw error;
        }
        if (!digest(artifact).equals(artifactSha) || !digest(runtime).equals(runtimeSha))
            throw new IllegalStateException("原生仿真输入在执行期间发生变化");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        TransformerFactory.newInstance().newTransformer().transform(new DOMSource(result), new StreamResult(bytes));
        reply(protocol, "ok", bytes.toByteArray());
    }

    private void run(Path runtime, String runtimeSha) throws Exception {
        reply(protocol, "ok", "ready".getBytes(StandardCharsets.UTF_8));
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = reader.readLine()) != null) {
            try {
                if (line.length() > 2_000_000) throw new IllegalArgumentException("请求过长");
                byte[] encoded = Base64.getDecoder().decode(line);
                Element envelope = parserFactory.newDocumentBuilder()
                    .parse(new ByteArrayInputStream(encoded)).getDocumentElement();
                execute(envelope, runtime, runtimeSha);
            } catch (Throwable error) {
                String message = error.getMessage() == null ? error.toString() : error.getMessage();
                reply(protocol, "error", message.getBytes(StandardCharsets.UTF_8));
                // Native failure is a process boundary. Do not serve another
                // request after a partially executed or rejected circuit.
                System.exit(2);
            }
        }
    }

    public static void main(String[] args) {
        System.setProperty("java.awt.headless", "true");
        PrintStream protocol = System.out;
        System.setOut(System.err);
        try {
            if (args.length != 2) throw new IllegalArgumentException("runtime and runtime digest required");
            Path runtime = Paths.get(args[0]).toAbsolutePath().normalize();
            String runtimeSha = args[1];
            if (!digest(runtime).equals(runtimeSha)) throw new IllegalArgumentException("运行时已改变");
            new CircuitSimulationWorker(protocol).run(runtime, runtimeSha);
        } catch (Throwable error) {
            reply(protocol, "error", String.valueOf(error.getMessage()).getBytes(StandardCharsets.UTF_8));
            System.exit(2);
        }
    }
}
