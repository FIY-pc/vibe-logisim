package com.cburch.logisim.file;

import com.cburch.logisim.circuit.Circuit;
import com.cburch.logisim.circuit.NativeAttributeAdapter;
import com.cburch.logisim.comp.Component;
import com.cburch.logisim.data.*;
import com.cburch.logisim.std.memory.Rom;
import com.cburch.logisim.std.memory.StudioMemory;
import java.util.*;
import org.w3c.dom.*;

/** Read and validate isolated attributes; never mutate the loaded circuit. */
final class CircuitObjects {
    private static List<Element> children(Element parent, String tag) {
        List<Element> result = new ArrayList<>();
        for (Node node = parent.getFirstChild(); node != null; node = node.getNextSibling())
            if (node instanceof Element && node.getNodeName().equals(tag)) result.add((Element) node);
        return result;
    }

    private static Component selected(Circuit circuit, Element request) {
        Location location = Location.create(Integer.parseInt(request.getAttribute("x")), Integer.parseInt(request.getAttribute("y")));
        Component target = null;
        for (Component component : circuit.getNonWires()) {
            if (!component.getLocation().equals(location)
                    || !component.getFactory().getName().equals(request.getAttribute("factory"))) continue;
            if (target != null) throw new IllegalArgumentException("元件定位有歧义: " + request.getAttribute("factory") + " " + location);
            target = component;
        }
        if (target == null) throw new IllegalArgumentException("找不到元件: " + request.getAttribute("factory") + " " + location);
        return target;
    }

    /** Atomic, read-only batch: selectors bind existing objects; only attribute clones change. */
    static void editComponents(LogisimFile file, Element request, Document result) {
        Circuit circuit = file.getCircuit(request.getAttribute("circuit"));
        if (circuit == null) throw new IllegalArgumentException("找不到电路: " + request.getAttribute("circuit"));
        DocumentFragment edited = result.createDocumentFragment();
        Set<String> ids = new HashSet<>();
        Set<Component> targets = Collections.newSetFromMap(new IdentityHashMap<Component, Boolean>());
        for (Element component : children(request, "component")) {
            String id = component.getAttribute("id");
            AttributeSet attrs = null;
            try {
                if (id.isEmpty() || !ids.add(id)) throw new IllegalArgumentException("元件 id 为空或重复");
                Component target = selected(circuit, component);
                // Native clone owns mutable data such as ROM contents; never rebuild
                // from factory defaults or attach these attributes to the original.
                attrs = (AttributeSet) target.getAttributeSet().clone();
                if (!targets.add(target)) throw new IllegalArgumentException("同一元件不能重复修改");
                Element query = request.getOwnerDocument().createElement("component");
                query.setAttribute("strictAttributes", request.getAttribute("strictAttributes"));
                for (Element set : children(component, "set")) {
                    if (set.getAttribute("name").isEmpty() || !set.hasAttribute("value"))
                        throw new IllegalArgumentException("set 需要非空 name 和 value 属性");
                    query.appendChild(set.cloneNode(false));
                }
                CircuitPalette.applyOverrides(attrs, query);
                Element item = result.createElement("component");
                item.setAttribute("id", id);
                Element before = result.createElement("before");
                CircuitPalette.serialize(target.getAttributeSet(), before);
                item.appendChild(before);
                CircuitPalette.serialize(attrs, item);
                edited.appendChild(item);
            } catch (RuntimeException error) {
                String message = String.valueOf(error.getMessage());
                if (attrs != null && !message.contains("当前可编辑属性:"))
                    message += "；当前可编辑属性: " + NativeAttributeAdapter.editableNames(attrs);
                throw new IllegalArgumentException("component id=\"" + id + "\": " + message, error);
            }
        }
        result.getDocumentElement().appendChild(edited);
    }

    @SuppressWarnings({"rawtypes", "unchecked"})
    static void describe(LogisimFile file, Element request, Document result) {
        Circuit circuit = file.getCircuit(request.getAttribute("circuit"));
        if (circuit == null) throw new IllegalArgumentException("Unknown circuit");
        Component target = null;
        Location loc = Location.create(Integer.parseInt(request.getAttribute("x")), Integer.parseInt(request.getAttribute("y")));
        for (Component c : circuit.getNonWires()) if (c.getLocation().equals(loc) && c.getFactory().getName().equals(request.getAttribute("factory"))) {
            if (target != null) throw new IllegalArgumentException("Ambiguous component");
            target = c;
        }
        if (target == null) throw new IllegalArgumentException("Missing component");
        if (request.getTagName().equals("memory")) {
            result.getDocumentElement().appendChild(StudioMemory.page(target, null, request, result));
            return;
        }
        String name = request.getAttribute("attribute");
        if (name.equals("contents") && target.getFactory() instanceof Rom) {
            result.getDocumentElement().setTextContent(StudioMemory.prepareRomWrite(target, request));
            return;
        }
        AttributeSet attrs = (AttributeSet)target.getAttributeSet().clone();
        String value = NativeAttributeAdapter.apply(attrs,name,request.getAttribute("value"),false);
        result.getDocumentElement().setTextContent(value);
    }
}
