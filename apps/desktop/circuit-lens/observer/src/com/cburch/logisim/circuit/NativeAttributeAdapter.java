package com.cburch.logisim.circuit;

import com.cburch.logisim.data.*;
import java.awt.Color;
import java.math.BigInteger;
import java.util.*;
import javax.swing.JComboBox;

/** Native standard strings cross the host boundary; equivalent integer inputs may normalize. */
public final class NativeAttributeAdapter {
    private NativeAttributeAdapter() {}

    public static final class Choice {
        public final String value, label;
        private Choice(String value, String label) { this.value=value; this.label=label; }
    }

    public static boolean editable(AttributeSet attrs, Attribute<?> attr) {
        Object value=attrs.getValue(attr);
        return !attrs.isReadOnly(attr)&&attrs.isToSave(attr)&&(value instanceof String
            ||value instanceof Number||value instanceof Boolean||value instanceof BitWidth
            ||value instanceof Direction||value instanceof AttributeOption||value instanceof Color
            ||value instanceof com.cburch.hex.HexModel);
    }

    /** Keep native error hints useful without dumping a whole library/bus. */
    public static String names(Collection<String> values) {
        StringBuilder text=new StringBuilder();int count=0;
        for(String value:values) {
            if(count==32||text.length()+value.length()>1600)break;
            if(count>0)text.append(", ");
            text.append(value);count++;
        }
        if(count<values.size())text.append(" …（共 ").append(values.size()).append(" 项）");
        return text.toString();
    }

    public static String editableNames(AttributeSet attrs) {
        List<String> result=new ArrayList<>();
        for(Attribute<?> attr:attrs.getAttributes())if(editable(attrs,attr))result.add(attr.getName());
        return names(result);
    }

    @SuppressWarnings({"rawtypes","unchecked"})
    private static IllegalArgumentException invalidValue(AttributeSet attrs,Attribute attr,
            String message,String parsed) {
        List<String> allowed=new ArrayList<>();
        for(Choice choice:choices(attrs,attr))allowed.add(choice.value);
        if(!allowed.isEmpty())message+="；可选值: "+names(allowed);
        else if(parsed!=null)message+="；原生解析为: "+parsed+"；请确认含义后使用标准值";
        return new IllegalArgumentException(message);
    }

    @SuppressWarnings({"rawtypes","unchecked"})
    public static List<Choice> choices(AttributeSet attrs, Attribute attr) {
        Object current=attrs.getValue(attr);
        if(!(current instanceof Number||current instanceof Boolean||current instanceof AttributeOption
                ||current instanceof Direction||current instanceof BitWidth))return Collections.emptyList();
        java.awt.Component editor;
        try { editor=attr.getCellEditor(null,current); }
        catch(RuntimeException unavailable) { return Collections.emptyList(); }
        if(!(editor instanceof JComboBox))return Collections.emptyList();
        JComboBox combo=(JComboBox)editor;
        List<Choice> result=new ArrayList<>();
        for(int i=0;i<combo.getItemCount();i++) {
            Object option=combo.getItemAt(i);
            try {
                result.add(new Choice(attr.toStandardString(option),attr.toDisplayString(option)));
            } catch(ClassCastException editorValue) {
                // Native UI commits the selected item through AttributeSet.setValue.
                // For e.g. Splitter this converts its display option into an Integer.
                // Never reflect into private option fields or infer values from labels.
                AttributeSet copy=(AttributeSet)attrs.clone();
                Attribute local=copy.getAttribute(attr.getName());
                try {
                    copy.setValue(local,option);
                    local=copy.getAttribute(attr.getName());
                    Object normalized=copy.getValue(local);
                    result.add(new Choice(local.toStandardString(normalized),local.toDisplayString(normalized)));
                } catch(RuntimeException incompatible) {
                    throw new IllegalArgumentException("无法读取原生属性选项: "+attr.getName(),incompatible);
                }
            }
        }
        return result;
    }

