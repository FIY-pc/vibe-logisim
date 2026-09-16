package com.cburch.logisim.file;

import com.cburch.logisim.circuit.*;
import com.cburch.logisim.comp.*;
import com.cburch.logisim.data.*;
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
        Project project=new Project(file);project.getSimulator().shutDown();Element root=result.getDocumentElement();
        NodeList specs=request.getElementsByTagName("library");
        for(int i=0;i<=specs.getLength();i++) {
            Element spec=i<specs.getLength()?(Element)specs.item(i):null;
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
                    entry.setAttribute("icon",icon(tool,target,project));
                } catch(Exception error) {entry.setAttribute("disabled","此组件暂不可用: "+error.getMessage());}
            }
        }
    }
    private static AddTool tool(LogisimFile file,Element request) {
        String id=request.getAttribute("library"),name=request.getAttribute("tool");
        Library lib=file;
        if(!id.isEmpty()) {
            Element spec=null;NodeList specs=request.getElementsByTagName("library");
            for(int i=0;i<specs.getLength();i++)if(((Element)specs.item(i)).getAttribute("id").equals(id))spec=(Element)specs.item(i);
            if(spec==null)throw new IllegalArgumentException("组件库不在当前文件中");
            lib=library(file,spec);
        }
        Tool value=lib.getTool(name);
        if(!(value instanceof AddTool))throw new IllegalArgumentException("当前组件库没有这个可放置元件");
        return (AddTool)value;
    }
    private static boolean simple(Object v) {
        return v instanceof String||v instanceof Number||v instanceof Boolean||v instanceof BitWidth||v instanceof Direction||v instanceof AttributeOption||v instanceof Color;
    }
    @SuppressWarnings({"rawtypes","unchecked"})
    private static void attributes(AttributeSet attrs,Element root,Document doc) {
        for(Attribute attr:attrs.getAttributes()) {
            Object value=attrs.getValue(attr);Element item=child(doc,root,"attribute");
            item.setAttribute("name",attr.getName());item.setAttribute("label",attr.getDisplayName());
            item.setAttribute("value",attr.toStandardString(value));
            item.setAttribute("editable",String.valueOf(!attrs.isReadOnly(attr)&&attrs.isToSave(attr)&&simple(value)));
            if(value instanceof Number||value instanceof Boolean||value instanceof AttributeOption||value instanceof Direction||value instanceof BitWidth) {
                try {
                    java.awt.Component editor=attr.getCellEditor(null,value);
                    if(editor instanceof javax.swing.JComboBox) {
                        javax.swing.JComboBox combo=(javax.swing.JComboBox)editor;
                        if(combo.getItemCount()<=128)for(int i=0;i<combo.getItemCount();i++) {
                            Object option=combo.getItemAt(i);Element choice=child(doc,item,"option");
                            choice.setAttribute("value",attr.toStandardString(option));choice.setAttribute("label",attr.toDisplayString(option));
                        }
                    }
                } catch(Exception ignored) { /* A property without an enum remains a parsed text field. */ }
            }
        }
    }
    @SuppressWarnings({"rawtypes","unchecked"})
    public static void describe(LogisimFile file,Element request,Document result) throws Exception {
        Circuit circuit=file.getCircuit(request.getAttribute("circuit"));
        if(circuit==null)throw new IllegalArgumentException("请选择当前电路");
        AddTool tool=tool(file,request);ComponentFactory factory=tool.getFactory();Project project=new Project(file);project.getSimulator().shutDown();
        if(!canAdd(project,circuit,factory))throw new IllegalArgumentException("不能放入自身或引用了当前电路的子电路");
        AttributeSet attrs=(AttributeSet)tool.getAttributeSet().clone();
        NodeList overrides=request.getElementsByTagName("set");
        for(int i=0;i<overrides.getLength();i++) {
            Element set=(Element)overrides.item(i);Attribute attr=attrs.getAttribute(set.getAttribute("name"));
            if(attr==null||attrs.isReadOnly(attr)||!attrs.isToSave(attr)||!simple(attrs.getValue(attr)))throw new IllegalArgumentException("属性不可编辑: "+set.getAttribute("name"));
            Object value=attr.parse(set.getAttribute("value"));attrs.setValue(attr,value);
            if(!attr.toStandardString(value).equals(attr.toStandardString(attrs.getValue(attr))))throw new IllegalArgumentException("属性值超出范围: "+attr.getDisplayName());
        }
        boolean placing=request.getTagName().equals("place-component");
        int x=placing?Integer.parseInt(request.getAttribute("x")):0,y=placing?Integer.parseInt(request.getAttribute("y")):0;
        com.cburch.logisim.comp.Component component=factory.createComponent(Location.create(x,y),attrs);
        Bounds bounds=component.getBounds();
        if(placing) {
            if(bounds.getX()<0||bounds.getY()<0)throw new IllegalArgumentException("请将整个元件放在画布的非负坐标区域");
            if(circuit.hasConflict(component))throw new IllegalArgumentException("此位置与已有元件冲突，请换一个位置");
            for(com.cburch.logisim.comp.Component c:circuit.getNonWires())
                if(c.getFactory().getName().equals(factory.getName())&&c.getLocation().equals(component.getLocation()))throw new IllegalArgumentException("此位置已有相同元件");
        }
        Element root=result.getDocumentElement();root.setAttribute("factory",factory.getName());
        Object facing=factory.getFeature(ComponentFactory.FACING_ATTRIBUTE_KEY,attrs);
        if(facing instanceof Attribute)root.setAttribute("facingAttribute",((Attribute)facing).getName());
        boolean snap=!Boolean.FALSE.equals(factory.getFeature(ComponentFactory.SHOULD_SNAP,attrs));root.setAttribute("snap",String.valueOf(snap));
        Element box=child(result,root,"bounds");box.setAttribute("x",String.valueOf(bounds.getX()-x));box.setAttribute("y",String.valueOf(bounds.getY()-y));box.setAttribute("width",String.valueOf(bounds.getWidth()));box.setAttribute("height",String.valueOf(bounds.getHeight()));
        for(EndData end:component.getEnds()) {
            Element port=child(result,root,"port");port.setAttribute("x",String.valueOf(end.getLocation().getX()-x));port.setAttribute("y",String.valueOf(end.getLocation().getY()-y));port.setAttribute("width",String.valueOf(end.getWidth().getWidth()));port.setAttribute("exclusive",String.valueOf(end.isExclusive()));
        }
        attributes(attrs,root,result);
        Element serialized=child(result,root,"comp");serialized.setAttribute("name",factory.getName());serialized.setAttribute("loc","("+x+","+y+")");
        if(!request.getAttribute("library").isEmpty())serialized.setAttribute("lib",request.getAttribute("library"));
        for(Attribute attr:attrs.getAttributes())if(attrs.isToSave(attr)) {
            String value=attr.toStandardString(attrs.getValue(attr));Element a=child(result,serialized,"a");a.setAttribute("name",attr.getName());
            if(value.contains("\n"))a.setTextContent(value);else a.setAttribute("val",value);
        }
        if(!placing) {
            Bounds ink=bounds.expand(6);int width=Math.max(1,ink.getWidth()),height=Math.max(1,ink.getHeight());
            double scale=Math.min(3,3072.0/Math.max(width,height));
            BufferedImage bitmap=new BufferedImage(Math.max(1,(int)Math.ceil(width*scale)),Math.max(1,(int)Math.ceil(height*scale)),BufferedImage.TYPE_INT_ARGB);
            Graphics2D g=bitmap.createGraphics();g.scale(scale,scale);g.translate(-ink.getX(),-ink.getY());g.setRenderingHint(RenderingHints.KEY_ANTIALIASING,RenderingHints.VALUE_ANTIALIAS_ON);
            ComponentDrawContext context=new ComponentDrawContext(null,circuit,new CircuitState(project,circuit),g,g);context.setShowState(false);
            factory.drawGhost(context,new Color(66,86,139),0,0,attrs);g.dispose();
            Element image=child(result,root,"image");image.setAttribute("x",String.valueOf(ink.getX()));image.setAttribute("y",String.valueOf(ink.getY()));image.setAttribute("width",String.valueOf(width));image.setAttribute("height",String.valueOf(height));image.setTextContent(png(bitmap));
        }
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
