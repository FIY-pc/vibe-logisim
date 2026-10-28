package com.cburch.logisim.file;

import com.cburch.logisim.LogisimVersion;
import com.cburch.logisim.Main;
import com.cburch.logisim.circuit.Circuit;
import com.cburch.logisim.circuit.CircuitConnections;
import com.cburch.logisim.circuit.CircuitMutator;
import com.cburch.logisim.circuit.CircuitTransaction;
import com.cburch.logisim.circuit.Wire;
import com.cburch.logisim.comp.Component;
import com.cburch.logisim.comp.ComponentFactory;
import com.cburch.logisim.data.Attribute;
import com.cburch.logisim.data.AttributeSet;
import com.cburch.logisim.data.Location;
import com.cburch.logisim.proj.Project;
import com.cburch.logisim.std.wiring.Pin;
import com.cburch.logisim.tools.AddTool;
import com.cburch.logisim.tools.Library;
import com.cburch.logisim.tools.Tool;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.OutputStream;
import java.io.PrintStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;

/**
 * A project the worker keeps loaded while its document changes, so that an
 * edit costs the circuits it touched rather than a load of the whole file.
 *
 * The first revision is loaded whole through NativeCircuitLoader. A later
 * revision whose project header and circuit list are byte-identical is
 * applied in place: in each circuit whose text changed, the components whose
 * element text disappeared are taken out, the components of new element text
 * are built by the runtime's own reader (after its own version repairs) and
 * put in, and the wires become exactly the new file's, all in one Logisim
 * transaction, which repairs wires and updates subcircuit ports the way an
 * edit inside Logisim does. The result is the file a whole load of the new
 * revision gives. Anything else (another header or circuit list, changed
 * circuit attributes or appearance, a changed pin under a drawn appearance,
 * a file that loaded with reports or predates the runtime's library repairs)
 * is loaded whole.
 */
final class LoadedProject {
    final LogisimFile file;
    final String stdout;
    final List<Object> messages = new ArrayList<>();
    private final NativeCircuitLoader.CheckedLoader loader;
    /** The library each `lib` name of the header resolved to; null when revisions are loaded whole. */
    private final Map<String, Library> libraries;
    private FileLayout layout;
    private Project project;

