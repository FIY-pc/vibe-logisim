package com.cburch.logisim.circuit;

import com.cburch.logisim.comp.Component;
import com.cburch.logisim.comp.ComponentDrawContext;
import java.util.Collections;

/**
 * Paints a circuit's wires and junctions the way its canvas does, in the
 * colors of the context's state (CircuitWires.draw): a bundle whose widths
 * disagree in Value.WIDTH_ERROR_COLOR, otherwise each wire in the color of its
 * value. CircuitWires.draw and Circuit.wires are package-private, so this
 * lives here.
 */
public final class WirePaint {
    private WirePaint() {}

    public static void draw(Circuit circuit, ComponentDrawContext context) {
        circuit.wires.draw(context, Collections.<Component>emptySet());
    }
}
