package com.cburch.logisim.file;

import com.cburch.logisim.data.Location;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import javax.swing.filechooser.FileFilter;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.parsers.SAXParser;
import javax.xml.parsers.SAXParserFactory;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.xml.sax.Attributes;
import org.xml.sax.InputSource;
import org.xml.sax.SAXException;
import org.xml.sax.SAXParseException;
import org.xml.sax.helpers.DefaultHandler;

/** Read-only wire preflight before Logisim can enter WireRepair/WireIterator. */
public final class NativeCircuitLoader {
    private NativeCircuitLoader() {}

    // java.io.File before JDK 22 cannot canonicalize Windows verbatim paths.
    // External library descriptors can contain these even after argv is fixed.
    static String javaPath(String path) {
        if (File.separatorChar != '\\' || !path.startsWith("\\\\?\\")) return path;
        if (path.startsWith("\\\\?\\UNC\\")) return "\\\\" + path.substring(8);
        if (path.length() >= 7 && Character.isLetter(path.charAt(4))
                && path.charAt(5) == ':' && path.charAt(6) == '\\') return path.substring(4);
        return path;
    }

    private static Element parseProject(InputSource source) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
        factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        factory.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
        factory.setXIncludeAware(false);
        factory.setExpandEntityReferences(false);
        DocumentBuilder parser = factory.newDocumentBuilder();
        parser.setErrorHandler(new DefaultHandler() {
            @Override public void error(SAXParseException error) throws SAXParseException { throw error; }
            @Override public void fatalError(SAXParseException error) throws SAXParseException { throw error; }
        });
        return parser.parse(source).getDocumentElement();
    }

    /**
     * Streams the file once (the runtime then parses it into its own tree):
     * every wire of a circuit definition must be horizontal or vertical, and
     * memory contents must not carry both a val attribute and text.
     */
    private static void validateProject(File file) throws Exception {
        validate(new InputSource(file.toURI().toASCIIString()));
    }

    /** The same checks over a document in memory: the parts of a revision the worker applies in place. */
    static void validate(byte[] document) throws Exception {
        validate(new InputSource(new ByteArrayInputStream(document)));
    }

    /** Made once per thread: a factory is not thread-safe. */
    private static final ThreadLocal<SAXParserFactory> PARSERS = ThreadLocal.withInitial(() -> {
        try {
            SAXParserFactory factory = SAXParserFactory.newInstance();
            factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
            factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            factory.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
            factory.setXIncludeAware(false);
            return factory;
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    });

    private static void validate(InputSource source) throws Exception {
        SAXParser parser = PARSERS.get().newSAXParser();
        parser.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD, "");
        parser.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
        try {
            parser.parse(source, new Preflight());
        } catch (Rejected rejected) {
            throw new IllegalArgumentException(rejected.getMessage());
        }
    }

    /** A preflight finding; stops the parse. */
    private static final class Rejected extends SAXException {
        Rejected(String message) { super(message); }
    }

    /** The checks of validateProject over one pass of parse events. */
    private static final class Preflight extends DefaultHandler {
        private int depth;
        /** The definition being read (direct children of the project only). */
        private String circuit;
        private int wireNumber;
        /** A ROM or RAM directly in that definition, while inside it. */
        private String memory, memoryLocation;
        private int memoryDepth;
        /** Text of its contents attribute when that also has val. */
        private StringBuilder contents;
        private int contentsDepth;

        private static String value(Attributes attributes, String name) {
            String value = attributes.getValue(name);
            return value == null ? "" : value;
        }

        @Override public void startElement(String uri, String local, String name, Attributes attributes)
                throws SAXException {
            depth++;
            if (depth == 2) {
                if (name.equals("circuit")) {
                    circuit = value(attributes, "name");
                    wireNumber = 0;
                }
            } else if (depth == 3 && circuit != null) {
                if (name.equals("comp")) {
                    String factory = value(attributes, "name");
                    if (factory.equals("ROM") || factory.equals("RAM")) {
                        memory = factory;
                        memoryLocation = value(attributes, "loc");
                        memoryDepth = depth;
                    }
                } else if (name.equals("wire")) {
                    wire(value(attributes, "from"), value(attributes, "to"));
                }
            } else if (memory != null && contents == null && name.equals("a")
                    && value(attributes, "name").equals("contents") && attributes.getValue("val") != null) {
                contents = new StringBuilder();
                contentsDepth = depth;
            }
        }

        private void wire(String from, String to) throws SAXException {
            String context = "电路 \"" + circuit + "\" 的 wire #" + (++wireNumber)
                + "（from=\"" + from + "\", to=\"" + to + "\"）";
            Location start, end;
            try {
                start = Location.parse(from);
                end = Location.parse(to);
            } catch (NumberFormatException | IndexOutOfBoundsException error) {
                // Preserve native handling of missing/malformed coordinates;
                // this preflight only adds a geometric rejection boundary.
                return;
            }
            // Do not add grid, sign, direction or nonzero-length restrictions.
            if (start.getX() != end.getX() && start.getY() != end.getY()) {
                throw new Rejected(context
                    + "：导线必须水平或垂直；斜线可能使原生加载无法结束并耗尽内存。"
                    + "请按预期连接改为水平/垂直线段，并检查拐点及沿途连接。");
            }
        }

        @Override public void characters(char[] text, int start, int length) {
            if (contents != null) contents.append(text, start, length);
        }

        @Override public void endElement(String uri, String local, String name) throws SAXException {
            if (contents != null && depth == contentsDepth) {
                // Logisim memory contents are serialized as the text of the
                // contents attribute. A generated file that adds val="" while
                // retaining that text looks like XML, but the native attribute
                // parser creates no MemContents. Report the source location
                // before the runtime emits a null dereference.
                if (!contents.toString().trim().isEmpty()) {
                    throw new Rejected("电路 \"" + circuit + "\" 的 " + memory + " @ " + memoryLocation
                        + " 的 contents 同时包含 val 属性和文本；原生格式应删除 val 属性并保留文本内容。");
                }
                contents = null;
            }
            if (memory != null && depth == memoryDepth) memory = null;
            if (depth == 2) circuit = null;
            depth--;
        }

        @Override public void error(SAXParseException error) throws SAXParseException { throw error; }
        @Override public void fatalError(SAXParseException error) throws SAXParseException { throw error; }
    }

    /**
     * Loads with the stock runtime's dialog-and-continue error handling made
     * observable. Logisim reports non-fatal problems (an attribute value the
     * current runtime no longer accepts, e.g. 2.7.1 Flip-Flop trigger=high)
     * through Loader.showError and keeps loading with the default value; the
     * headless Loaders here used to turn every such report into a hard failure.
     * This entry collects the reports instead, then only accepts the loaded file
     * after verifying per circuit that every comp and wire element of the source
     * document is present, so a report can never hide a dropped component (an
     * unknown factory, a skipped library). Verified reports are appended to
     * warnings; structural loss still fails the load. Files that load without
     * reports are returned exactly as before, unverified.
     */
    public static LogisimFile openChecked(byte[] text, String name, File directory, List<String> warnings)
            throws Exception {
        CheckedLoader loader = new CheckedLoader(directory);
        LogisimFile loaded = loader.open(text, name);
        warnings.addAll(loader.reported);
        return loaded;
    }

    /**
     * The loader behind openChecked. The worker keeps it with the file it
     * loaded: applying a later revision in place goes through the same
     * library resolution, and a report during that is visible here.
     */
    static final class CheckedLoader extends Loader {
        final List<String> reported = new ArrayList<>();
        /** Where the document lives: relative library paths resolve against it. */
        private final File directory;

        CheckedLoader(File directory) {
            super(null);
            this.directory = directory;
        }

        /**
         * Loads a document from its text. `name` is its file name; the
         * project is named as a load of that file would name it.
         */
        LogisimFile open(byte[] text, String name) throws Exception {
            LogisimFile loaded;
            try {
                validate(text);
                WorkerTiming.mark("validate");
                loaded = LogisimFile.loadSub(new ByteArrayInputStream(text), this);
                WorkerTiming.mark("logisim");
            } catch (Exception error) {
                if (reported.isEmpty()) throw error;
                throw new IllegalStateException("Logisim 无法载入这个文件：" + String.join("；", reported), error);
            }
            loaded.setName(name.toLowerCase(java.util.Locale.ROOT).endsWith(".circ")
                ? name.substring(0, name.length() - 5) : name);
            if (!reported.isEmpty()) {
                String loss = coverageLoss(loaded, new InputSource(new ByteArrayInputStream(text)));
                if (loss != null) {
                    throw new IllegalStateException(
                        "Logisim 无法载入这个文件：" + String.join("；", reported) + "（" + loss + "）");
                }
                WorkerTiming.mark("coverage");
            }
            return loaded;
        }

        /** The directory of the file being read: a nested library's while it loads, the document's otherwise. */
        @Override File getCurrentDirectory() {
            File current = super.getCurrentDirectory();
            return current != null ? current : directory;
        }

        @Override public void showError(String description) { reported.add(description); }

        @Override LogisimFile loadLogisimFile(File source) throws LoadFailedException {
            int before = reported.size();
            try {
                // External .circ libraries pass through this same boundary.
                // Checking just the root can miss silently dropped gates in
                // a library whose parent instance itself remains present.
                validateProject(source);
                WorkerTiming.mark("validate");
                LogisimFile loaded = super.loadLogisimFile(source);
                WorkerTiming.mark("logisim");
                if (reported.size() > before) {
                    String loss = coverageLoss(loaded, new InputSource(source.toURI().toASCIIString()));
                    if (loss != null) throw new LoadFailedException(loss);
                    WorkerTiming.mark("coverage");
                }
                return loaded;
            } catch (LoadFailedException error) {
                throw error;
            } catch (Exception error) {
                throw new LoadFailedException(source.getName() + ": " + error.getMessage());
            }
        }

        /**
         * The stock resolver takes the library path recorded in the file
         * literally and, when it cannot be read, asks through a Swing
         * dialog — which in these windowless workers is a
         * HeadlessException with no message. 2.7.1-era files record the
         * original author's own machine path (C:\作业\…, /Users/…), so
         * only the basename can mean anything here; look for it next to
         * the file being loaded, the same rule the studio applies when it
         * accepts the project. A library that is not there either is a
         * plain load failure.
         */
        @Override File getFileFor(String name, FileFilter filter) {
            name = javaPath(name);
            String plugin = pluginAlias(name);
            if (plugin != null) name = javaPath(plugin);
            File file = new File(name);
            if (!file.isAbsolute()) {
                File directory = getCurrentDirectory();
                if (directory != null) file = new File(directory, name);
            }
            if (file.canRead()) return file;
            String base = name.replace('\\', '/');
            base = base.substring(base.lastIndexOf('/') + 1);
            File directory = getCurrentDirectory();
            if (!base.isEmpty() && directory != null) {
                File beside = new File(directory, base);
                if (beside.canRead()) return beside;
            }
            throw new LoaderException(
                "缺少组件库：" + (base.isEmpty() ? name : base) + "。需与电路文件放在同一目录。");
        }
    }

    /**
     * Logisim-ITA maps some library names through PluginLoader.check; the
     * 2.7.1-era course jars have no such package, and these sources must
     * compile against either runtime. Resolve it reflectively.
     */
    private static String pluginAlias(String name) {
        try {
            Class<?> plugin = Class.forName("com.cburch.logisim.plugin.PluginLoader");
            Object mapped = plugin.getMethod("check", String.class).invoke(null, name);
            return mapped instanceof String ? (String) mapped : null;
        } catch (ReflectiveOperationException | LinkageError error) {
            return null;
        }
    }

    /** Compares per-circuit comp/wire element counts against the loaded file. */
    private static String coverageLoss(LogisimFile loaded, InputSource source) throws Exception {
        Element project = parseProject(source);
        StringBuilder loss = new StringBuilder();
        for (Node node = project.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (!(node instanceof Element) || !node.getNodeName().equals("circuit")) continue;
            Element circuitElement = (Element) node;
            String name = circuitElement.getAttribute("name");
            int comps = 0, wires = 0;
            for (Node child = circuitElement.getFirstChild(); child != null; child = child.getNextSibling()) {
                if (!(child instanceof Element)) continue;
                if (child.getNodeName().equals("comp")) comps++;
                else if (child.getNodeName().equals("wire")) wires++;
            }
            com.cburch.logisim.circuit.Circuit circuit = loaded.getCircuit(name);
            int loadedComps = circuit == null ? -1 : circuit.getNonWires().size();
            int loadedWires = circuit == null ? -1 : circuit.getWires().size();
            if (loadedComps == comps && loadedWires == wires) continue;
            if (loss.length() > 0) loss.append("；");
            loss.append("电路 \"").append(name).append("\" 加载后覆盖不完整：comp ")
                .append(loadedComps).append("/").append(comps)
                .append("，wire ").append(loadedWires).append("/").append(wires);
        }
        return loss.length() == 0 ? null : loss.toString();
    }
}
