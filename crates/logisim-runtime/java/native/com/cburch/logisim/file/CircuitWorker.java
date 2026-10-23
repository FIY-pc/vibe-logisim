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
        // Static observations are immutable for this artifact/dependency set.
        // Bound retained results independently of the loaded-file cache.
        final Map<String,byte[]> observations = new LinkedHashMap<String,byte[]>(2,.75f,true) {
            protected boolean removeEldestEntry(Map.Entry<String,byte[]> entry) { return size()>2; }
        };
        Loaded(File path) throws Exception {
            // Coverage-checked load: non-fatal runtime reports (attribute values
            // this runtime defaults, e.g. 2.7.1 trigger=high) become messages in
            // the observation; a dropped comp or wire still fails the load.
            List<String> warnings = new ArrayList<>();
            ByteArrayOutputStream log = new ByteArrayOutputStream();
            PrintStream previous = System.out;
            try { System.setOut(new PrintStream(log,true,"UTF-8")); file=NativeCircuitLoader.openChecked(path, warnings); }
            finally { System.setOut(previous); }
            stdout=log.toString("UTF-8");
            String message; while((message=file.getMessage())!=null)messages.add(message);
            for(String warning:warnings)messages.add("loader: "+warning);
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
            WorkerTiming.mark("digest");
            cached=new Loaded(source);files.put(key,cached);
            WorkerTiming.mark("load");
        }
        return cached;
    }
    private static void reply(PrintStream protocol,String status,byte[] bytes) {
        String payload=Base64.getEncoder().encodeToString(bytes);
        WorkerTiming.mark("encode");
        String phases=WorkerTiming.take();
        protocol.println(status+"\t"+payload+(phases.isEmpty()?"":"\t"+phases));
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
                    WorkerTiming.begin();
                    if(line.length()>2_000_000)throw new IllegalArgumentException("请求过长");
                    Element request=factory.newDocumentBuilder().parse(new ByteArrayInputStream(Base64.getDecoder().decode(line))).getDocumentElement();
                    WorkerTiming.mark("request");
                    Element operation=null;
                    for(Node n=request.getFirstChild();n!=null;n=n.getNextSibling())if(n instanceof Element){operation=(Element)n;break;}
                    if(operation==null)throw new IllegalArgumentException("缺少原生操作");
                    Loaded loaded=worker.load(request.getAttribute("artifact"),request.getAttribute("digest"));
                    String kind=operation.getTagName();byte[] response;
                    if(kind.equals("observe")) {
                        String circuit=operation.getAttribute("circuit");
                        boolean cacheable=request.getAttribute("output").isEmpty();
                        response=cacheable?loaded.observations.get(circuit):null;
                        if(response==null) {
                            String value=ExactRuntimeObserver.observeLoaded(loaded.file,Paths.get(request.getAttribute("artifact")),
                                circuit,runtime,args[1],bundle,loaded.stdout,loaded.messages,
                                request.getAttribute("output"));
                            response=value.getBytes(StandardCharsets.UTF_8);
                            if(cacheable&&response.length<=16_000_000)loaded.observations.put(circuit,response);
                        }
                        WorkerTiming.mark("observe");
                    } else if(kind.equals("render")) {
                        com.cburch.logisim.circuit.Circuit circuit=loaded.file.getCircuit(operation.getAttribute("circuit"));
                        if(circuit==null)throw new IllegalArgumentException("Unknown circuit");
                        response=CircuitRenderer.draw(loaded.file,circuit,Integer.parseInt(operation.getAttribute("x")),
                            Integer.parseInt(operation.getAttribute("y")),Integer.parseInt(operation.getAttribute("width")),
                            Integer.parseInt(operation.getAttribute("height")),Double.parseDouble(operation.getAttribute("scale")));
                        WorkerTiming.mark("render");
                    } else {
                        Document result=factory.newDocumentBuilder().newDocument();result.appendChild(result.createElement("result"));
                        if(kind.equals("component-catalog"))CircuitPalette.catalog(loaded.file,operation,result);
                        else if(kind.equals("component-template")||kind.equals("place-component"))CircuitPalette.describe(loaded.file,operation,result);
                        else if(kind.equals("component-attributes"))CircuitPalette.describeComponent(loaded.file,operation,result);
                        else if(kind.equals("property")||kind.equals("memory"))CircuitObjects.describe(loaded.file,operation,result);
                        else if(kind.equals("interface"))CircuitInterface.describe(loaded.file,operation,result);
                        else throw new IllegalArgumentException("不支持的只读操作");
                        ByteArrayOutputStream bytes=new ByteArrayOutputStream();
                        TransformerFactory.newInstance().newTransformer().transform(new DOMSource(result),new StreamResult(bytes));response=bytes.toByteArray();
                        WorkerTiming.mark(kind);
                    }
                    reply(protocol,"ok",response);
                } catch(Exception error) { reply(protocol,"error",String.valueOf(error.getMessage()).getBytes(StandardCharsets.UTF_8)); }
            }
        } catch(Exception error) {reply(protocol,"error",String.valueOf(error.getMessage()).getBytes(StandardCharsets.UTF_8));}
        System.exit(0);
    }
}