    private static BigInteger integer(String text) {
        if(text.matches("[+-]?[0-9]+"))return new BigInteger(text,10);
        if(text.matches("[+-]?0[xX][0-9a-fA-F]+")) {
            int prefix=text.startsWith("+")||text.startsWith("-")?1:0;
            BigInteger value=new BigInteger(text.substring(prefix+2),16);
            return text.startsWith("-")?value.negate():value;
        }
        throw new NumberFormatException("Not an explicit decimal/hex integer");
    }

    private static boolean sameInteger(Object parsed,String raw,String standard) {
        if(!(parsed instanceof Number||parsed instanceof BitWidth))return false;
        // Compare unbounded integers, never truncated machine words. This only
        // validates native parsing; it does not replace the parser or setter.
        try { return integer(raw).equals(integer(standard)); }
        catch(NumberFormatException invalid) { return false; }
    }

    @SuppressWarnings({"rawtypes","unchecked"})
    public static String apply(AttributeSet attrs,String name,String raw,boolean strict) {
        Attribute attr=attrs.getAttribute(name);
        if(attr==null)throw new IllegalArgumentException("未知或当前配置不支持的属性: "+name
            +"；当前可编辑属性: "+editableNames(attrs));
        if(!editable(attrs,attr))throw new IllegalArgumentException("属性不可编辑: "+name);
        Object value;String standard;
        try { value=attr.parse(raw);standard=value==null?null:attr.toStandardString(value); }
        catch(RuntimeException invalid) { throw invalidValue(attrs,attr,"属性值无效: "+name+"="+raw,null); }
        if(value instanceof com.cburch.hex.HexModel) {
            // Memory images (ROM/RAM contents) carry their own geometry. The native
            // setter keeps a mismatched image silently, so require the header to
            // match the component's addrWidth/dataWidth, and accept any image the
            // native hex parser reads (not only a byte-identical standard string).
            com.cburch.hex.HexModel image=(com.cburch.hex.HexModel)value;
            int imageAddrBits=64-Long.numberOfLeadingZeros(image.getLastOffset()),imageDataBits=image.getValueWidth();
            Attribute<?> addr=attrs.getAttribute("addrWidth"),data=attrs.getAttribute("dataWidth");
            int addrBits=addr==null?imageAddrBits:((BitWidth)attrs.getValue(addr)).getWidth();
            int dataBits=data==null?imageDataBits:((BitWidth)attrs.getValue(data)).getWidth();
            if(imageAddrBits!=addrBits||imageDataBits!=dataBits)
                throw new IllegalArgumentException("存储内容的地址/数据位宽 ("+imageAddrBits+"/"+imageDataBits
                    +") 与元件的 addrWidth/dataWidth ("+addrBits+"/"+dataBits+") 不一致；"
                    +"内容首行应为 \"addr/data: "+addrBits+" "+dataBits+"\"，或先改元件位宽");
            try { attrs.setValue(attr,value); }
            catch(RuntimeException incompatible) { throw new IllegalArgumentException("属性值与当前配置不兼容: "+name); }
            return attr.toStandardString(attrs.getValue(attrs.getAttribute(name)));
        }
        if(standard==null||(strict&&!raw.equals(standard)&&!sameInteger(value,raw,standard)))
            throw invalidValue(attrs,attr,"属性值无效或不是原生标准格式: "+name+"="+raw,standard);
        List<Choice> choices=choices(attrs,attr);
        if(!choices.isEmpty()) {
            List<String> allowed=new ArrayList<>();
            for(Choice choice:choices)allowed.add(choice.value);
            if(!allowed.contains(standard))throw new IllegalArgumentException(
                "属性值不在原生可选范围内: "+name+"="+raw+"；可选值: "+names(allowed));
        }
        try { attrs.setValue(attr,value); }
        catch(RuntimeException incompatible) { throw new IllegalArgumentException("属性值与当前配置不兼容: "+name+"="+raw); }
        attr=attrs.getAttribute(name);
        String retained=attr==null?null:attr.toStandardString(attrs.getValue(attr));
        if(!standard.equals(retained))
            throw new IllegalArgumentException("属性未保留请求值: "+name+"="+raw
                +"；当前配置实际保留: "+(retained==null?"属性已移除":retained));
        return standard;
    }
}
