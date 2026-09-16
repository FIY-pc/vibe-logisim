package com.cburch.logisim.std.memory;

import com.cburch.logisim.circuit.CircuitState;
import com.cburch.logisim.comp.Component;
import com.cburch.logisim.instance.Instance;
import org.w3c.dom.*;

/** Bounded word-addressed access to the course runtime's own memory model. */
public final class StudioMemory {
    private static MemContents contents(Component c, CircuitState state) {
        if (c.getFactory() instanceof Rom) return c.getAttributeSet().getValue(Rom.CONTENTS_ATTR);
        if (c.getFactory() instanceof Ram && state != null)
            return ((Ram)c.getFactory()).getState(Instance.getInstanceFor(c), state).getContents();
        throw new IllegalArgumentException("RAM needs a running instance; only native RAM/ROM are supported");
    }
    public static Element page(Component c, CircuitState state, Element request, Document doc) {
        MemContents mem = contents(c, state);
        long offset = Long.parseLong(request.getAttribute("offset"));
        int count = Integer.parseInt(request.getAttribute("count"));
        if (offset < 0 || offset > mem.getLastOffset() || count < 1 || count > 128)
            throw new IllegalArgumentException("Memory page out of range");
        Element page = doc.createElement("memory");
        page.setAttribute("componentId", request.getAttribute("componentId"));
        page.setAttribute("offset", String.valueOf(offset));
        page.setAttribute("addressBits", String.valueOf(mem.getLogLength()));
        page.setAttribute("dataBits", String.valueOf(mem.getWidth()));
        page.setAttribute("length", String.valueOf(mem.getLastOffset() + 1));
        page.setAttribute("storage", c.getFactory() instanceof Rom ? "design" : "runtime");
        for (long address = offset; address <= mem.getLastOffset() && address < offset + count; address++) {
            Element word = doc.createElement("word");
            word.setAttribute("address", String.valueOf(address));
            word.setAttribute("value", Integer.toUnsignedString(mem.get(address)));
            page.appendChild(word);
        }
        return page;
    }
    public static void write(Component c, CircuitState state, Element request) {
        MemContents mem = contents(c, state);
        writeWord(mem, request);
        if (state != null) state.markComponentAsDirty(c);
    }
    /** Prepare design contents without modifying the cached source or simulation. */
    public static String prepareRomWrite(Component c, Element request) {
        MemContents original = contents(c, null);
        MemContents draft = original.clone();
        if (draft == original) throw new IllegalStateException("Cannot isolate ROM contents");
        writeWord(draft, request);
        return Rom.CONTENTS_ATTR.toStandardString(draft);
    }
    private static void writeWord(MemContents mem, Element request) {
        long address = Long.parseLong(request.getAttribute("address"));
        long value = Long.parseUnsignedLong(request.getAttribute("value"), 16);
        long expected = Long.parseUnsignedLong(request.getAttribute("expected"), 16);
        if (address < 0 || address > mem.getLastOffset() || value < 0 || value >= (1L << mem.getWidth()))
            throw new IllegalArgumentException("Address or value exceeds memory width");
        if (Integer.toUnsignedLong(mem.get(address)) != expected)
            throw new IllegalArgumentException("This word changed. Refresh before editing it.");
        mem.set(address, (int)value);
    }
    public static String serializeRom(Component c) {
        return Rom.CONTENTS_ATTR.toStandardString(contents(c, null));
    }
}
