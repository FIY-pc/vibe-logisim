package com.cburch.logisim.file;

import com.cburch.logisim.circuit.Circuit;
import com.cburch.logisim.circuit.CircuitConnections;
import com.cburch.logisim.circuit.CircuitMoves;
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
 * The resident runtime: answers read requests on documents the host sends.
 * Each request line is base64 of {@code <request document revision>} and,
 * when the request carries one, a tab and base64 of a text. The request names
 * the revision it reads; it brings that revision with a {@code <load>} (the
 * text is the whole file) or a {@code <change base>} from the revision the
 * worker holds (the text is the added elements; LoadedProject). The worker
 * keeps the latest three documents loaded. Reply lines are a status, a tab,
 * base64 of the payload, and the request's timing phases: "ok", "error"
 * (the payload is the message) or "reload" (the worker does not hold the
 * base or cannot apply the change in place: send the revision whole).
 */
public final class CircuitWorker {
    private final Map<String,LoadedProject> documents=new LinkedHashMap<String,LoadedProject>(4,.75f,true) {
        protected boolean removeEldestEntry(Map.Entry<String,LoadedProject> entry) { return size()>3; }
    };
    private static String digest(byte[] bytes) throws Exception {
        StringBuilder result=new StringBuilder();
        for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))result.append(String.format("%02x",b&255));
        return result.toString();
    }
    private static Element child(Element parent,String tag) {
        for(Node n=parent.getFirstChild();n!=null;n=n.getNextSibling())
            if(n instanceof Element&&((Element)n).getTagName().equals(tag))return (Element)n;
        return null;
    }
    /** The project at the request's revision, or null when the host has to send it whole. */
    private LoadedProject project(Element request,byte[] text) throws Exception {
        String document=request.getAttribute("document"),revision=request.getAttribute("revision");
        Element load=child(request,"load"),change=child(request,"change");
        if(load!=null) {
            documents.remove(document);
            LoadedProject loaded=new LoadedProject(document,revision,load,text);
            WorkerTiming.mark("load");
            documents.put(document,loaded);
            return loaded;
        }
        LoadedProject held=documents.get(document);
        if(change!=null) {
            if(held==null||!held.revision.equals(change.getAttribute("base")))return null;
            try {
                if(held.advance(revision,change,text)) {
                    WorkerTiming.mark("patch");
                    return held;
                }
            } catch(Exception failed) {
                System.err.println("in-place update failed: "+failed);
            }
            documents.remove(document);
            return null;
        }
        return held!=null&&held.revision.equals(revision)?held:null;
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
            Path runtime=Paths.get(args[0]);
            if(!digest(Files.readAllBytes(runtime)).equals(args[1]))throw new IllegalArgumentException("运行时已改变");
            ExactRuntimeObserver.useRuntime(args[1]);
            CircuitWorker worker=new CircuitWorker();
            DocumentBuilderFactory factory=DocumentBuilderFactory.newInstance();
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl",true);
            factory.setFeature("http://xml.org/sax/features/external-general-entities",false);
            factory.setFeature("http://xml.org/sax/features/external-parameter-entities",false);
            TransformerFactory transformers=TransformerFactory.newInstance();
            reply(protocol,"ok",("ready "+com.cburch.logisim.Main.VERSION).getBytes(StandardCharsets.UTF_8));
            BufferedReader reader=new BufferedReader(new InputStreamReader(System.in,StandardCharsets.UTF_8));
            String line;
            while((line=reader.readLine())!=null) {
                try {
                    WorkerTiming.begin();
                    if(line.length()>200_000_000)throw new IllegalArgumentException("请求过长");
                    int tab=line.indexOf('\t');
                    Element request=factory.newDocumentBuilder().parse(new ByteArrayInputStream(Base64.getDecoder()
                        .decode(tab<0?line:line.substring(0,tab)))).getDocumentElement();
                    byte[] text=tab<0?new byte[0]:Base64.getDecoder().decode(line.substring(tab+1));
                    WorkerTiming.mark("request");
                    Element operation=null;
                    for(Node n=request.getFirstChild();n!=null;n=n.getNextSibling())
                        if(n instanceof Element&&!((Element)n).getTagName().equals("load")&&!((Element)n).getTagName().equals("change")){operation=(Element)n;break;}
                    if(operation==null)throw new IllegalArgumentException("缺少原生操作");
                    LoadedProject loaded=worker.project(request,text);
                    if(loaded==null){reply(protocol,"reload",new byte[0]);continue;}
                    String kind=operation.getTagName();byte[] response;
                    if(kind.equals("observe")) {
                        String circuit=operation.getAttribute("circuit");
                        response=loaded.results.get(circuit);
                        if(response==null)response=loaded.remember(circuit,ExactRuntimeObserver.observeLoaded(loaded.file,
                            loaded.project(),loaded.ids,loaded.document,loaded.revision,circuit,runtime,args[1],
                            loaded.stdout,loaded.messages).getBytes(StandardCharsets.UTF_8));
                        WorkerTiming.mark(kind);
                    } else if(kind.equals("connections")) {
                        String circuit=operation.getAttribute("circuit");
                        CircuitConnections index=loaded.connections.get(circuit);
                        if(index==null) {
                            index=CircuitConnections.of(loaded.file,loaded.ids,circuit);
                            loaded.connections.put(circuit,index);
                            WorkerTiming.mark("connections.index");
                        }
                        response=index.answer(operation);
                        WorkerTiming.mark("connections");
                    } else if(kind.equals("move")) {
                        Circuit circuit=loaded.file.getCircuit(operation.getAttribute("circuit"));
                        if(circuit==null)throw new IllegalArgumentException("找不到电路");
                        CircuitMoves.Moved moved=CircuitMoves.move(circuit,loaded.ids.sheet(circuit),operation,loaded.moves);
                        if(moved.disturbed)loaded.changed();
                        response=moved.reply;
                        WorkerTiming.mark("move");
                    } else if(kind.equals("width-errors")) {
                        response=CircuitSymbols.widthErrors(loaded.file,operation);
                        WorkerTiming.mark("width-errors");
                    } else if(kind.equals("symbols")) {
                        response=CircuitSymbols.describe(loaded.file,loaded.project(),loaded.ids,operation);
                        WorkerTiming.mark("symbols");
                    } else if(kind.equals("render")) {
                        Circuit circuit=loaded.file.getCircuit(operation.getAttribute("circuit"));
                        if(circuit==null)throw new IllegalArgumentException("Unknown circuit");
                        response=CircuitRenderer.draw(loaded.project(),circuit,Integer.parseInt(operation.getAttribute("x")),
                            Integer.parseInt(operation.getAttribute("y")),Integer.parseInt(operation.getAttribute("width")),
                            Integer.parseInt(operation.getAttribute("height")),Double.parseDouble(operation.getAttribute("scale")));
                        WorkerTiming.mark("render");
                    } else {
                        Document result=factory.newDocumentBuilder().newDocument();result.appendChild(result.createElement("result"));
                        if(kind.equals("component-catalog"))CircuitPalette.catalog(loaded.file,loaded.project(),operation,result);
                        else if(kind.equals("component-template")||kind.equals("place-component"))CircuitPalette.describe(loaded.file,loaded.project(),operation,result);
                        else if(kind.equals("component-attributes"))CircuitPalette.describeComponent(loaded.file,loaded.ids,operation,result);
                        else if(kind.equals("property")||kind.equals("memory"))CircuitObjects.describe(loaded.file,loaded.ids,operation,result);
                        else if(kind.equals("interface"))CircuitInterface.describe(loaded.file,operation,result);
                        else throw new IllegalArgumentException("不支持的只读操作");
                        ByteArrayOutputStream bytes=new ByteArrayOutputStream();
                        transformers.newTransformer().transform(new DOMSource(result),new StreamResult(bytes));response=bytes.toByteArray();
                        WorkerTiming.mark(kind);
                    }
                    reply(protocol,"ok",response);
                } catch(Exception|LinkageError error) {
                    String message=error.getMessage();
                    reply(protocol,"error",(message==null||message.isEmpty()?error.toString():message).getBytes(StandardCharsets.UTF_8));
                }
            }
        } catch(Exception error) {reply(protocol,"error",String.valueOf(error.getMessage()).getBytes(StandardCharsets.UTF_8));}
        System.exit(0);
    }
}
