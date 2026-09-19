package com.cburch.logisim.circuit;

import com.cburch.logisim.data.*;
import java.awt.Color;
import java.util.*;
import javax.swing.JComboBox;

/** Standard strings cross the host boundary; editor choices need not be values. */
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
            ||value instanceof Direction||value instanceof AttributeOption||value instanceof Color);
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

    @SuppressWarnings({"rawtypes","unchecked"})
    public static String apply(AttributeSet attrs,String name,String raw,boolean strict) {
        Attribute attr=attrs.getAttribute(name);
        if(attr==null)throw new IllegalArgumentException("未知或当前配置不支持的属性: "+name);
        if(!editable(attrs,attr))throw new IllegalArgumentException("属性不可编辑: "+name);
        Object value;String standard;
        try { value=attr.parse(raw);standard=value==null?null:attr.toStandardString(value); }
        catch(RuntimeException invalid) { throw new IllegalArgumentException("属性值无效: "+name+"="+raw); }
        if(standard==null||(strict&&!raw.equals(standard)))
            throw new IllegalArgumentException("属性值无效或不是原生标准格式: "+name+"="+raw);
        List<Choice> choices=choices(attrs,attr);
        if(!choices.isEmpty()) {
            List<String> allowed=new ArrayList<>();
            for(Choice choice:choices)allowed.add(choice.value);
            if(!allowed.contains(standard))throw new IllegalArgumentException(
                "属性值不在原生可选范围内: "+name+"="+raw+"；可选值: "+String.join(", ",allowed));
        }
        try { attrs.setValue(attr,value); }
        catch(RuntimeException incompatible) { throw new IllegalArgumentException("属性值与当前配置不兼容: "+name+"="+raw); }
        attr=attrs.getAttribute(name);
        if(attr==null||!standard.equals(attr.toStandardString(attrs.getValue(attr))))
            throw new IllegalArgumentException("属性未保留请求值: "+name+"="+raw);
        return standard;
    }
}
