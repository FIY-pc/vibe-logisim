package com.cburch.logisim.file;

import java.awt.AlphaComposite;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Composite;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.GraphicsConfiguration;
import java.awt.Image;
import java.awt.Paint;
import java.awt.Polygon;
import java.awt.Rectangle;
import java.awt.RenderingHints;
import java.awt.Shape;
import java.awt.Stroke;
import java.awt.font.FontRenderContext;
import java.awt.font.GlyphVector;
import java.awt.geom.AffineTransform;
import java.awt.geom.Arc2D;
import java.awt.geom.Area;
import java.awt.geom.Ellipse2D;
import java.awt.geom.Line2D;
import java.awt.geom.NoninvertibleTransformException;
import java.awt.geom.Path2D;
import java.awt.geom.PathIterator;
import java.awt.geom.Rectangle2D;
import java.awt.geom.RoundRectangle2D;
import java.awt.image.BufferedImage;
import java.awt.image.BufferedImageOp;
import java.awt.image.ImageObserver;
import java.awt.image.RenderedImage;
import java.awt.image.renderable.RenderableImage;
import java.text.AttributedCharacterIterator;
import java.util.Base64;
import java.util.Map;
import java.util.Objects;
import java.util.WeakHashMap;

/**
 * A Graphics2D that paints nothing and writes each drawing call as a vector op
 * (JSON) in the space of the root recorder: the current transform is applied to
 * the coordinates. Children from create() share the op list and copy the state.
 * A style op (color, stroke, font, alpha, clip) is written only when a drawing
 * op needs another one than the last written, so a recording starts with every
 * style it uses and replays on its own. Font metrics and the render context
 * come from a real 1x1 image graphics with the same transform and hints, so
 * components lay out text as they do when painting.
 *
 * Ops, all coordinates in root space ({@code editor/paint.ts} replays them):
 * <pre>
 * ["C", "#rrggbb[aa]"]             color for the following ops
 * ["N", class]                     a paint that is not a color (kept as the last color)
 * ["W", width, cap, join, [miter], [[dash…], phase]]   stroke; cap 0 butt 1 round 2 square, join 0 miter 1 round 2 bevel; miter only when not 10
 * ["F", family, style, size]       font; style 1 bold, 2 italic
 * ["X", rule, alpha]               AlphaComposite ("X" alone: plain source over)
 * ["K"] | ["K", x, y, w, h] | ["K", path]   clip (none, rectangle, path)
 * ["Z"] | ["Z", color]             paint mode, XOR mode
 * ["L", x1, y1, x2, y2]            line
 * ["R"|"r", x, y, w, h]            rectangle drawn | filled
 * ["E", color, x, y, w, h] | ["E", color, path]   cleared to the background color
 * ["Q"|"q", x, y, w, h, arcWidth, arcHeight]      round rectangle
 * ["O"|"o", x, y, w, h]            oval
 * ["A"|"a", x, y, w, h, start, extent]           arc (filled: pie), degrees counterclockwise as Java
 * ["Y", [x, y, …]]                 polyline
 * ["G"|"g", [x, y, …]]             polygon (filled even-odd)
 * ["P"|"p", path, [1]]             shape drawn | filled; path "M x y L x y Q x y x y C x y x y x y Z"; 1 = even-odd fill
 * ["T", text, x, y, [[a, b, c, d]]]   text, baseline-left at x, y; the matrix when the transform is not a translation
 * ["I", dataUrl, [a, b, c, d, e, f]]  image under that transform
 * ["U", x, y]                      the next drawing op only when something else connects at x, y
 * </pre>
 * The painting asks for a connection (Circuit.isConnected) only through the
 * circuit of its draw context; {@link Recording#condition} marks the next
 * drawing op with the point asked, and the window decides it per instance.
 */
final class RecordingGraphics2D extends Graphics2D {
    /** The op list of one recording and what was last written to it. */
    static final class Recording {
        final StringBuilder ops = new StringBuilder(512);
        /** Ink extent in root space: everything any op may touch. */
        double minX = Double.POSITIVE_INFINITY, minY = Double.POSITIVE_INFINITY;
        double maxX = Double.NEGATIVE_INFINITY, maxY = Double.NEGATIVE_INFINITY;
        final Graphics2D measure;
        AffineTransform measureTransform;
        RenderingHints measureHints;
        Object color, stroke, font;
        Composite composite = AlphaComposite.SrcOver;
        Shape clip;
        Color xor;
        private boolean conditional;
        private double conditionX, conditionY;

