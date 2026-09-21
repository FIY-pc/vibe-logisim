package com.cburch.logisim.file;

import com.cburch.logisim.circuit.*;
import com.cburch.logisim.comp.*;
import com.cburch.logisim.data.*;
import com.cburch.logisim.instance.Instance;
import com.cburch.logisim.instance.Port;
import com.cburch.logisim.proj.Project;
import com.cburch.logisim.tools.*;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.*;
import javax.imageio.ImageIO;
import org.w3c.dom.*;

/** The running course libraries own tools, defaults, geometry and attribute parsing. */
public final class CircuitPalette {
    private static Element child(Document doc, Element parent, String tag) {
        Element e=doc.createElement(tag);parent.appendChild(e);return e;
    }
    private static List<Element> children(Element parent,String tag) {
        List<Element> result=new ArrayList<>();
        for(Node n=parent.getFirstChild();n!=null;n=n.getNextSibling())
            if(n instanceof Element&&((Element)n).getTagName().equals(tag))result.add((Element)n);
        return result;
    }
    private static Library library(LogisimFile file, Element spec) {
        String desc=spec.getAttribute("desc");
        for(Library lib:file.getLibraries()) if(desc.equals(file.getLoader().getDescriptor(lib)))return lib;
        // The source's descriptor is supplied by the host, never chosen by the renderer.
        Library lib=file.getLoader().loadLibrary(desc);
        if(lib==null)throw new IllegalArgumentException("组件库不可用: "+desc);
        return lib;
    }
    private static String png(BufferedImage bitmap) throws Exception {
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();ImageIO.write(bitmap,"png",bytes);
        return "data:image/png;base64,"+Base64.getEncoder().encodeToString(bytes.toByteArray());
    }
    private static String icon(AddTool tool, Circuit circuit, Project project) throws Exception {
        BufferedImage bitmap=new BufferedImage(48,48,BufferedImage.TYPE_INT_ARGB);
        Graphics2D g=bitmap.createGraphics();g.scale(2,2);g.setColor(Color.BLACK);
        ComponentDrawContext context=new ComponentDrawContext(null,circuit,new CircuitState(project,circuit),g,g);
        context.setShowState(false);tool.paintIcon(context,2,2);g.dispose();return png(bitmap);
    }
    private static boolean canAdd(Project project,Circuit target,ComponentFactory factory) {
        return !(factory instanceof SubcircuitFactory)||project.getDependencies().canAdd(target,((SubcircuitFactory)factory).getSubcircuit());
    }
    public static void catalog(LogisimFile file,Element request,Document result) throws Exception {
        Circuit target=file.getCircuit(request.getAttribute("circuit"));
        if(target==null)throw new IllegalArgumentException("请选择当前电路");
        Project project=new Project(file);project.getSimulator().shutDown();
        catalog(file,target,project,request,result);
    }
    private static void catalog(LogisimFile file,Circuit target,Project project,Element request,Document result) throws Exception {
        Element root=result.getDocumentElement();
        List<Element> specs=children(request,"library");
        for(int i=0;i<=specs.size();i++) {
            Element spec=i<specs.size()?specs.get(i):null;
            Library lib=spec==null?file:library(file,spec);
            String id=spec==null?"":spec.getAttribute("id");
            Element group=child(result,root,"group");group.setAttribute("id",id);
            group.setAttribute("name",spec==null?"Subcircuits":lib.getName());
            group.setAttribute("label",spec==null?"当前文件的子电路":lib.getDisplayName());
            for(Tool candidate:lib.getTools()) {
                if(!(candidate instanceof AddTool))continue;
                AddTool tool=(AddTool)candidate;
                Element entry=child(result,group,"tool");entry.setAttribute("name",tool.getName());entry.setAttribute("label",tool.getDisplayName());
                try {
                    ComponentFactory factory=tool.getFactory();
                    entry.setAttribute("factory",factory.getName());
                    if(!canAdd(project,target,factory))entry.setAttribute("disabled","会形成循环引用");
                    if(!request.getAttribute("images").equals("false"))entry.setAttribute("icon",icon(tool,target,project));
                } catch(Exception error) {entry.setAttribute("disabled","此组件暂不可用: "+error.getMessage());}
            }
        }
    }
    @SuppressWarnings({"rawtypes","unchecked"})
    private static void checkOverrides(AttributeSet attrs,Map<String,String> expected) {
        for(Map.Entry<String,String> entry:expected.entrySet()) {
            Attribute attr=attrs.getAttribute(entry.getKey());
            String actual=attr==null?null:attr.toStandardString(attrs.getValue(attr));
            if(!entry.getValue().equals(actual)) {
                String message="属性未保留请求值: "+entry.getKey()+"="+entry.getValue()
                    +"；当前配置实际保留: "+(actual==null?"属性已移除":actual);
                List<String> choices=new ArrayList<>();
                if(attr!=null)for(NativeAttributeAdapter.Choice choice:NativeAttributeAdapter.choices(attrs,attr))choices.add(choice.value);
                if(!choices.isEmpty())message+="；可选值: "+NativeAttributeAdapter.names(choices);
                throw new IllegalArgumentException(message);
            }
        }
    }
    @SuppressWarnings({"rawtypes","unchecked"})
    static Map<String,String> applyOverrides(AttributeSet attrs,Element request) {
        Map<String,String> expected=new LinkedHashMap<>(),pending=new LinkedHashMap<>();
        boolean strict=request.getAttribute("strictAttributes").equals("true");
        NodeList overrides=request.getElementsByTagName("set");
        for(int i=0;i<overrides.getLength();i++) {
            Element set=(Element)overrides.item(i);String name=set.getAttribute("name"),value=set.getAttribute("value");
            if(pending.put(name,value)!=null)throw new IllegalArgumentException("重复属性: "+name);
        }
        // Some attributes appear only after changing input count or bus width.
        // Resolve those without making JSON object key order part of the API.
        while(!pending.isEmpty()) {
            boolean progressed=false;
            for(Attribute candidate:new ArrayList<Attribute<?>>(attrs.getAttributes())) {
                String name=candidate.getName(),raw=pending.get(name);
                if(raw==null)continue;
                Attribute attr=attrs.getAttribute(name);
                if(attr==null)continue;
                // Strict model input rejects parser fallback but accepts proven
                // integer-equivalent formats. Retention checks use native values.
                expected.put(name,NativeAttributeAdapter.apply(attrs,name,raw,strict));
                pending.remove(name);progressed=true;
            }
            if(!progressed)throw new IllegalArgumentException("未知或当前配置不支持的属性: "+String.join(", ",pending.keySet())
                +"；当前可编辑属性: "+NativeAttributeAdapter.editableNames(attrs));
        }
        checkOverrides(attrs,expected);
        return expected;
    }
    /** All native save attributes, including defaults and multiline ROM contents. */
    @SuppressWarnings({"rawtypes","unchecked"})
    static void serialize(AttributeSet attrs,Element serialized) {
        Document result=serialized.getOwnerDocument();
        for(Attribute attr:attrs.getAttributes())if(attrs.isToSave(attr)) {
            String value=attr.toStandardString(attrs.getValue(attr));Element a=child(result,serialized,"a");a.setAttribute("name",attr.getName());
            if(value.contains("\n"))a.setTextContent(value);else a.setAttribute("val",value);
        }
    }
    private static AddTool tool(LogisimFile file,Element request) {
        String id=request.getAttribute("library"),name=request.getAttribute("tool");
        Library lib=file;
        if(!id.isEmpty()) {
            Element spec=null;NodeList specs=request.getElementsByTagName("library");
            for(int i=0;i<specs.getLength();i++)if(((Element)specs.item(i)).getAttribute("id").equals(id))spec=(Element)specs.item(i);
            if(spec==null) {
                List<String> ids=new ArrayList<>();
                for(int i=0;i<specs.getLength();i++)ids.add(((Element)specs.item(i)).getAttribute("id"));
                throw new IllegalArgumentException("组件库不在当前文件中: "+id+"；当前库 ID: "
                    +NativeAttributeAdapter.names(ids)+"；当前文件的子电路使用空字符串");
            }
            lib=library(file,spec);
        }
        Tool value=lib.getTool(name);
        if(!(value instanceof AddTool)) {
            List<String> names=new ArrayList<>();
            for(Tool candidate:lib.getTools())if(candidate instanceof AddTool)names.add(candidate.getName());
            throw new IllegalArgumentException("当前组件库没有这个可放置元件: "+name+"；该库元件名: "
                +NativeAttributeAdapter.names(names)+"；完整名称见元件目录");
        }
        return (AddTool)value;
    }
    @SuppressWarnings({"rawtypes","unchecked"})
    private static void attributes(AttributeSet attrs,Element root,Document doc) {
        for(Attribute attr:attrs.getAttributes()) {
            Object value=attrs.getValue(attr);Element item=child(doc,root,"attribute");
            item.setAttribute("name",attr.getName());item.setAttribute("label",attr.getDisplayName());
            item.setAttribute("value",attr.toStandardString(value));
            item.setAttribute("editable",String.valueOf(NativeAttributeAdapter.editable(attrs,attr)));
            List<NativeAttributeAdapter.Choice> choices=NativeAttributeAdapter.choices(attrs,attr);
            if(choices.size()<=128)for(NativeAttributeAdapter.Choice option:choices) {
                Element choice=child(doc,item,"option");
                choice.setAttribute("value",option.value);choice.setAttribute("label",option.label);
            }
        }
    }
    @SuppressWarnings({"rawtypes","unchecked"})
    public static void describe(LogisimFile file,Element request,Document result) throws Exception {
        Circuit circuit=file.getCircuit(request.getAttribute("circuit"));
        if(circuit==null)throw new IllegalArgumentException("请选择当前电路");
        AddTool tool=tool(file,request);Project project=new Project(file);project.getSimulator().shutDown();
        describe(circuit,project,tool,request,result.getDocumentElement());
    }
    @SuppressWarnings({"rawtypes","unchecked"})
    private static void describe(Circuit circuit,Project project,AddTool tool,Element request,Element root) throws Exception {
        Document result=root.getOwnerDocument();ComponentFactory factory=tool.getFactory();
        if(!canAdd(project,circuit,factory))throw new IllegalArgumentException("不能放入自身或引用了当前电路的子电路");
        AttributeSet attrs=(AttributeSet)tool.getAttributeSet().clone();
        Map<String,String> expected=applyOverrides(attrs,request);
        boolean placing=request.getTagName().equals("place-component");
        int x=placing?Integer.parseInt(request.getAttribute("x")):0,y=placing?Integer.parseInt(request.getAttribute("y")):0;
        com.cburch.logisim.comp.Component component=factory.createComponent(Location.create(x,y),attrs);
        attrs=component.getAttributeSet();checkOverrides(attrs,expected);
        Bounds bounds=component.getBounds();
        if(placing) {
            if(bounds.getX()<0||bounds.getY()<0)throw new IllegalArgumentException("请将整个元件放在画布的非负坐标区域");
            if(circuit.hasConflict(component))throw new IllegalArgumentException("此位置与已有元件冲突，请换一个位置");
            for(com.cburch.logisim.comp.Component c:circuit.getNonWires())
                if(c.getFactory().getName().equals(factory.getName())&&c.getLocation().equals(component.getLocation()))throw new IllegalArgumentException("此位置已有相同元件");
        }
        root.setAttribute("factory",factory.getName());
        Object facing=factory.getFeature(ComponentFactory.FACING_ATTRIBUTE_KEY,attrs);
        if(facing instanceof Attribute)root.setAttribute("facingAttribute",((Attribute)facing).getName());
        boolean snap=!Boolean.FALSE.equals(factory.getFeature(ComponentFactory.SHOULD_SNAP,attrs));root.setAttribute("snap",String.valueOf(snap));
        Element box=child(result,root,"bounds");box.setAttribute("x",String.valueOf(bounds.getX()-x));box.setAttribute("y",String.valueOf(bounds.getY()-y));box.setAttribute("width",String.valueOf(bounds.getWidth()));box.setAttribute("height",String.valueOf(bounds.getHeight()));
        Instance instance=Instance.getInstanceFor(component);
        List<Port> nativePorts=instance==null?Collections.<Port>emptyList():instance.getPorts();
        int index=0;
        for(EndData end:component.getEnds()) {
            Element port=child(result,root,"port");port.setAttribute("x",String.valueOf(end.getLocation().getX()-x));port.setAttribute("y",String.valueOf(end.getLocation().getY()-y));port.setAttribute("width",String.valueOf(end.getWidth().getWidth()));port.setAttribute("exclusive",String.valueOf(end.isExclusive()));
            port.setAttribute("index",String.valueOf(index));
            Map<String,Object> direction=new LinkedHashMap<>();
            NativePortSemantics.putDirection(direction,component,index);
            for(Map.Entry<String,Object> entry:direction.entrySet())port.setAttribute(entry.getKey(),String.valueOf(entry.getValue()));
            String role=NativePortSemantics.registerRole(component,index);
            if(role!=null)port.setAttribute("semanticRole",role);
            if(index<nativePorts.size()) {
                try {
                    String tooltip=nativePorts.get(index).getToolTip();
                    if(tooltip!=null&&!tooltip.isEmpty())port.setAttribute("runtimeTooltip",tooltip);
                } catch(Exception ignored) { /* No description is better than an invented port role. */ }
            }
            index++;
        }
        attributes(attrs,root,result);
        Element serialized=child(result,root,"comp");serialized.setAttribute("name",factory.getName());serialized.setAttribute("loc","("+x+","+y+")");
        if(!request.getAttribute("library").isEmpty())serialized.setAttribute("lib",request.getAttribute("library"));
        serialize(attrs,serialized);
        if(!placing&&!request.getAttribute("images").equals("false")) {
            Bounds ink=bounds.expand(6);int width=Math.max(1,ink.getWidth()),height=Math.max(1,ink.getHeight());
            double scale=Math.min(3,3072.0/Math.max(width,height));
            BufferedImage bitmap=new BufferedImage(Math.max(1,(int)Math.ceil(width*scale)),Math.max(1,(int)Math.ceil(height*scale)),BufferedImage.TYPE_INT_ARGB);
            Graphics2D g=bitmap.createGraphics();g.scale(scale,scale);g.translate(-ink.getX(),-ink.getY());g.setRenderingHint(RenderingHints.KEY_ANTIALIASING,RenderingHints.VALUE_ANTIALIAS_ON);
            ComponentDrawContext context=new ComponentDrawContext(null,circuit,new CircuitState(project,circuit),g,g);context.setShowState(false);
            factory.drawGhost(context,new Color(66,86,139),0,0,attrs);g.dispose();
            Element image=child(result,root,"image");image.setAttribute("x",String.valueOf(ink.getX()));image.setAttribute("y",String.valueOf(ink.getY()));image.setAttribute("width",String.valueOf(width));image.setAttribute("height",String.valueOf(height));image.setTextContent(png(bitmap));
        }
    }
    /** One atomic, read-only palette query. Library IDs come from the source file. */
    public static void templates(LogisimFile file,Element request,Document result) throws Exception {
        List<Element> components=children(request,"component");
        if(components.size()>80)throw new IllegalArgumentException("component-templates 每批最多 80 个元件");
        Circuit circuit=file.getCircuit(request.getAttribute("circuit"));
        if(circuit==null)throw new IllegalArgumentException("请选择当前电路");
        // Copy only direct source-library declarations; resolve descriptors
        // through the same library() path as the manual palette.
        Element palette=request.getOwnerDocument().createElement("component-catalog");
        palette.setAttribute("images","false");
        Set<String> libraryIds=new HashSet<>();
        for(Element spec:children(request,"library")) {
            String id=spec.getAttribute("id");
            if(id.isEmpty()||!libraryIds.add(id))throw new IllegalArgumentException("组件库 ID 为空或重复: "+id);
            palette.appendChild(spec.cloneNode(false));
        }
        Project project=new Project(file);project.getSimulator().shutDown();
        Document catalog=result.getImplementation().createDocument(null,"result",null);
        catalog(file,circuit,project,palette,catalog);
        List<Element> groups=children(catalog.getDocumentElement(),"group");
        DocumentFragment templates=result.createDocumentFragment();
        Set<String> ids=new HashSet<>();
        for(Element component:components) {
            String id=component.getAttribute("id");
            try {
                if(id.isEmpty()||!ids.add(id))throw new IllegalArgumentException("元件 id 为空或重复");
                String name=component.getAttribute("tool"),library=component.getAttribute("library");
                if(name.isEmpty())throw new IllegalArgumentException("缺少 tool 元件名称");
                if(!component.hasAttribute("library")) {
                    List<String> matches=new ArrayList<>(),available=new ArrayList<>();
                    for(Element group:groups)for(Element entry:children(group,"tool")) {
                        if(entry.hasAttribute("disabled"))continue;
                        String groupId=group.getAttribute("id");
                        available.add(entry.getAttribute("name")+" [library=\""+groupId+"\"]");
                        if(name.equals(entry.getAttribute("name")))matches.add(groupId);
                    }
                    if(matches.isEmpty())throw new IllegalArgumentException("当前目录没有这个可放置元件: "+name
                        +"；当前可选工具: "+NativeAttributeAdapter.names(available)+"；完整名称请查询 component-catalog");
                    if(matches.size()!=1) {
                        List<String> options=new ArrayList<>();
                        for(String match:matches)options.add("\""+match+"\"");
                        throw new IllegalArgumentException("元件名称有歧义: "+name+"；请显式指定 library；可选 library IDs: "+String.join(", ",options));
                    }
                    library=matches.get(0);
                }
                Element query=request.getOwnerDocument().createElement("component-template");
                // A template request cannot inherit placement, images or relaxed
                // parsing from either the batch root or an individual component.
                query.setAttribute("tool",name);query.setAttribute("library",library);
                query.setAttribute("strictAttributes","true");query.setAttribute("images","false");
                for(Element spec:children(palette,"library"))query.appendChild(spec.cloneNode(false));
                for(Element set:children(component,"set"))query.appendChild(set.cloneNode(false));
                Element template=result.createElement("template");
                template.setAttribute("id",id);
                describe(circuit,project,tool(file,query),query,template);
                templates.appendChild(template);
            } catch(Exception error) {
                throw new IllegalArgumentException("component id=\""+id+"\": "+error.getMessage(),error);
            }
        }
        result.getDocumentElement().appendChild(templates);
    }
    /** Validate the frozen placement without serializing every net/attribute or drawing it. */
    public static void checkPlacement(LogisimFile before, LogisimFile after, Element request) {
        String name=request.getAttribute("circuit");
        Circuit old=before.getCircuit(name),now=after.getCircuit(name);
        if(old==null||now==null||now.getNonWires().size()!=Integer.parseInt(request.getAttribute("count")))
            throw new IllegalArgumentException("原生运行时未完整保留这次放置，文件未改变");
        Location location=Location.create(Integer.parseInt(request.getAttribute("x")),Integer.parseInt(request.getAttribute("y")));
        com.cburch.logisim.comp.Component target=null;
        for(com.cburch.logisim.comp.Component component:now.getNonWires())
            if(component.getFactory().getName().equals(request.getAttribute("factory"))&&component.getLocation().equals(location))target=component;
        if(target==null)throw new IllegalArgumentException("原生运行时未保留新元件，文件未改变");
        AttributeSet attrs=target.getAttributeSet();
        NodeList expected=request.getElementsByTagName("attribute");
        for(int i=0;i<expected.getLength();i++) {
            Element item=(Element)expected.item(i);Attribute attr=attrs.getAttribute(item.getAttribute("name"));
            if(attr==null||!attr.toStandardString(attrs.getValue(attr)).equals(item.getAttribute("value")))
                throw new IllegalArgumentException("元件属性在重新加载后不一致，文件未改变");
        }
        Set<WidthIncompatibilityData> prior=old.getWidthIncompatibilityData(),next=now.getWidthIncompatibilityData();
        if((next==null?0:next.size())>(prior==null?0:prior.size()))
            throw new IllegalArgumentException("此位置的端口位宽与已有连线不匹配，请调整位置或位宽");
        if(target.getFactory().getName().equals("Pin"))preserveExistingPorts(before,after,name);
    }
    public static void preserveExistingPorts(LogisimFile before,LogisimFile after,String name) {
        Circuit old=before.getCircuit(name),now=after.getCircuit(name);
        if(old.getCircuitsUsingThis().isEmpty())return;
        Map<String,Location> positions=new HashMap<>();
        for(Map.Entry<Location,com.cburch.logisim.instance.Instance> p:now.getAppearance().getPortOffsets(Direction.EAST).entrySet())positions.put(p.getValue().getLocation().toString(),p.getKey());
        for(Map.Entry<Location,com.cburch.logisim.instance.Instance> p:old.getAppearance().getPortOffsets(Direction.EAST).entrySet())
            if(!p.getKey().equals(positions.get(p.getValue().getLocation().toString())))throw new IllegalArgumentException("新增引脚会移动父电路的现有接口，请先在封装与接口中固定端口位置");
    }
}
