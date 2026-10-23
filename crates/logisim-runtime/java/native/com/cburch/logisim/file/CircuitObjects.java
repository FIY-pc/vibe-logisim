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
    private static Component selected(Circuit circuit, Element request) {
        Location location = Location.create(Integer.parseInt(request.getAttribute("x")), Integer.parseInt(request.getAttribute("y")));
        Component target = null;
        int matches = 0;
        for (Component component : circuit.getNonWires()) {
            if (!component.getLocation().equals(location)
                    || !component.getFactory().getName().equals(request.getAttribute("factory"))) continue;
            matches++;
            target = component;
        }
        // (x, y, factory) is the whole selector, so stacked exact copies are
        // unaddressable by design; the count turns the failure into the fix.
        if (matches > 1) throw new IllegalArgumentException("元件定位有歧义: " + location + " 处堆叠了 "
                + matches + " 个 " + request.getAttribute("factory") + "；请删除或移开重复元件后重试");
        if (target == null) throw new IllegalArgumentException("找不到元件: " + request.getAttribute("factory") + " " + location);
        return target;
    }

    @SuppressWarnings({"rawtypes", "unchecked"})
    static void describe(LogisimFile file, Element request, Document result) {
        Circuit circuit = file.getCircuit(request.getAttribute("circuit"));
        if (circuit == null) throw new IllegalArgumentException("Unknown circuit");
        Component target = selected(circuit, request);
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