    /** Observations and connectivity of this revision, keyed by kind and circuit: the latest few. */
    final Map<String, byte[]> results = new LinkedHashMap<String, byte[]>(4, .75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, byte[]> entry) { return size() > 4; }
    };

    byte[] remember(String key, byte[] value) {
        if (value.length <= 16_000_000) results.put(key, value);
        return value;
    }

    /** The connection index of each circuit at this revision, built when first read. */
    final Map<String, CircuitConnections> connections = new HashMap<>();

    /** Loads a revision whole. */
    LoadedProject(File path, byte[] bytes) throws Exception {
        loader = new NativeCircuitLoader.CheckedLoader();
        // Coverage-checked load: non-fatal runtime reports (attribute values
        // this runtime defaults, e.g. 2.7.1 trigger=high) become messages in
        // the observation; a dropped comp or wire still fails the load.
        ByteArrayOutputStream log = new ByteArrayOutputStream();
        PrintStream previous = System.out;
        try {
            System.setOut(new PrintStream(log, true, "UTF-8"));
            file = loader.open(path);
        } finally {
            System.setOut(previous);
        }
        stdout = log.toString("UTF-8");
        String message;
        while ((message = file.getMessage()) != null) messages.add(message);
        for (String warning : loader.reported) messages.add("loader: " + warning);
        libraries = loader.reported.isEmpty() ? libraries(bytes) : null;
    }

    /** The project every drawing and observation of this file uses: one, so they leave no listeners behind. */
    Project project() {
        if (project == null) {
            project = new Project(file);
            project.getSimulator().shutDown();
        }
        return project;
    }

    /**
     * The header's library names mapped to what they loaded as, when this
     * file's revisions can be applied in place; otherwise null.
     */
    private Map<String, Library> libraries(byte[] bytes) {
        try {
            FileLayout scanned = new FileLayout(bytes);
            String source = scanned.attribute(scanned.top, "source");
            // Before 2.6.3 the reader also rewrites library references across the file.
            if (source != null && !source.isEmpty()
                    && LogisimVersion.parse(source).compareTo(LogisimVersion.get(2, 6, 3)) < 0) return null;
            List<Library> loaded = file.getLibraries();
            List<Circuit> circuits = file.getCircuits();
            Map<String, Library> names = new HashMap<>();
            int lib = 0, circuit = 0;
            for (FileLayout.Node node : scanned.children) {
                if (node.tag.equals("lib")) {
                    if (lib >= loaded.size()) return null;
                    names.put(scanned.attribute(node, "name"), loaded.get(lib++));
                } else if (node.tag.equals("circuit")) {
                    if (circuit >= circuits.size()
                            || !circuits.get(circuit++).getName().equals(scanned.attribute(node, "name"))) return null;
                }
            }
            if (lib != loaded.size() || circuit != circuits.size()) return null;
            layout = scanned;
            return names;
        } catch (RuntimeException error) {
            return null;
        }
    }

    /** One circuit's part of applying a revision. */
    private static final class Change {
        final Circuit circuit;
        final List<FileLayout.Node> removed = new ArrayList<>(), added = new ArrayList<>();
        final Set<Wire> wires = new HashSet<>();
        final List<Component> take = new ArrayList<>(), put = new ArrayList<>();
        final List<Wire> unwire = new ArrayList<>(), rewire = new ArrayList<>();
        boolean pins;

        Change(Circuit circuit) { this.circuit = circuit; }
    }

    /**
     * How much of another revision differs from this one: the bytes of its
     * circuits whose text changed, or -1 when it cannot be applied in place.
     */
    int distance(FileLayout next) {
        if (libraries == null || !next.sameProlog(layout) || next.children.size() != layout.children.size()) return -1;
        int changed = 0;
        for (int i = 0; i < next.children.size(); i++) {
            FileLayout.Node before = layout.children.get(i), after = next.children.get(i);
            if (!before.tag.equals(after.tag)) return -1;
            if (layout.same(before, next, after)) continue;
            if (!before.tag.equals("circuit") || !layout.sameStartTag(before, next, after)) return -1;
            changed += after.end - after.start;
        }
        return changed;
    }

    /**
     * Applies another revision of this project in place. True when this now
     * holds that revision; false when it has to be loaded whole, and this is
     * then unchanged. An exception means applying failed part way: drop this.
     */
    boolean advance(FileLayout next) throws Exception {
        if (libraries == null) return false;
        List<Change> changes;
        try {
            changes = compare(next);
            if (changes == null || !changes.isEmpty() && !build(next, changes)) return false;
        } catch (Exception error) {
            // Nothing has changed yet.
            return false;
        }
        WorkerTiming.mark("patch.plan");
        if (!changes.isEmpty()) {
            int reports = loader.reported.size();
            new Apply(changes).execute(null);
            if (loader.reported.size() != reports) throw new IllegalStateException("Logisim reported a problem");
        }
        layout = next;
        results.clear();
        connections.clear();
        return true;
    }

    /** The circuits whose text differs, with their component and wire changes; null when not applicable in place. */
    private List<Change> compare(FileLayout next) {
        if (!next.sameProlog(layout) || next.children.size() != layout.children.size()) return null;
        List<Circuit> circuits = file.getCircuits();
        List<Change> changes = new ArrayList<>();
        int index = 0;
        for (int i = 0; i < next.children.size(); i++) {
            FileLayout.Node before = layout.children.get(i), after = next.children.get(i);
            if (!before.tag.equals(after.tag)) return null;
            if (!before.tag.equals("circuit")) {
                if (!layout.same(before, next, after)) return null;
                continue;
            }
            Circuit circuit = circuits.get(index++);
            if (!layout.sameStartTag(before, next, after)) return null;
            if (layout.same(before, next, after)) continue;
            Change change = new Change(circuit);
            if (!compare(layout.children(before), next, next.children(after), change)) return null;
            changes.add(change);
        }
        return changes;
    }

    private boolean compare(List<FileLayout.Node> before, FileLayout next, List<FileLayout.Node> after, Change change) {
        List<FileLayout.Node> oldComps = new ArrayList<>(), newComps = new ArrayList<>();
        List<FileLayout.Node> oldOther = new ArrayList<>(), newOther = new ArrayList<>();
        for (FileLayout.Node node : before) {
            if (node.tag.equals("comp")) oldComps.add(node);
            else if (!node.tag.equals("wire")) oldOther.add(node);
        }
        for (FileLayout.Node node : after) {
            if (node.tag.equals("comp")) newComps.add(node);
            else if (node.tag.equals("wire")) {
                // Exactly what XmlCircuitReader.addWire gives: a wire between
                // the parsed ends; one of no length is never added.
                String from = next.attribute(node, "from"), to = next.attribute(node, "to");
                if (from == null || to == null) return false;
                Location start = Location.parse(from), end = Location.parse(to);
                // The preflight rejects a slanted wire; a whole load reports it.
                if (start.getX() != end.getX() && start.getY() != end.getY()) return false;
                if (!start.equals(end)) change.wires.add(Wire.create(start, end));
            } else newOther.add(node);
        }
        // Attributes, appearance and anything else are read once, when a circuit is created.
        if (oldOther.size() != newOther.size()) return false;
        for (int i = 0; i < oldOther.size(); i++) if (!layout.same(oldOther.get(i), next, newOther.get(i))) return false;
        // Component element texts: those only in the old file go, those only in the new one come.
        int head = 0, oldEnd = oldComps.size(), newEnd = newComps.size();
        while (head < oldEnd && head < newEnd && layout.same(oldComps.get(head), next, newComps.get(head))) head++;
        while (oldEnd > head && newEnd > head && layout.same(oldComps.get(oldEnd - 1), next, newComps.get(newEnd - 1))) {
            oldEnd--;
            newEnd--;
        }
        Map<String, List<FileLayout.Node>> gone = new HashMap<>();
        for (FileLayout.Node node : oldComps.subList(head, oldEnd))
            gone.computeIfAbsent(text(layout, node), k -> new ArrayList<>()).add(node);
        for (FileLayout.Node node : newComps.subList(head, newEnd)) {
            List<FileLayout.Node> same = gone.get(text(next, node));
            if (same != null && !same.isEmpty()) same.remove(same.size() - 1);
            else change.added.add(node);
        }
        for (List<FileLayout.Node> nodes : gone.values()) change.removed.addAll(nodes);
        return true;
    }

    private static String text(FileLayout layout, FileLayout.Node node) {
        return new String(layout.bytes, node.start, node.end - node.start, StandardCharsets.ISO_8859_1);
    }

    private static final Method REPAIRS = method("considerRepairs", Document.class, Element.class);

    private static Method method(String name, Class<?>... parameters) {
        try {
            Method method = XmlReader.class.getDeclaredMethod(name, parameters);
            method.setAccessible(true);
            return method;
        } catch (ReflectiveOperationException error) {
            throw new IllegalStateException(error);
        }
    }

    /**
     * Builds the added components and finds the removed ones. The element
     * texts of each changed circuit go through the runtime's reader as a small
     * document of the same version: one circuit with the removed elements and
     * one with the added, so its version repairs apply to them exactly as in a
     * whole load. False when something does not resolve; nothing has changed.
     */
    private boolean build(FileLayout next, List<Change> changes) throws Exception {
        ByteArrayOutputStream text = new ByteArrayOutputStream();
        text.write(next.bytes, 0, next.prolog);
        for (Change change : changes) {
            text.write("<circuit name=\"removed\">".getBytes(StandardCharsets.US_ASCII));
            for (FileLayout.Node node : change.removed) text.write(layout.bytes, node.start, node.end - node.start);
            text.write("</circuit><circuit name=\"added\">".getBytes(StandardCharsets.US_ASCII));
            for (FileLayout.Node node : change.added) text.write(next.bytes, node.start, node.end - node.start);
            text.write("</circuit>".getBytes(StandardCharsets.US_ASCII));
        }
        text.write(("</" + next.root + ">").getBytes(StandardCharsets.UTF_8));
        byte[] document = text.toByteArray();
        try {
            NativeCircuitLoader.validate(document);
        } catch (IllegalArgumentException rejected) {
            return false;
        }
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        Document parsed = factory.newDocumentBuilder().parse(new ByteArrayInputStream(document));
        Element root = parsed.getDocumentElement();
        XmlReader reader = new XmlReader(loader);
        PrintStream previous = System.out;
        try {
            // The repairs print the file's version.
            System.setOut(new PrintStream(OutputStream.nullOutputStream()));
            REPAIRS.invoke(reader, parsed, root);
        } catch (InvocationTargetException error) {
            return false;
        } finally {
            System.setOut(previous);
        }
        String source = root.getAttribute("source");
        Main.FILE_VERSION = source.isEmpty() ? Main.VERSION : LogisimVersion.parse(source);
        XmlReader.ReadContext context = reader.new ReadContext(file);
        context.libs.putAll(libraries);
        List<Element> parts = new ArrayList<>();
        for (Node node = root.getFirstChild(); node != null; node = node.getNextSibling())
            if (node instanceof Element && node.getNodeName().equals("circuit")) parts.add((Element) node);
        if (parts.size() != 2 * changes.size()) return false;
        try {
            for (int i = 0; i < changes.size(); i++) {
                Change change = changes.get(i);
                Map<Location, List<Component>> at = new HashMap<>();
                for (Component component : change.circuit.getNonWires())
                    at.computeIfAbsent(component.getLocation(), k -> new ArrayList<>()).add(component);
                Set<Component> taken = Collections.newSetFromMap(new IdentityHashMap<>());
                for (Element element : comps(parts.get(2 * i))) {
                    Component found = locate(element, context, at, taken);
                    if (found == null) return false;
                    taken.add(found);
                    change.take.add(found);
                }
                for (Element element : comps(parts.get(2 * i + 1)))
                    change.put.add(XmlCircuitReader.getComponent(element, context));
                for (Component component : change.take) change.pins |= component.getFactory() instanceof Pin;
                for (Component component : change.put) change.pins |= component.getFactory() instanceof Pin;
                // A drawn appearance places its pins from the appear element
                // as the circuit is created; a whole load redoes that.
                if (change.pins && !change.circuit.getAppearance().isDefaultAppearance()) return false;
                Set<Wire> current = new HashSet<>(change.circuit.getWires());
                for (Wire wire : current) if (!change.wires.contains(wire)) change.unwire.add(wire);
                for (Wire wire : change.wires) if (!current.contains(wire)) change.rewire.add(wire);
            }
        } catch (XmlReaderException error) {
            return false;
        }
        return true;
    }

    private static List<Element> comps(Element circuit) {
        List<Element> result = new ArrayList<>();
        for (Node node = circuit.getFirstChild(); node != null; node = node.getNextSibling())
            if (node instanceof Element && node.getNodeName().equals("comp")) result.add((Element) node);
        return result;
    }

    /** The component a removed element was loaded as: same factory and location, and the same attributes when that is not enough. */
    private static Component locate(Element element, XmlReader.ReadContext context,
            Map<Location, List<Component>> at, Set<Component> taken) throws XmlReaderException {
        Library library = context.findLibrary(element.getAttribute("lib"));
        Tool tool = library == null ? null : library.getTool(element.getAttribute("name"));
        if (!(tool instanceof AddTool)) return null;
        ComponentFactory factory = ((AddTool) tool).getFactory();
        List<Component> candidates = new ArrayList<>();
        for (Component component : at.getOrDefault(Location.parse(element.getAttribute("loc")), Collections.emptyList()))
            if (component.getFactory() == factory && !taken.contains(component)) candidates.add(component);
        if (candidates.size() <= 1) return candidates.isEmpty() ? null : candidates.get(0);
        AttributeSet expected = XmlCircuitReader.getComponent(element, context).getAttributeSet();
        for (Component candidate : candidates) if (same(candidate.getAttributeSet(), expected)) return candidate;
        return null;
    }

    @SuppressWarnings({"rawtypes", "unchecked"})
    private static boolean same(AttributeSet a, AttributeSet b) {
        List<Attribute<?>> left = a.getAttributes(), right = b.getAttributes();
        if (left.size() != right.size()) return false;
        for (int i = 0; i < left.size(); i++) {
            Attribute attribute = left.get(i);
            if (!attribute.equals(right.get(i)) || !Objects.equals(a.getValue(attribute), b.getValue(attribute))) return false;
        }
        return true;
    }

    /**
     * The changes as one Logisim transaction. A circuit whose pins change
     * also locks the circuits that use it, whose instance ports follow its
     * appearance (as CircuitMutation does for a pin edit).
     */
    private static final class Apply extends CircuitTransaction {
        private final List<Change> changes;

        Apply(List<Change> changes) { this.changes = changes; }

        @Override protected Map<Circuit, Integer> getAccessedCircuits() {
            Map<Circuit, Integer> access = new HashMap<>();
            for (Change change : changes) {
                access.put(change.circuit, READ_WRITE);
                if (change.pins) for (Circuit user : change.circuit.getCircuitsUsingThis()) access.put(user, READ_WRITE);
            }
            return access;
        }

        @Override protected void run(CircuitMutator mutator, Project project) {
            for (Change change : changes) {
                for (Component component : change.take) mutator.remove(change.circuit, component);
                for (Wire wire : change.unwire) mutator.remove(change.circuit, wire);
                for (Component component : change.put) mutator.add(change.circuit, component);
                for (Wire wire : change.rewire) mutator.add(change.circuit, wire);
            }
        }
    }
}
