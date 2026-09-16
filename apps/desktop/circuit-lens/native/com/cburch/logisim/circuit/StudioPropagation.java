package com.cburch.logisim.circuit;

/** Access the course kernel's event step, not a clock tick or a second simulator. */
public final class StudioPropagation {
    public static void step(CircuitState state) {
        state.getPropagator().step(new PropagationPoints());
    }
    public static boolean pending(CircuitState state) {
        return state.getPropagator().isPending();
    }
}
