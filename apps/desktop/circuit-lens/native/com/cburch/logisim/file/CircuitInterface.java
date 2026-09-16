package com.cburch.logisim.file;

import com.cburch.draw.model.CanvasObject;
import com.cburch.draw.model.AbstractCanvasObject;
import com.cburch.logisim.circuit.Circuit;
import com.cburch.logisim.circuit.SubcircuitFactory;
import com.cburch.logisim.comp.Component;
import com.cburch.logisim.data.Direction;
import com.cburch.logisim.comp.EndData;
import com.cburch.logisim.data.Location;
import com.cburch.logisim.instance.Instance;
import com.cburch.logisim.instance.StdAttr;
import com.cburch.logisim.std.wiring.Pin;
import java.util.Map;
import java.util.TreeMap;
import org.w3c.dom.Document;
import org.w3c.dom.Element;

/** Read the runtime's actual symbol and Pin-to-instance-port mapping. */
final class CircuitInterface {
    private static void location(Element out, Location p) {
        out.setAttribute("x", Integer.toString(p.getX()));
        out.setAttribute("y", Integer.toString(p.getY()));
    }
    private static String key(Location p) { return p.getX() + "," + p.getY(); }

    static Map<String, String> footprint(Circuit c) {
        Map<String, String> result = new TreeMap<>();
        for (Map.Entry<Location, Instance> p : c.getAppearance().getPortOffsets(Direction.EAST).entrySet()) {
            Instance pin = p.getValue();
            result.put(pin.getAttributeValue(StdAttr.LABEL), p.getKey().toString() + ":"
                + pin.getAttributeValue(StdAttr.WIDTH) + ":" + Pin.FACTORY.isInputPin(pin));
        }
        result.put("$bounds", c.getAppearance().getOffsetBounds().toString());
        return result;
    }
    static void check(LogisimFile before, LogisimFile after, String name) {
        Circuit a = before.getCircuit(name), b = after.getCircuit(name);
        if (a == null || b == null) throw new IllegalArgumentException("Unknown circuit");
        if (!footprint(a).equals(footprint(b)))
            throw new IllegalStateException("Reloaded candidate changes external pin mapping: " + name);
    }

    static void describe(LogisimFile file, Element request, Document result) {
        Circuit target = file.getCircuit(request.getAttribute("circuit"));
        if (target == null) throw new IllegalArgumentException("Unknown circuit");
        Element symbol = result.createElement("symbol");
        result.getDocumentElement().appendChild(symbol);
        symbol.setAttribute("default", Boolean.toString(target.getAppearance().isDefaultAppearance()));
        Element appearance = result.createElement("appear");
        symbol.appendChild(appearance);
        for (CanvasObject shape : target.getAppearance().getObjectsFromBottom())
            appearance.appendChild(((AbstractCanvasObject) shape).toSvgElement(result));
        for (Component component : target.getNonWires()) {
            if (!(component.getFactory() instanceof Pin)) continue;
            Element pin = result.createElement("pin");
            pin.setAttribute("id", key(component.getLocation()));
            pin.setAttribute("label", component.getAttributeSet().getValue(StdAttr.LABEL));
            pin.setAttribute("width", component.getAttributeSet().getValue(StdAttr.WIDTH).toString());
            pin.setAttribute("direction", Pin.FACTORY.isInputPin(Instance.getInstanceFor(component)) ? "input" : "output");
            location(pin, component.getLocation());
            symbol.appendChild(pin);
        }
        for (Circuit parent : file.getCircuits()) for (Component component : parent.getNonWires()) {
            if (!(component.getFactory() instanceof SubcircuitFactory) ||
                ((SubcircuitFactory) component.getFactory()).getSubcircuit() != target) continue;
            Element use = result.createElement("use");
            use.setAttribute("circuit", parent.getName());
            location(use, component.getLocation());
            Direction facing = component.getAttributeSet().getValue(StdAttr.FACING);
            use.setAttribute("facing", facing.toString());
            for (Map.Entry<Location, Instance> entry : target.getAppearance().getPortOffsets(facing).entrySet()) {
                Location absolute = component.getLocation().translate(entry.getKey().getX(), entry.getKey().getY());
                int index = -1;
                for (int i = 0; i < component.getEnds().size(); i++) {
                    EndData end = component.getEnd(i);
                    if (end.getLocation().equals(absolute)) {
                        if (index >= 0) throw new IllegalStateException("Ambiguous instance port");
                        index = i;
                    }
                }
                if (index < 0) throw new IllegalStateException("Missing instance port");
                Element port = result.createElement("port");
                port.setAttribute("pin", key(entry.getValue().getLocation()));
                port.setAttribute("index", Integer.toString(index));
                location(port, absolute); use.appendChild(port);
            }
            symbol.appendChild(use);
        }
    }
}
