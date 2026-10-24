package com.cburch.logisim.file;

import com.cburch.logisim.circuit.Circuit;
import com.cburch.logisim.comp.ComponentDrawContext;
import com.cburch.logisim.proj.Project;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;

/** Read-only drawing of one viewport of a loaded project. No propagation or simulation commands. */
public final class CircuitRenderer {
    public static byte[] draw(Project project, Circuit circuit, int x, int y, int width, int height, double scale) throws Exception {
        double w = Math.ceil(width * scale), h = Math.ceil(height * scale);
        if (width <= 0 || height <= 0 || !Double.isFinite(scale) || scale <= 0 ||
            w < 1 || h < 1 || w > 4096 || h > 4096 || w * h > 8_000_000)
            throw new IllegalArgumentException("Viewport exceeds pixel budget");
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
        WorkerTiming.mark("render.draw");
        return PngEncoder.encode(bitmap);
    }
}
