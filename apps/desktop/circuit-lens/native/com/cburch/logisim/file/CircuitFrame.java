package com.cburch.logisim.file;

import com.cburch.logisim.circuit.Circuit;
import com.cburch.logisim.circuit.CircuitState;
import com.cburch.logisim.comp.ComponentDrawContext;
import com.cburch.logisim.data.Bounds;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import org.w3c.dom.Element;

/** Bounded native drawing. The caller holds the same state lock used for ports. */
final class CircuitFrame {
    static final class Viewport {
        final int x, y, width, height;
        final double scale;
        Viewport(int x, int y, int width, int height, double scale) {
            double w = Math.ceil(width * scale), h = Math.ceil(height * scale);
            if (!Double.isFinite(scale) || scale <= 0 || scale > 32 || width <= 0 || height <= 0 ||
                Math.max(Math.max(Math.abs((long)x), Math.abs((long)y)), Math.max(width, height)) > 10_000_000 ||
                w < 1 || h < 1 || w > 4096 || h > 4096 || w*h > 8_000_000)
                throw new IllegalArgumentException("Viewport exceeds pixel budget");
            this.x=x; this.y=y; this.width=width; this.height=height; this.scale=scale;
        }
        static Viewport from(Element request) {
            return new Viewport(Integer.parseInt(request.getAttribute("x")), Integer.parseInt(request.getAttribute("y")),
                Integer.parseInt(request.getAttribute("width")), Integer.parseInt(request.getAttribute("height")),
                Double.parseDouble(request.getAttribute("scale")));
        }
    }

    static BufferedImage draw(Circuit circuit, CircuitState state, Viewport viewport, Element render) {
        if (viewport == null) {
            BufferedImage measure = new BufferedImage(1, 1, BufferedImage.TYPE_INT_ARGB);
            Graphics2D g=measure.createGraphics();
            Bounds box;
            try { box=circuit.getBounds(g).expand(24); } finally { g.dispose(); }
            double scale=Math.min(1.5, Math.min(Math.min(4095.0/box.getWidth(), 4095.0/box.getHeight()),
                Math.sqrt(6_000_000.0/Math.max(1.0, (double)box.getWidth()*box.getHeight()))));
            viewport=new Viewport(box.getX(), box.getY(), box.getWidth(), box.getHeight(), scale);
        }
        int width=(int)Math.ceil(viewport.width*viewport.scale), height=(int)Math.ceil(viewport.height*viewport.scale);
        BufferedImage bitmap=new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g=bitmap.createGraphics();
        try {
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
            g.scale(viewport.scale, viewport.scale); g.translate(-viewport.x, -viewport.y); g.setColor(Color.BLACK);
            ComponentDrawContext context=new ComponentDrawContext(null, circuit, state, g, g, true);
            context.setShowState(true); context.setShowColor(true); circuit.draw(context, null);
        } finally { g.dispose(); }
        render.setAttribute("x", String.valueOf(viewport.x)); render.setAttribute("y", String.valueOf(viewport.y));
        // Reflect pixel rounding in world bounds so ports and artwork share coordinates.
        render.setAttribute("width", String.valueOf(width/viewport.scale));
        render.setAttribute("height", String.valueOf(height/viewport.scale));
        render.setAttribute("scale", String.valueOf(viewport.scale));
        render.setAttribute("pixelWidth", String.valueOf(width)); render.setAttribute("pixelHeight", String.valueOf(height));
        return bitmap;
    }
}
