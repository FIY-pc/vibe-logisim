package com.cburch.logisim.file;

import java.util.Locale;

/**
 * Opt-in phase timings of one worker request (VIBE_WORKBENCH_TIMING in the
 * environment). Each mark records the time since the previous one, so the
 * phases of a request add up to its total. Only the request loop starts a
 * request; marks from anywhere else are ignored.
 */
public final class WorkerTiming {
    private static final boolean ENABLED = isEnabled();
    private static final StringBuilder phases = new StringBuilder();
    private static boolean active;
    private static long last;

    private WorkerTiming() {}

    private static boolean isEnabled() {
        String value = System.getenv("VIBE_WORKBENCH_TIMING");
        return value != null && !value.isEmpty() && !value.equals("0");
    }

    static void begin() {
        if (!ENABLED) return;
        phases.setLength(0);
        active = true;
        last = System.nanoTime();
    }

    public static void mark(String phase) {
        if (!active) return;
        long now = System.nanoTime();
        if (phases.length() > 0) phases.append(',');
        phases.append(phase).append('=').append(String.format(Locale.ROOT, "%.1f", (now - last) / 1e6));
        last = now;
    }

    /** The request's phases as {@code phase=ms,…}, empty when timing is off. */
    static String take() {
        active = false;
        return phases.toString();
    }
}
