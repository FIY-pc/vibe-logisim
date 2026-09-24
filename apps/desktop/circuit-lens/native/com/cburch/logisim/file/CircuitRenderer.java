package com.cburch.logisim.file;

import com.cburch.logisim.circuit.Circuit;
import com.cburch.logisim.comp.ComponentDrawContext;
import com.cburch.logisim.proj.Project;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import javax.imageio.ImageIO;

/** Read-only drawing of one frozen project. No propagation or simulation commands. */
public final class CircuitRenderer {
    private static void verify(File file, String expected) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(file.toPath()));
        StringBuilder actual = new StringBuilder();
        for (byte b : hash) actual.append(String.format("%02x", b & 255));
        if (!actual.toString().equals(expected)) throw new IOException("Frozen render input changed");
    }

    public static void main(String[] args) throws Exception {
        PrintStream protocol = System.out;
        // Course libraries may print on load/draw; stdout belongs to the protocol.
        System.setOut(System.err);
        try {
            File artifact = new File(args[0]);
            verify(artifact, args[1]); verify(new File(args[2]), args[3]);
            List<String> warnings = new ArrayList<>();
            LogisimFile file = NativeCircuitLoader.openChecked(artifact, warnings);
            for (String warning : warnings) System.err.println("loader: " + warning);
            protocol.println("ready");
            BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            String line;
            while ((line = reader.readLine()) != null) {
                try {
                    if (line.length() > 16384) throw new IllegalArgumentException("Render request too long");
                    String[] fields = line.split("\t");
                    if (fields.length != 6) throw new IllegalArgumentException("Invalid viewport");
                    String name = new String(Base64.getDecoder().decode(fields[0]), StandardCharsets.UTF_8);
                    Circuit circuit = file.getCircuit(name);
                    if (circuit == null) throw new IllegalArgumentException("Unknown circuit");
                    protocol.println(Base64.getEncoder().encodeToString(draw(file,circuit,
                        Integer.parseInt(fields[1]),Integer.parseInt(fields[2]),Integer.parseInt(fields[3]),
                        Integer.parseInt(fields[4]),Double.parseDouble(fields[5]))));
                } catch (Exception error) { report(protocol, error); }
            }
        } catch (Exception error) { report(protocol, error); }
        // Logisim creates background housekeeping threads even without simulation.
        System.exit(0);
    }

    public static byte[] draw(LogisimFile file, Circuit circuit, int x, int y, int width, int height, double scale) throws Exception {
        double w = Math.ceil(width * scale), h = Math.ceil(height * scale);
        if (width <= 0 || height <= 0 || !Double.isFinite(scale) || scale <= 0 ||
            w < 1 || h < 1 || w > 4096 || h > 4096 || w * h > 8_000_000)
            throw new IllegalArgumentException("Viewport exceeds pixel budget");
        Project project = new Project(file); project.getSimulator().shutDown();
        BufferedImage bitmap = new BufferedImage((int) w, (int) h, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = bitmap.createGraphics();
        try {
            g.setColor(Color.WHITE); g.fillRect(0, 0, (int) w, (int) h);
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
            g.scale(scale, scale); g.translate(-x, -y); g.setColor(Color.BLACK);
            ComponentDrawContext context = new ComponentDrawContext(null, circuit,
                project.getCircuitState(circuit), g, g, true);
            context.setShowState(false); context.setShowColor(true);
            circuit.draw(context, null);
        } finally { g.dispose(); }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        ImageIO.write(bitmap, "png", bytes);
        return bytes.toByteArray();
    }

    private static void report(PrintStream stream, Exception error) {
        stream.println("error\t" + Base64.getEncoder().encodeToString(String.valueOf(error.getMessage()).getBytes(StandardCharsets.UTF_8)));
    }
}
