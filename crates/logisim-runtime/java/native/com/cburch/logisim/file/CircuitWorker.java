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

/**
 * The resident runtime: answers read requests on project snapshots, keyed by
 * their digest. It keeps the latest two projects loaded; a snapshot it does
 * not hold is applied in place to the closest of them when only circuit
 * contents differ (LoadedProject.advance), and loaded whole otherwise.
 */
public final class CircuitWorker {
    private final Map<String,LoadedProject> files=new LinkedHashMap<String,LoadedProject>(4,.75f,true) {
        protected boolean removeEldestEntry(Map.Entry<String,LoadedProject> entry) { return size()>2; }
    };
    private static String digest(byte[] bytes) throws Exception {
        StringBuilder result=new StringBuilder();
        for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))result.append(String.format("%02x",b&255));
        return result.toString();
    }
    private LoadedProject load(String path,String expected) throws Exception {
        LoadedProject cached=files.get(expected);
        if(cached!=null)return cached;
        File source=new File(path).getCanonicalFile();
        byte[] bytes=Files.readAllBytes(source.toPath());
        if(!digest(bytes).equals(expected))throw new IllegalArgumentException("电路快照已改变");
        WorkerTiming.mark("digest");
        LoadedProject project=advance(bytes);
        if(project!=null) {
            WorkerTiming.mark("patch");
        } else {
            project=new LoadedProject(source,bytes);
            WorkerTiming.mark("load");
        }
        files.put(expected,project);
        return project;
    }
    /** The loaded project closest to this snapshot, moved to it in place; null when none can be. */
    private LoadedProject advance(byte[] bytes) {
        FileLayout next;
        try { next=new FileLayout(bytes); } catch(RuntimeException unscannable) { return null; }
        String closest=null;int best=-1;
        for(Map.Entry<String,LoadedProject> entry:files.entrySet()) {
            int distance=entry.getValue().distance(next);
            if(distance>=0&&(best<0||distance<best)){best=distance;closest=entry.getKey();}
        }
        if(closest==null)return null;
        LoadedProject project=files.remove(closest);
        try {
            if(project.advance(next))return project;
            files.put(closest,project);
        } catch(Exception failed) {
            // Applying stopped part way; the project is dropped and the snapshot loaded whole.
            System.err.println("in-place update failed: "+failed);
        }
        return null;
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
            if(!digest(Files.readAllBytes(runtime)).equals(args[1]))throw new IllegalArgumentException("运行时已改变");
            // The bridge's classes do not change while it runs.
            String bundleDigest=ExactRuntimeObserver.bundleDigest(bundle);
            CircuitWorker worker=new CircuitWorker();
            DocumentBuilderFactory factory=DocumentBuilderFactory.newInstance();
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl",true);
            factory.setFeature("http://xml.org/sax/features/external-general-entities",false);
            factory.setFeature("http://xml.org/sax/features/external-parameter-entities",false);
            reply(protocol,"ok",("ready "+com.cburch.logisim.Main.VERSION).getBytes(StandardCharsets.UTF_8));
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
                    String artifact=request.getAttribute("artifact"),digest=request.getAttribute("digest");
                    LoadedProject loaded=worker.load(artifact,digest);
                    String kind=operation.getTagName();byte[] response;
                    if(kind.equals("observe")||kind.equals("connectivity")) {
                        String circuit=operation.getAttribute("circuit"),key=kind+"\0"+circuit;
                        response=loaded.results.get(key);
                        if(response==null)response=loaded.remember(key,(kind.equals("observe")
                            ?ExactRuntimeObserver.observeLoaded(loaded.file,loaded.project(),Paths.get(artifact),digest,
                                circuit,runtime,args[1],bundleDigest,loaded.stdout,loaded.messages)
                            :ExactRuntimeObserver.connectivityLoaded(loaded.file,circuit)).getBytes(StandardCharsets.UTF_8));
                        WorkerTiming.mark(kind);
                    } else if(kind.equals("render")) {
                        com.cburch.logisim.circuit.Circuit circuit=loaded.file.getCircuit(operation.getAttribute("circuit"));
                        if(circuit==null)throw new IllegalArgumentException("Unknown circuit");
                        response=CircuitRenderer.draw(loaded.project(),circuit,Integer.parseInt(operation.getAttribute("x")),
                            Integer.parseInt(operation.getAttribute("y")),Integer.parseInt(operation.getAttribute("width")),
                            Integer.parseInt(operation.getAttribute("height")),Double.parseDouble(operation.getAttribute("scale")));
                        WorkerTiming.mark("render");
                    } else {
                        Document result=factory.newDocumentBuilder().newDocument();result.appendChild(result.createElement("result"));
                        if(kind.equals("component-catalog"))CircuitPalette.catalog(loaded.file,loaded.project(),operation,result);
                        else if(kind.equals("component-template")||kind.equals("place-component"))CircuitPalette.describe(loaded.file,loaded.project(),operation,result);
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
