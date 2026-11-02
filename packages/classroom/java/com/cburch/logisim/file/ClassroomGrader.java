package com.cburch.logisim.file;

import java.io.*;
import java.util.*;
import javax.xml.XMLConstants;
import javax.xml.parsers.*;
import org.w3c.dom.*;
import com.cburch.logisim.data.Value;

/** One bounded, combinational grading job. No external libraries or file-backed devices. */
public final class ClassroomGrader {
    private static final Set<String> LIBRARIES = new HashSet<>(Arrays.asList("#Wiring", "#Gates", "#Plexers", "#Arithmetic", "#Memory", "#I/O", "#Base"));
    private static final Map<String, Set<String>> FACTORIES = new HashMap<>();
    // The native appearance reader accepts only these local drawing primitives.
    private static final Set<String> APPEARANCE_SHAPES = set(
        "rect", "ellipse", "line", "path", "polyline", "polygon", "text",
        "circ-anchor", "circ-origin", "circ-port");
    static {
        FACTORIES.put("#Base", set("Text"));
        FACTORIES.put("#Wiring", set("Pin", "Splitter", "Tunnel", "Constant", "Bit Extender", "Pull Resistor"));
        FACTORIES.put("#Gates", set("NOT Gate", "Buffer", "AND Gate", "OR Gate", "NAND Gate", "NOR Gate", "XOR Gate", "XNOR Gate", "Odd Parity", "Even Parity", "Controlled Buffer", "Controlled Inverter"));
        FACTORIES.put("#Plexers", set("Multiplexer", "Demultiplexer", "Decoder", "Priority Encoder", "Bit Selector"));
        FACTORIES.put("#Arithmetic", set("Adder", "Subtractor", "Multiplier", "Divider", "Negator", "Comparator", "Shifter", "Bit Adder", "Bit Finder"));
    }
    private static Set<String> set(String... names) { return new HashSet<>(Arrays.asList(names)); }
    private static Document parse(byte[] bytes) throws Exception {
        DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
        f.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        f.setFeature("http://xml.org/sax/features/external-general-entities", false);
        f.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        f.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
        f.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, ""); f.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
        f.setExpandEntityReferences(false); f.setXIncludeAware(false);
        return f.newDocumentBuilder().parse(new ByteArrayInputStream(bytes));
    }
    private static void reject(boolean condition) { if (condition) throw new IllegalArgumentException("unsupported circuit"); }
    private static void validate(Document doc) {
        reject(!doc.getDocumentElement().getTagName().equals("project"));
        NodeList nodes = doc.getElementsByTagName("*"); reject(nodes.getLength() > 30000);
        Set<String> allowed = set("project", "lib", "main", "options", "mappings", "toolbar", "circuit", "a", "comp", "wire", "tool", "mapping", "appear");
        Map<String,String> libs = new HashMap<>(); Set<String> definitions = new HashSet<>();
        NodeList circuits = doc.getElementsByTagName("circuit"); reject(circuits.getLength() > 32);
        for (int i=0;i<circuits.getLength();i++) reject(!definitions.add(((Element)circuits.item(i)).getAttribute("name")));
        for (int i=0;i<nodes.getLength();i++) {
            Element e=(Element)nodes.item(i); String tag=e.getTagName();
            if (APPEARANCE_SHAPES.contains(tag)) {
                reject(!(e.getParentNode() instanceof Element) || !((Element)e.getParentNode()).getTagName().equals("appear"));
            } else reject(!allowed.contains(tag));
            if (tag.equals("appear"))
                reject(!(e.getParentNode() instanceof Element) || !((Element)e.getParentNode()).getTagName().equals("circuit"));
            int depth=0;for(Node p=e;p!=null;p=p.getParentNode())depth++;reject(depth>32);
            if(e.getTagName().equals("lib")) {
                String desc=e.getAttribute("desc");reject(!LIBRARIES.contains(desc));
                reject(libs.put(e.getAttribute("name"),desc)!=null);
            }
        }
        Map<String,Set<String>> dependencies=new HashMap<>();
        for(String name:definitions)dependencies.put(name,new HashSet<>());
        NodeList parts=doc.getElementsByTagName("comp");reject(parts.getLength()>2000);
        reject(doc.getElementsByTagName("wire").getLength()>10000);
        for(int i=0;i<parts.getLength();i++) {
            Element c=(Element)parts.item(i);String library=c.getAttribute("lib"),name=c.getAttribute("name");
            reject(!(c.getParentNode() instanceof Element) || !((Element)c.getParentNode()).getTagName().equals("circuit"));
            if(library.isEmpty()) {
                reject(!definitions.contains(name));
                dependencies.get(((Element)c.getParentNode()).getAttribute("name")).add(name);
            } else reject(!FACTORIES.getOrDefault(libs.get(library),Collections.emptySet()).contains(name));
            String[] xy=c.getAttribute("loc").replace("(","").replace(")","").split(",");reject(xy.length!=2);
            for(String v:xy)reject(Math.abs(Long.parseLong(v.trim()))>1000000);
        }
        for(int i=0;i<nodes.getLength();i++) {
            Element e=(Element)nodes.item(i);NamedNodeMap attrs=e.getAttributes();
            for(int j=0;j<attrs.getLength();j++)reject(attrs.item(j).getNodeValue().length()>4096);
            if(e.getTagName().equals("a") && set("width","inputs","fanout","select").contains(e.getAttribute("name"))) {
                int value=Integer.parseInt(e.getAttribute("val"));reject(value<0 || value>(e.getAttribute("name").equals("select")?8:32));
            }
        }
        for(String name:definitions)visit(name,dependencies,new HashSet<>(),new HashSet<>());
    }
    private static void visit(String name,Map<String,Set<String>> graph,Set<String> active,Set<String> done) {
        if(done.contains(name))return;reject(!active.add(name));
        for(String next:graph.get(name))visit(next,graph,active,done);
        active.remove(name);done.add(name);
    }
    private static String quote(String value) {
        StringBuilder out=new StringBuilder("\"");
        for(char c:value.toCharArray()) { if(c=='"'||c=='\\')out.append('\\').append(c);else if(c<32)out.append(String.format("\\u%04x",(int)c));else out.append(c); }
        return out.append('"').toString();
    }
    public static void main(String[] args) {
        PrintStream protocol=System.out;System.setOut(System.err);System.setProperty("java.awt.headless","true");
        try {
            byte[] raw=System.in.readNBytes(12000001);reject(raw.length>12000000);
            String[] pieces=new String(raw,"UTF-8").trim().split("\\t",-1);reject(pieces.length!=2);
            byte[] circuit=Base64.getDecoder().decode(pieces[1]);reject(circuit.length>4000000);
            validate(parse(circuit));
            Document request=parse(Base64.getDecoder().decode(pieces[0]));
            reject(request.getElementsByTagName("vector").getLength()<1||request.getElementsByTagName("vector").getLength()>256);
            List<String> messages=new ArrayList<>();
            LogisimFile file=NativeCircuitLoader.openChecked(circuit,"submission.circ",null,messages);
            Document result=DocumentBuilderFactory.newInstance().newDocumentBuilder().newDocument();result.appendChild(result.createElement("result"));
            CircuitWorkbench.simulate(file,request.getDocumentElement(),result);
            StringBuilder json=new StringBuilder("{\"rows\":[");NodeList rows=result.getElementsByTagName("vector");
            for(int i=0;i<rows.getLength();i++) {
                if(i>0)json.append(',');Element row=(Element)rows.item(i);
                json.append("{\"oscillating\":").append(row.getAttribute("oscillating")).append(",\"outputs\":{");
                NodeList outputs=row.getElementsByTagName("output");
                for(int j=0;j<outputs.getLength();j++) {
                    if(j>0)json.append(',');Element o=(Element)outputs.item(j);
                    json.append(quote(o.getAttribute("name"))).append(":{\"bits\":").append(quote(o.getAttribute("bits")));
                    if(o.hasAttribute("value"))json.append(",\"value\":").append(o.getAttribute("value"));json.append('}');
                }
                json.append("}}");
            }
            protocol.println(json.append("]}"));protocol.flush();System.exit(0);
        } catch(Throwable error) { protocol.println("{\"error\":\"invalid_circuit\"}");protocol.flush();System.exit(2); }
    }
}
