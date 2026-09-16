package com.cburch.logisim.file;

import com.cburch.logisim.circuit.Circuit;
import com.cburch.logisim.comp.Component;
import com.cburch.logisim.data.*;
import com.cburch.logisim.std.memory.Rom;
import com.cburch.logisim.std.memory.StudioMemory;
import org.w3c.dom.Document;
import org.w3c.dom.Element;

/** Read and validate isolated attributes; never mutate the loaded circuit. */
final class CircuitObjects {
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
        Attribute attr = attrs.getAttribute(name);
        if (attr == null || attrs.isReadOnly(attr) || !attrs.isToSave(attr)) throw new IllegalArgumentException("Read-only attribute");
        Object old = attrs.getValue(attr);
        if (!(old instanceof String || old instanceof Number || old instanceof Boolean || old instanceof BitWidth || old instanceof Direction || old instanceof AttributeOption || old instanceof java.awt.Color))
            throw new IllegalArgumentException("This property needs a specialized editor");
        Object parsed = attr.parse(request.getAttribute("value"));
        attrs.setValue(attr, parsed);
        String value = attr.toStandardString(attrs.getValue(attr));
        if (!value.equals(attr.toStandardString(parsed))) throw new IllegalArgumentException("Value was clamped by the component");
        result.getDocumentElement().setTextContent(value);
    }
}
