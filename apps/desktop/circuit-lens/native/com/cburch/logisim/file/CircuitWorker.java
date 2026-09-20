package com.cburch.logisim.file;

import com.cburch.logisim.circuit.ExactRuntimeObserver;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import javax.xml.parsers.*;
import javax.xml.transform.*;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.stream.StreamResult;
import org.w3c.dom.*;

/** Read-only, bounded native workspace. Requests never mutate cached circuits. */
public final class CircuitWorker {
    private static final class Loaded {
        final LogisimFile file;
        final String stdout;
        final List<Object> messages = new ArrayList<>();
        Loaded(File path) throws Exception {
            Loader loader = new Loader(null) {
                @Override public void showError(String message) { throw new IllegalStateException(message); }
            };
            ByteArrayOutputStream log = new ByteArrayOutputStream();
            PrintStream previous = System.out;
            try { System.setOut(new PrintStream(log,true,"UTF-8")); file=NativeCircuitLoader.open(loader, path); }
            finally { System.setOut(previous); }
            stdout=log.toString("UTF-8");
            String message; while((message=file.getMessage())!=null)messages.add(message);
        }
    }
    private final Map<String,Loaded> files=new LinkedHashMap<String,Loaded>(4,.75f,true) {
        protected boolean removeEldestEntry(Map.Entry<String,Loaded> entry) { return size()>2; }
    };
    private static String digest(Path path) throws Exception {
        byte[] bytes=MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(path));
        StringBuilder result=new StringBuilder();for(byte b:bytes)result.append(String.format("%02x",b&255));return result.toString();
    }
    private Loaded load(String path,String expected) throws Exception {
        File source=new File(path).getCanonicalFile();
        String key=source.toString()+":"+expected;
        Loaded cached=files.get(key);
        if(cached==null) {
            if(!digest(source.toPath()).equals(expected))throw new IllegalArgumentException("电路快照已改变");
            cached=new Loaded(source);files.put(key,cached);
        }
        return cached;
    }
    private static void reply(PrintStream protocol,String status,byte[] bytes) {
        protocol.println(status+"\t"+Base64.getEncoder().encodeToString(bytes));
    }
    public static void main(String[] args) throws Exception {
        PrintStream protocol=System.out;System.setOut(System.err);
        try {
            Path runtime=Paths.get(args[0]),bundle=Paths.get(args[2]);
            if(!digest(runtime).equals(args[1]))throw new IllegalArgumentException("运行时已改变");
            CircuitWorker worker=new CircuitWorker();
            DocumentBuilderFactory factory=DocumentBuilderFactory.newInstance();
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl",true);
            factory.setFeature("http://xml.org/sax/features/external-general-entities",false);
            factory.setFeature("http://xml.org/sax/features/external-parameter-entities",false);
            reply(protocol,"ok","ready".getBytes(StandardCharsets.UTF_8));
            BufferedReader reader=new BufferedReader(new InputStreamReader(System.in,StandardCharsets.UTF_8));
            String line;
            while((line=reader.readLine())!=null) {
                try {
                    if(line.length()>2_000_000)throw new IllegalArgumentException("请求过长");
                    Element request=factory.newDocumentBuilder().parse(new ByteArrayInputStream(Base64.getDecoder().decode(line))).getDocumentElement();
                    Element operation=null;
                    for(Node n=request.getFirstChild();n!=null;n=n.getNextSibling())if(n instanceof Element){operation=(Element)n;break;}
                    if(operation==null)throw new IllegalArgumentException("缺少原生操作");
                    Loaded loaded=worker.load(request.getAttribute("artifact"),request.getAttribute("digest"));
                    String kind=operation.getTagName();byte[] response;
                    if(kind.equals("observe")) {
                        String value=ExactRuntimeObserver.observeLoaded(loaded.file,Paths.get(request.getAttribute("artifact")),
                            operation.getAttribute("circuit"),runtime,args[1],bundle,loaded.stdout,loaded.messages,
                            request.getAttribute("output"));
                        response=value.getBytes(StandardCharsets.UTF_8);
                    } else if(kind.equals("render")) {
                        com.cburch.logisim.circuit.Circuit circuit=loaded.file.getCircuit(operation.getAttribute("circuit"));
                        if(circuit==null)throw new IllegalArgumentException("Unknown circuit");
                        response=CircuitRenderer.draw(loaded.file,circuit,Integer.parseInt(operation.getAttribute("x")),
                            Integer.parseInt(operation.getAttribute("y")),Integer.parseInt(operation.getAttribute("width")),
                            Integer.parseInt(operation.getAttribute("height")),Double.parseDouble(operation.getAttribute("scale")));
                    } else {
                        Document result=factory.newDocumentBuilder().newDocument();result.appendChild(result.createElement("result"));
                        if(kind.equals("component-catalog"))CircuitPalette.catalog(loaded.file,operation,result);
                        else if(kind.equals("component-template")||kind.equals("place-component"))CircuitPalette.describe(loaded.file,operation,result);
                        else if(kind.equals("property")||kind.equals("memory"))CircuitObjects.describe(loaded.file,operation,result);
                        else if(kind.equals("interface"))CircuitInterface.describe(loaded.file,operation,result);
                        else if(kind.equals("check-interface"))CircuitInterface.check(loaded.file,
                            worker.load(request.getAttribute("output"),request.getAttribute("outputDigest")).file,operation.getAttribute("circuit"));
                        else if(kind.equals("check-placement"))CircuitPalette.checkPlacement(loaded.file,
                            worker.load(request.getAttribute("output"),request.getAttribute("outputDigest")).file,operation);
                        else if(kind.equals("check-existing-ports"))CircuitPalette.preserveExistingPorts(loaded.file,
                            worker.load(request.getAttribute("output"),request.getAttribute("outputDigest")).file,operation.getAttribute("circuit"));
                        else throw new IllegalArgumentException("不支持的只读操作");
                        ByteArrayOutputStream bytes=new ByteArrayOutputStream();
                        TransformerFactory.newInstance().newTransformer().transform(new DOMSource(result),new StreamResult(bytes));response=bytes.toByteArray();
                    }
                    reply(protocol,"ok",response);
                } catch(Exception error) { reply(protocol,"error",String.valueOf(error.getMessage()).getBytes(StandardCharsets.UTF_8)); }
            }
        } catch(Exception error) {reply(protocol,"error",String.valueOf(error.getMessage()).getBytes(StandardCharsets.UTF_8));}
        System.exit(0);
    }
}
