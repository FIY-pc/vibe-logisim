package com.cburch.logisim.file;

import com.cburch.logisim.data.Location;
import java.io.File;
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

    /**
     * Checks every circuit definition in this XML file, then delegates unchanged.
     * The caller must keep the file stable between preflight and native loading.
     * Referenced external circuit libraries are outside this file's preflight.
     */
    public static LogisimFile open(Loader loader, File file) throws Exception {
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
        Element project = parser.parse(file).getDocumentElement();
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
