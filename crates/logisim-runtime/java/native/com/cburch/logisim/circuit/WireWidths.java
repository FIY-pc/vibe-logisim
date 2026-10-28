package com.cburch.logisim.circuit;

import com.cburch.logisim.data.Location;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * The points of a circuit's wire bundles whose widths do not agree. Logisim
 * draws every wire of such a bundle, and its dots, in Value.WIDTH_ERROR_COLOR
 * (CircuitWires.draw); the bundles are package-private, so this lives here.
 */
public final class WireWidths {
    private WireWidths() {}

    public static Set<Location> conflicts(Circuit circuit) {
        Set<Location> points = new LinkedHashSet<>();
        Set<WireBundle> seen = Collections.newSetFromMap(new IdentityHashMap<WireBundle, Boolean>());
        for (Wire wire : circuit.getWires()) {
            WireBundle bundle = circuit.wires.getWireBundle(wire.getEnd0());
            if (bundle == null || bundle.isValid() || !seen.add(bundle)) continue;
            for (Location point : bundle.points) points.add(point);
        }
        return points;
    }
}
