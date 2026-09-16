package com.cburch.logisim.file;

import com.cburch.logisim.circuit.*;
import com.cburch.logisim.comp.Component;
import com.cburch.logisim.data.Location;
import java.util.*;
import org.w3c.dom.*;

/** A view resolves existing substates of one root; it never creates or clones state. */
final class CircuitSessionView {
    final Circuit root;
    Circuit circuit;
    String id;
    Map<String, Component> components;
    private List<Component> path = new ArrayList<>();

    CircuitSessionView(Circuit root, Element init) {
        this.root = root; circuit = root; id = init.getAttribute("viewId");
        components = bind(circuit, init);
    }

    private static Component find(Circuit circuit, Element item) {
        Location loc = Location.create(Integer.parseInt(item.getAttribute("x")), Integer.parseInt(item.getAttribute("y")));
        Component found = null;
        for (Component c : circuit.getNonWires())
            if (c.getLocation().equals(loc) && c.getFactory().getName().equals(item.getAttribute("factory"))) {
                if (found != null) throw new IllegalArgumentException("Ambiguous component");
                found = c;
            }
        if (found == null) throw new IllegalArgumentException("Missing component");
        return found;
    }

    private static Map<String, Component> bind(Circuit circuit, Element request) {
        Map<String, Component> result = new LinkedHashMap<>();
        NodeList nodes = request.getElementsByTagName("component");
        for (int i = 0; i < nodes.getLength(); i++) {
            Element node = (Element) nodes.item(i);
            if (result.put(node.getAttribute("id"), find(circuit, node)) != null)
                throw new IllegalArgumentException("Duplicate component ID");
        }
        return result;
    }

    private static CircuitState resolve(CircuitState state, List<Component> path) {
        for (Component c : path) {
            Object data = state.getData(c);
            if (!(data instanceof CircuitState) || ((CircuitState)data).getParentState() != state)
                throw new IllegalArgumentException("Subcircuit state is not available; propagate the parent first");
            state = (CircuitState)data;
        }
        return state;
    }

    CircuitState resolve(CircuitState state) { return resolve(state, path); }
    boolean nested() { return !path.isEmpty(); }

    void navigate(Element request, CircuitState rootState) {
        Circuit target = root;
        List<Component> next = new ArrayList<>();
        NodeList nodes = request.getElementsByTagName("instance");
        if (nodes.getLength() > 64) throw new IllegalArgumentException("Instance path is too deep");
        for (int i = 0; i < nodes.getLength(); i++) {
            Component c = find(target, (Element)nodes.item(i));
            if (!(c.getFactory() instanceof SubcircuitFactory)) throw new IllegalArgumentException("Not a subcircuit");
            next.add(c); target = ((SubcircuitFactory)c.getFactory()).getSubcircuit();
        }
        Map<String, Component> mapped = bind(target, request);
        resolve(rootState, next);
        path = next; circuit = target; components = mapped; id = request.getAttribute("viewId");
    }

    void checkInput(Component component) {
        if (nested() && component.getFactory() instanceof com.cburch.logisim.std.wiring.Pin)
            throw new IllegalArgumentException("此输入由父电路驱动，请返回父图修改信号");
    }
}
