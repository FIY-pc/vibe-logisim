package com.cburch.logisim.file;

import com.cburch.logisim.data.Location;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import javax.swing.filechooser.FileFilter;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.xml.sax.SAXParseException;
import org.xml.sax.helpers.DefaultHandler;

/** Read-only wire preflight before Logisim can enter WireRepair/WireIterator. */
public final class NativeCircuitLoader {
    private NativeCircuitLoader() {}

    private static Element parseProject(File file) throws Exception {
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
        return parser.parse(file).getDocumentElement();
    }

    /**
     * Checks every circuit definition in this XML file, then delegates unchanged.
     * The caller must keep the file stable between preflight and native loading.
     * Referenced external circuit libraries are outside this file's preflight.
     */
    public static LogisimFile open(Loader loader, File file) throws Exception {
        Element project = parseProject(file);
        // Match native direct-child definitions, including uninstantiated children.
        for (Node node = project.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (!(node instanceof Element) || !node.getNodeName().equals("circuit")) continue;
            Element circuit = (Element) node;
            int wireNumber = 0;
            for (Node child = circuit.getFirstChild(); child != null; child = child.getNextSibling()) {
                if (child instanceof Element && child.getNodeName().equals("comp")) {
                    validateMemoryContents((Element) child, circuit.getAttribute("name"));
                }
                if (!(child instanceof Element) || !child.getNodeName().equals("wire")) continue;
                Element wire = (Element) child;
                String from = wire.getAttribute("from"), to = wire.getAttribute("to");
                String context = "电路 \"" + circuit.getAttribute("name") + "\" 的 wire #" + (++wireNumber)
                    + "（from=\"" + from + "\", to=\"" + to + "\"）";
                Location start, end;
                try {
                    start = Location.parse(from);
                    end = Location.parse(to);
                } catch (NumberFormatException | IndexOutOfBoundsException error) {
                    // Preserve native handling of missing/malformed coordinates;
                    // this preflight only adds a geometric rejection boundary.
                    continue;
                }
                // Do not add grid, sign, direction or nonzero-length restrictions.
                if (start.getX() != end.getX() && start.getY() != end.getY()) {
                    throw new IllegalArgumentException(context
                        + "：导线必须水平或垂直；斜线可能使原生加载无法结束并耗尽内存。"
                        + "请按预期连接改为水平/垂直线段，并检查拐点及沿途连接。");
                }
            }
        }
        return loader.openLogisimFile(file);
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
    public static LogisimFile openChecked(File file, List<String> warnings) throws Exception {
        List<String> reported = new ArrayList<>();
        Loader loader = new Loader(null) {
            @Override public void showError(String description) { reported.add(description); }

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
                String plugin = com.cburch.logisim.plugin.PluginLoader.check(name);
                if (plugin != null) name = plugin;
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
        };
        LogisimFile loaded;
        try {
            loaded = open(loader, file);
        } catch (Exception error) {
            if (reported.isEmpty()) throw error;
            throw new IllegalStateException("Logisim load error: " + String.join("；", reported), error);
        }
        if (!reported.isEmpty()) {
            String loss = coverageLoss(loaded, file);
            if (loss != null) {
                throw new IllegalStateException(
                    "Logisim load error: " + String.join("；", reported) + "（" + loss + "）");
            }
            warnings.addAll(reported);
        }
        return loaded;
    }

    /** Compares per-circuit comp/wire element counts against the loaded file. */
    private static String coverageLoss(LogisimFile loaded, File file) throws Exception {
        Element project = parseProject(file);
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

    /**
     * Logisim memory contents are serialized as the text of the contents
     * attribute. A generated file that adds val="" while retaining that text
     * looks like XML, but the native attribute parser creates no MemContents.
     * Report the source location before the runtime emits a null dereference.
     */
    private static void validateMemoryContents(Element component, String circuitName) {
        String factory = component.getAttribute("name");
        if (!factory.equals("ROM") && !factory.equals("RAM")) return;
        org.w3c.dom.NodeList attributes = component.getElementsByTagName("a");
        for (int index = 0; index < attributes.getLength(); index++) {
            Element attribute = (Element) attributes.item(index);
            if (!attribute.getAttribute("name").equals("contents")) continue;
            String text = attribute.getTextContent();
            if (attribute.hasAttribute("val") && text != null && !text.trim().isEmpty()) {
                throw new IllegalArgumentException(
                    "电路 \"" + circuitName + "\" 的 " + factory + " @ " + component.getAttribute("loc")
                    + " 的 contents 同时包含 val 属性和文本；原生格式应删除 val 属性并保留文本内容。"
                );
            }
        }
    }
}