        Recording() { measure = MEASURE.get(); }

        /** The next drawing op is drawn only when something else connects at x, y. */
        void condition(double x, double y) {
            conditional = true;
            conditionX = x;
            conditionY = y;
        }

        boolean empty() { return ops.length() == 0; }

        void ink(double x0, double y0, double x1, double y1) {
            if (!(x0 <= x1) || !(y0 <= y1)) return;
            minX = Math.min(minX, x0); minY = Math.min(minY, y0);
            maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1);
        }

        void ink(Rectangle2D r, double grow) {
            ink(r.getMinX() - grow, r.getMinY() - grow, r.getMaxX() + grow, r.getMaxY() + grow);
        }

        /** The ops as a JSON array. */
        String json() { return "[" + ops + "]"; }
    }

    private static final ThreadLocal<Graphics2D> MEASURE = ThreadLocal.withInitial(() ->
        new BufferedImage(1, 1, BufferedImage.TYPE_INT_ARGB).createGraphics());
    private static RenderingHints defaultHints;
    private static final Map<Image, String> IMAGES = new WeakHashMap<>();

    private static synchronized RenderingHints defaultHints() {
        if (defaultHints == null) {
            Graphics2D g = new BufferedImage(1, 1, BufferedImage.TYPE_INT_RGB).createGraphics();
            defaultHints = (RenderingHints) g.getRenderingHints().clone();
            g.dispose();
        }
        return defaultHints;
    }

    private final Recording r;
    private AffineTransform tx;
    private Color color;
    private Paint paint;
    private Stroke stroke;
    private Font font;
    private Composite composite;
    private Color background;
    private Color xor;
    /** Clip in root space, or null. */
    private Shape clip;
    /** Shared until changed. */
    private RenderingHints hints;

    /** A root recorder in the state a fresh image graphics starts in. */
    RecordingGraphics2D(Recording recording) {
        r = recording;
        tx = new AffineTransform();
        color = Color.WHITE;
        paint = color;
        stroke = new BasicStroke();
        font = r.measure.getFont();
        composite = AlphaComposite.SrcOver;
        background = r.measure.getBackground();
        hints = (RenderingHints) defaultHints().clone();
    }

    private RecordingGraphics2D(RecordingGraphics2D p) {
        r = p.r;
        tx = new AffineTransform(p.tx);
        color = p.color;
        paint = p.paint;
        stroke = p.stroke;
        font = p.font;
        composite = p.composite;
        background = p.background;
        xor = p.xor;
        clip = p.clip;
        hints = p.hints;
    }

    // ------------------------------------------------------------------ state

    @Override public Graphics create() { return new RecordingGraphics2D(this); }

    @Override public Graphics create(int x, int y, int width, int height) {
        RecordingGraphics2D g = new RecordingGraphics2D(this);
        g.tx.translate(x, y);
        g.clipTo(new Rectangle(0, 0, width, height));
        return g;
    }

    @Override public void translate(int x, int y) { tx.translate(x, y); }
    @Override public void translate(double x, double y) { tx.translate(x, y); }
    @Override public void rotate(double theta) { tx.rotate(theta); }
    @Override public void rotate(double theta, double x, double y) { tx.rotate(theta, x, y); }
    @Override public void scale(double sx, double sy) { tx.scale(sx, sy); }
    @Override public void shear(double shx, double shy) { tx.shear(shx, shy); }
    @Override public void transform(AffineTransform t) { tx.concatenate(t); }
    @Override public void setTransform(AffineTransform t) { tx = new AffineTransform(t); }
    @Override public AffineTransform getTransform() { return new AffineTransform(tx); }

    @Override public Color getColor() { return color; }
    @Override public void setColor(Color c) { if (c != null) { color = c; paint = c; } }
    @Override public Paint getPaint() { return paint; }
    @Override public void setPaint(Paint p) {
        if (p == null) return;
        paint = p;
        if (p instanceof Color) color = (Color) p;
    }
    @Override public void setPaintMode() { xor = null; }
    @Override public void setXORMode(Color c) { xor = c; }
    @Override public Font getFont() { return font; }
    @Override public void setFont(Font f) { if (f != null) font = f; }
    @Override public Stroke getStroke() { return stroke; }
    @Override public void setStroke(Stroke s) { if (s != null) stroke = s; }
    @Override public Composite getComposite() { return composite; }
    @Override public void setComposite(Composite c) { if (c != null) composite = c; }
    @Override public Color getBackground() { return background; }
    @Override public void setBackground(Color c) { background = c; }

    @Override public void setRenderingHint(RenderingHints.Key key, Object value) {
        RenderingHints h = (RenderingHints) hints.clone();
        h.put(key, value);
        hints = h;
    }
    @Override public Object getRenderingHint(RenderingHints.Key key) { return hints.get(key); }
    @Override public void setRenderingHints(Map<?, ?> map) {
        RenderingHints h = (RenderingHints) defaultHints().clone();
        h.putAll(map);
        hints = h;
    }
    @Override public void addRenderingHints(Map<?, ?> map) {
        RenderingHints h = (RenderingHints) hints.clone();
        h.putAll(map);
        hints = h;
    }
    @Override public RenderingHints getRenderingHints() { return (RenderingHints) hints.clone(); }

    private Graphics2D measure() {
        Graphics2D m = r.measure;
        if (r.measureHints != hints) { m.setRenderingHints(hints); r.measureHints = hints; }
        if (r.measureTransform == null || !r.measureTransform.equals(tx)) {
            m.setTransform(tx);
            r.measureTransform = new AffineTransform(tx);
        }
        return m;
    }

    @Override public FontMetrics getFontMetrics() { return measure().getFontMetrics(font); }
    @Override public FontMetrics getFontMetrics(Font f) { return measure().getFontMetrics(f); }
    @Override public FontRenderContext getFontRenderContext() { return measure().getFontRenderContext(); }
    @Override public GraphicsConfiguration getDeviceConfiguration() { return r.measure.getDeviceConfiguration(); }

    // ------------------------------------------------------------------ clip

    private Shape userClip() {
        if (clip == null) return null;
        try {
            return tx.createInverse().createTransformedShape(clip);
        } catch (NoninvertibleTransformException e) {
            return null;
        }
    }

    private void clipTo(Shape user) {
        Shape root = tx.createTransformedShape(user);
        if (clip == null) clip = rectangleOrShape(root);
        else if (clip instanceof Rectangle2D && rectangleOrShape(root) instanceof Rectangle2D) {
            Rectangle2D both = new Rectangle2D.Double();
            Rectangle2D.intersect((Rectangle2D) clip, (Rectangle2D) rectangleOrShape(root), both);
            clip = both;
        } else {
            Area area = new Area(clip);
            area.intersect(new Area(root));
            clip = rectangleOrShape(area);
        }
    }

    /** createTransformedShape answers a path even for a moved rectangle. */
    private static Shape rectangleOrShape(Shape s) {
        if (s instanceof Rectangle2D) return s;
        PathIterator it = s.getPathIterator(null);
        double[] p = new double[6];
        int lines = 0;
        double px = 0, py = 0;
        while (!it.isDone()) {
            int type = it.currentSegment(p);
            if (type == PathIterator.SEG_MOVETO) {
                if (lines > 0) return s;
                px = p[0]; py = p[1];
            } else if (type == PathIterator.SEG_LINETO) {
                if (p[0] != px && p[1] != py) return s;
                px = p[0]; py = p[1]; lines++;
            } else if (type != PathIterator.SEG_CLOSE) return s;
            it.next();
        }
        return lines <= 4 ? s.getBounds2D() : s;
    }

    @Override public void clipRect(int x, int y, int w, int h) { clipTo(new Rectangle(x, y, w, h)); }
    @Override public void setClip(int x, int y, int w, int h) {
        clip = rectangleOrShape(tx.createTransformedShape(new Rectangle(x, y, w, h)));
    }
    @Override public void setClip(Shape s) { clip = s == null ? null : rectangleOrShape(tx.createTransformedShape(s)); }
    @Override public void clip(Shape s) { if (s == null) clip = null; else clipTo(s); }
    @Override public Shape getClip() { return userClip(); }
    @Override public Rectangle getClipBounds() {
        Shape u = userClip();
        return u == null ? null : u.getBounds();
    }
    @Override public Rectangle getClipBounds(Rectangle into) {
        Shape u = userClip();
        if (u != null) into.setBounds(u.getBounds());
        return into;
    }
    @SuppressWarnings("deprecation")
    @Override public Rectangle getClipRect() { return getClipBounds(); }
    @Override public boolean hitClip(int x, int y, int w, int h) {
        Shape u = userClip();
        return u == null || u.intersects(x, y, w, h);
    }
    @Override public boolean hit(Rectangle rect, Shape s, boolean onStroke) {
        if (onStroke) s = stroke.createStrokedShape(s);
        return tx.createTransformedShape(s).intersects(rect);
    }

    // ------------------------------------------------------------------ writing

    private StringBuilder op(String code) {
        StringBuilder b = r.ops;
        if (b.length() > 0) b.append(',');
        b.append("[\"").append(code).append('"');
        return b;
    }

    /** A drawing op, after the connection it depends on when the painting asked for one. */
    private StringBuilder draw(String code) {
        if (r.conditional) {
            r.conditional = false;
            StringBuilder b = op("U");
            nums(b, r.conditionX, r.conditionY);
            end(b);
        }
        return op(code);
    }

    private static void end(StringBuilder b) { b.append(']'); }

    static void num(StringBuilder b, double v) {
        if (v == Math.rint(v) && Math.abs(v) < 1e15) { b.append((long) v); return; }
        long n = Math.round(v * 100);
        if (n == 0) { b.append('0'); return; }
        if (n < 0) { b.append('-'); n = -n; }
        b.append(n / 100);
        long f = n % 100;
        if (f == 0) return;
        b.append('.');
        if (f % 10 == 0) b.append(f / 10);
        else { if (f < 10) b.append('0'); b.append(f); }
    }

    private static void nums(StringBuilder b, double... v) {
        for (double d : v) { b.append(','); num(b, d); }
    }

    private static void list(StringBuilder b, double[] v) {
        b.append(",[");
        for (int i = 0; i < v.length; i++) { if (i > 0) b.append(','); num(b, v[i]); }
        b.append(']');
    }

    static void str(StringBuilder b, String s) {
        b.append('"');
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch == '"' || ch == '\\') b.append('\\').append(ch);
            else if (ch < 0x20) b.append(String.format("\\u%04x", (int) ch));
            else b.append(ch);
        }
        b.append('"');
    }

    static String color(Color c) {
        int argb = c.getRGB(), alpha = argb >>> 24;
        String hex = String.format("#%06x", argb & 0xffffff);
        return alpha == 255 ? hex : hex + String.format("%02x", alpha);
    }

    private static String path(Shape s, AffineTransform t) {
        StringBuilder p = new StringBuilder(64);
        PathIterator it = s.getPathIterator(t);
        double[] c = new double[6];
        while (!it.isDone()) {
            int type = it.currentSegment(c), points;
            switch (type) {
                case PathIterator.SEG_MOVETO: p.append('M'); points = 1; break;
                case PathIterator.SEG_LINETO: p.append('L'); points = 1; break;
                case PathIterator.SEG_QUADTO: p.append('Q'); points = 2; break;
                case PathIterator.SEG_CUBICTO: p.append('C'); points = 3; break;
                default: p.append('Z'); points = 0;
            }
            for (int i = 0; i < 2 * points; i++) { if (i > 0) p.append(' '); num(p, c[i]); }
            it.next();
        }
        return p.toString();
    }

    private boolean translateOnly() {
        return tx.getScaleX() == 1 && tx.getScaleY() == 1 && tx.getShearX() == 0 && tx.getShearY() == 0;
    }

    /** Axis-aligned with positive scale: rectangles, ovals and arcs stay what they are. */
    private boolean axisPositive() {
        return tx.getShearX() == 0 && tx.getShearY() == 0 && tx.getScaleX() > 0 && tx.getScaleY() > 0;
    }

    /** Writes the color, alpha, clip and XOR mode a drawing op needs. */
    private void fillStyle() {
        Object p = paint instanceof Color ? color : paint;
        if (!Objects.equals(p, r.color)) {
            r.color = p;
            StringBuilder b = op(p instanceof Color ? "C" : "N");
            b.append(',');
            str(b, p instanceof Color ? color((Color) p) : p.getClass().getName());
            end(b);
        }
        if (!Objects.equals(composite, r.composite)) {
            r.composite = composite;
            StringBuilder b = op("X");
            if (composite instanceof AlphaComposite && !AlphaComposite.SrcOver.equals(composite)) {
                AlphaComposite a = (AlphaComposite) composite;
                b.append(',').append(a.getRule());
                nums(b, a.getAlpha());
            }
            end(b);
        }
        if (!Objects.equals(clip, r.clip)) {
            r.clip = clip;
            StringBuilder b = op("K");
            if (clip instanceof Rectangle2D) {
                Rectangle2D c = (Rectangle2D) clip;
                nums(b, c.getX(), c.getY(), c.getWidth(), c.getHeight());
            } else if (clip != null) {
                b.append(',');
                str(b, path(clip, null));
            }
            end(b);
        }
        if (!Objects.equals(xor, r.xor)) {
            r.xor = xor;
            StringBuilder b = op("Z");
            if (xor != null) { b.append(','); str(b, color(xor)); }
            end(b);
        }
    }

    /** The stroke as it applies in root space; null when the transform stretches it unevenly. */
    private Stroke rootStroke() {
        if (translateOnly()) return stroke;
        double a = tx.getScaleX(), b = tx.getShearY(), c = tx.getShearX(), d = tx.getScaleY();
        double s1 = Math.hypot(a, b), s2 = Math.hypot(c, d);
        if (Math.abs(a * c + b * d) > 1e-9 || Math.abs(s1 - s2) > 1e-9) return null;
        if (Math.abs(s1 - 1) < 1e-12) return stroke;
        if (!(stroke instanceof BasicStroke)) return null;
        BasicStroke bs = (BasicStroke) stroke;
        float[] dash = bs.getDashArray();
        if (dash != null) { dash = dash.clone(); for (int i = 0; i < dash.length; i++) dash[i] *= (float) s1; }
        return new BasicStroke((float) (bs.getLineWidth() * s1), bs.getEndCap(), bs.getLineJoin(),
            bs.getMiterLimit(), dash, (float) (bs.getDashPhase() * s1));
    }

    /** Half the extent a stroke adds around its line, generously for miters. */
    private static double reach(Stroke s) {
        return s instanceof BasicStroke ? Math.max(1, ((BasicStroke) s).getLineWidth()) : 2;
    }

    /**
     * Writes the style of a stroked op and answers the stroke's reach; -1 when
     * the op has to be written as its filled outline instead.
     */
    private double strokeStyle() {
        Stroke s = rootStroke();
        if (!(s instanceof BasicStroke)) return -1;
        fillStyle();
        if (!Objects.equals(s, r.stroke)) {
            r.stroke = s;
            BasicStroke bs = (BasicStroke) s;
            StringBuilder b = op("W");
            nums(b, bs.getLineWidth());
            b.append(',').append(bs.getEndCap()).append(',').append(bs.getLineJoin());
            if (bs.getLineJoin() == BasicStroke.JOIN_MITER && bs.getMiterLimit() != 10f) nums(b, bs.getMiterLimit());
            float[] dash = bs.getDashArray();
            if (dash != null) {
                double[] d = new double[dash.length];
                for (int i = 0; i < d.length; i++) d[i] = dash[i];
                list(b, d);
                nums(b, bs.getDashPhase());
            }
            end(b);
        }
        return reach(s);
    }

    private double[] points(double... xy) {
        tx.transform(xy, 0, xy, 0, xy.length / 2);
        return xy;
    }

    private static double[] points(int[] xs, int[] ys, int n) {
        double[] v = new double[2 * Math.max(0, Math.min(n, Math.min(xs.length, ys.length)))];
        for (int i = 0; i < v.length / 2; i++) { v[2 * i] = xs[i]; v[2 * i + 1] = ys[i]; }
        return v;
    }

    private void inkPoints(double[] v, double grow) {
        for (int i = 0; i + 1 < v.length; i += 2) r.ink(v[i] - grow, v[i + 1] - grow, v[i] + grow, v[i + 1] + grow);
    }

    /** x, y, w, h under an axis-aligned positive transform, then the rest as given. */
    private double[] box(double x, double y, double w, double h, double... rest) {
        double[] v = new double[4 + rest.length];
        v[0] = tx.getScaleX() * x + tx.getTranslateX();
        v[1] = tx.getScaleY() * y + tx.getTranslateY();
        v[2] = tx.getScaleX() * w;
        v[3] = tx.getScaleY() * h;
        System.arraycopy(rest, 0, v, 4, rest.length);
        return v;
    }

    private void boxOp(String code, double[] v, double grow) {
        StringBuilder b = draw(code);
        nums(b, v);
        end(b);
        r.ink(v[0] - grow, v[1] - grow, v[0] + Math.abs(v[2]) + grow, v[1] + Math.abs(v[3]) + grow);
    }

    /** A shape, drawn or filled, as a path with its curves. */
    private void shape(Shape user, boolean fill) {
        if (!fill) {
            double reach = strokeStyle();
            if (reach < 0) { // stretched unevenly: fill the stroked outline
                shape(stroke.createStrokedShape(user), true);
                return;
            }
            StringBuilder b = draw("P");
            b.append(',');
            str(b, path(user, tx));
            end(b);
            r.ink(tx.createTransformedShape(user).getBounds2D(), reach);
            return;
        }
        fillStyle();
        StringBuilder b = draw("p");
        b.append(',');
        str(b, path(user, tx));
        if (user.getPathIterator(null).getWindingRule() == PathIterator.WIND_EVEN_ODD) b.append(",1");
        end(b);
        r.ink(tx.createTransformedShape(user).getBounds2D(), 1);
    }

    // ------------------------------------------------------------------ primitives

    @Override public void drawLine(int x1, int y1, int x2, int y2) {
        double reach = strokeStyle();
        if (reach < 0) { shape(new Line2D.Double(x1, y1, x2, y2), false); return; }
        double[] v = points(x1, y1, x2, y2);
        StringBuilder b = draw("L");
        nums(b, v);
        end(b);
        inkPoints(v, reach);
    }

    @Override public void drawRect(int x, int y, int w, int h) {
        if (w < 0 || h < 0) return;
        if (!axisPositive()) { shape(new Rectangle(x, y, w, h), false); return; }
        double reach = strokeStyle();
        if (reach < 0) { shape(new Rectangle(x, y, w, h), false); return; }
        boxOp("R", box(x, y, w, h), reach);
    }

    @Override public void fillRect(int x, int y, int w, int h) {
        if (w <= 0 || h <= 0) return;
        if (!axisPositive()) { shape(new Rectangle(x, y, w, h), true); return; }
        fillStyle();
        boxOp("r", box(x, y, w, h), 1);
    }

    @Override public void clearRect(int x, int y, int w, int h) {
        if (w <= 0 || h <= 0) return;
        fillStyle();
        Color with = background == null ? Color.WHITE : background;
        if (axisPositive()) {
            double[] v = box(x, y, w, h);
            StringBuilder b = draw("E");
            b.append(',');
            str(b, color(with));
            nums(b, v);
            end(b);
            r.ink(v[0], v[1], v[0] + v[2], v[1] + v[3]);
        } else {
            Shape s = new Rectangle(x, y, w, h);
            StringBuilder b = draw("E");
            b.append(',');
            str(b, color(with));
            b.append(',');
            str(b, path(s, tx));
            end(b);
            r.ink(tx.createTransformedShape(s).getBounds2D(), 1);
        }
    }

    @Override public void drawRoundRect(int x, int y, int w, int h, int aw, int ah) {
        if (!axisPositive()) { shape(new RoundRectangle2D.Double(x, y, w, h, aw, ah), false); return; }
        double reach = strokeStyle();
        if (reach < 0) { shape(new RoundRectangle2D.Double(x, y, w, h, aw, ah), false); return; }
        boxOp("Q", box(x, y, w, h, aw * tx.getScaleX(), ah * tx.getScaleY()), reach);
    }

    @Override public void fillRoundRect(int x, int y, int w, int h, int aw, int ah) {
        if (!axisPositive()) { shape(new RoundRectangle2D.Double(x, y, w, h, aw, ah), true); return; }
        fillStyle();
        boxOp("q", box(x, y, w, h, aw * tx.getScaleX(), ah * tx.getScaleY()), 1);
    }

    @Override public void drawOval(int x, int y, int w, int h) {
        if (!axisPositive()) { shape(new Ellipse2D.Double(x, y, w, h), false); return; }
        double reach = strokeStyle();
        if (reach < 0) { shape(new Ellipse2D.Double(x, y, w, h), false); return; }
        boxOp("O", box(x, y, w, h), reach);
    }

    @Override public void fillOval(int x, int y, int w, int h) {
        if (!axisPositive()) { shape(new Ellipse2D.Double(x, y, w, h), true); return; }
        fillStyle();
        boxOp("o", box(x, y, w, h), 1);
    }

    @Override public void drawArc(int x, int y, int w, int h, int start, int extent) {
        if (!axisPositive()) { shape(new Arc2D.Double(x, y, w, h, start, extent, Arc2D.OPEN), false); return; }
        double reach = strokeStyle();
        if (reach < 0) { shape(new Arc2D.Double(x, y, w, h, start, extent, Arc2D.OPEN), false); return; }
        boxOp("A", box(x, y, w, h, start, extent), reach);
    }

    @Override public void fillArc(int x, int y, int w, int h, int start, int extent) {
        if (!axisPositive()) { shape(new Arc2D.Double(x, y, w, h, start, extent, Arc2D.PIE), true); return; }
        fillStyle();
        boxOp("a", box(x, y, w, h, start, extent), 1);
    }

    private void polyOp(String code, double[] v, double grow) {
        StringBuilder b = draw(code);
        list(b, v);
        end(b);
        inkPoints(v, grow);
    }

    @Override public void drawPolyline(int[] xs, int[] ys, int n) {
        if (n <= 0) return;
        double reach = strokeStyle();
        if (reach < 0) {
            Path2D p = new Path2D.Double();
            for (int i = 0; i < n; i++) { if (i == 0) p.moveTo(xs[i], ys[i]); else p.lineTo(xs[i], ys[i]); }
            shape(p, false);
            return;
        }
        polyOp("Y", points(points(xs, ys, n)), reach);
    }

    @Override public void drawPolygon(int[] xs, int[] ys, int n) {
        if (n <= 0) return;
        double reach = strokeStyle();
        if (reach < 0) { shape(new Polygon(xs, ys, n), false); return; }
        polyOp("G", points(points(xs, ys, n)), reach);
    }

    @Override public void fillPolygon(int[] xs, int[] ys, int n) {
        if (n <= 0) return;
        fillStyle();
        polyOp("g", points(points(xs, ys, n)), 1);
    }

    @Override public void drawPolygon(Polygon p) { drawPolygon(p.xpoints, p.ypoints, p.npoints); }
    @Override public void fillPolygon(Polygon p) { fillPolygon(p.xpoints, p.ypoints, p.npoints); }
    @Override public void draw(Shape s) { if (s != null) shape(s, false); }
    @Override public void fill(Shape s) { if (s != null) shape(s, true); }
    @Override public void copyArea(int x, int y, int w, int h, int dx, int dy) { }

    // ------------------------------------------------------------------ text

    private void text(String s, double x, double y) {
        if (s == null || s.isEmpty()) return;
        fillStyle();
        if (!Objects.equals(font, r.font)) {
            r.font = font;
            StringBuilder b = op("F");
            b.append(',');
            str(b, font.getFamily());
            b.append(',').append(font.getStyle());
            nums(b, font.getSize2D());
            end(b);
        }
        double[] at = points(x, y);
        StringBuilder b = draw("T");
        b.append(',');
        str(b, s);
        nums(b, at);
        if (!translateOnly()) list(b, new double[] {tx.getScaleX(), tx.getShearY(), tx.getShearX(), tx.getScaleY()});
        end(b);
        Rectangle2D logical = font.getStringBounds(s, getFontRenderContext());
        logical.setRect(logical.getX() + x, logical.getY() + y, logical.getWidth(), logical.getHeight());
        r.ink(tx.createTransformedShape(logical).getBounds2D(), 2);
    }

    @Override public void drawString(String s, int x, int y) { text(s, x, y); }
    @Override public void drawString(String s, float x, float y) { text(s, x, y); }
    private static String chars(AttributedCharacterIterator it) {
        StringBuilder b = new StringBuilder();
        for (char ch = it.first(); ch != AttributedCharacterIterator.DONE; ch = it.next()) b.append(ch);
        return b.toString();
    }
    @Override public void drawString(AttributedCharacterIterator it, int x, int y) { text(chars(it), x, y); }
    @Override public void drawString(AttributedCharacterIterator it, float x, float y) { text(chars(it), x, y); }
    @Override public void drawChars(char[] data, int off, int len, int x, int y) { text(new String(data, off, len), x, y); }
    @SuppressWarnings("deprecation")
    @Override public void drawBytes(byte[] data, int off, int len, int x, int y) { text(new String(data, 0, off, len), x, y); }
    @Override public void drawGlyphVector(GlyphVector g, float x, float y) { shape(g.getOutline(x, y), true); }

    // ------------------------------------------------------------------ images

    private static String dataUrl(Image image) throws Exception {
        String known = IMAGES.get(image);
        if (known != null) return known;
        int w = image.getWidth(null), h = image.getHeight(null);
        if (w <= 0 || h <= 0) return null;
        BufferedImage bitmap = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = bitmap.createGraphics();
        g.drawImage(image, 0, 0, null);
        g.dispose();
        String url = "data:image/png;base64," + Base64.getEncoder().encodeToString(PngEncoder.encode(bitmap));
        IMAGES.put(image, url);
        return url;
    }

    private boolean image(Image image, AffineTransform place) {
        if (image == null) return true;
        String url;
        try { url = dataUrl(image); } catch (Exception e) { return true; }
        if (url == null) return true;
        fillStyle();
        AffineTransform t = new AffineTransform(tx);
        t.concatenate(place);
        double[] m = new double[6];
        t.getMatrix(m);
        StringBuilder b = draw("I");
        b.append(',');
        str(b, url);
        list(b, m);
        end(b);
        r.ink(t.createTransformedShape(new Rectangle(0, 0, image.getWidth(null), image.getHeight(null))).getBounds2D(), 1);
        return true;
    }

    private static AffineTransform fit(Image image, int x, int y, int w, int h) {
        AffineTransform t = AffineTransform.getTranslateInstance(x, y);
        int iw = image.getWidth(null), ih = image.getHeight(null);
        if (iw > 0 && ih > 0) t.scale((double) w / iw, (double) h / ih);
        return t;
    }

    @Override public boolean drawImage(Image image, AffineTransform t, ImageObserver o) {
        return image(image, t == null ? new AffineTransform() : t);
    }
    @Override public void drawImage(BufferedImage image, BufferedImageOp op, int x, int y) {
        image(op == null ? image : op.filter(image, null), AffineTransform.getTranslateInstance(x, y));
    }
    @Override public void drawRenderedImage(RenderedImage image, AffineTransform t) { }
    @Override public void drawRenderableImage(RenderableImage image, AffineTransform t) { }
    @Override public boolean drawImage(Image image, int x, int y, ImageObserver o) {
        return image(image, AffineTransform.getTranslateInstance(x, y));
    }
    @Override public boolean drawImage(Image image, int x, int y, int w, int h, ImageObserver o) {
        return image == null || image(image, fit(image, x, y, w, h));
    }
    @Override public boolean drawImage(Image image, int x, int y, Color bg, ImageObserver o) {
        return image(image, AffineTransform.getTranslateInstance(x, y));
    }
    @Override public boolean drawImage(Image image, int x, int y, int w, int h, Color bg, ImageObserver o) {
        return image == null || image(image, fit(image, x, y, w, h));
    }
    @Override public boolean drawImage(Image image, int dx1, int dy1, int dx2, int dy2, int sx1, int sy1, int sx2, int sy2, ImageObserver o) {
        return image == null || image(image, fit(image, dx1, dy1, dx2 - dx1, dy2 - dy1));
    }
    @Override public boolean drawImage(Image image, int dx1, int dy1, int dx2, int dy2, int sx1, int sy1, int sx2, int sy2, Color bg, ImageObserver o) {
        return image == null || image(image, fit(image, dx1, dy1, dx2 - dx1, dy2 - dy1));
    }

    @Override public void dispose() { }
}
