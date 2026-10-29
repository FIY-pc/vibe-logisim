package com.cburch.logisim.file;

import com.cburch.logisim.LogisimVersion;
import com.cburch.logisim.Main;
import com.cburch.logisim.circuit.Circuit;
import com.cburch.logisim.circuit.CircuitConnections;
import com.cburch.logisim.circuit.CircuitMutator;
import com.cburch.logisim.circuit.CircuitTransaction;
import com.cburch.logisim.circuit.DocumentIds;
import com.cburch.logisim.circuit.Wire;
import com.cburch.logisim.comp.Component;
import com.cburch.logisim.proj.Project;
import com.cburch.logisim.std.wiring.Pin;
import com.cburch.logisim.tools.Library;
import com.cburch.logisim.tools.move.MoveGesture;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.OutputStream;
import java.io.PrintStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;

/**
 * One document's revision as a loaded project, kept while the document
 * changes, so that an edit costs the circuits it touched rather than a load
 * of the whole file. Nothing is read from disk: the host sends the
 * document's text and ids.
 *
 * A {@code <load>} loads the text whole through NativeCircuitLoader, with
 * relative libraries resolved against the document's directory, and pairs
 * each circuit's components with the document's ids (DocumentIds). A
 * {@code <change>} from the revision held here names, per changed circuit,
 * the component ids that go, the ids that come with their element text (the
 * request's text: the file's prolog and one {@code <circuit>} of those
 * elements per change), and the circuit's whole wire list after the change.
 * The new components are built by the runtime's own reader after its own
 * version repairs, and everything goes in as one Logisim transaction, which
 * repairs wires and updates subcircuit ports the way an edit inside Logisim
 * does. The result is the project a whole load of the new revision gives.
 * A change that cannot be applied in place (a file that loaded with reports
 * or predates the runtime's library repairs, a changed pin under a drawn
 * appearance, an element that does not build) leaves this unchanged and the
 * host loads the revision whole.
 */
final class LoadedProject {
    final String document;
    String revision;
    final LogisimFile file;
    final String stdout;
    final List<Object> messages = new ArrayList<>();
    final DocumentIds ids = new DocumentIds();
    private final NativeCircuitLoader.CheckedLoader loader;
    /** The library each `lib` name of the header resolved to; null when every change loads whole. */
    private final Map<String, Library> libraries;
    private Project project;

    /** Observations of this revision, keyed by circuit: the latest few. */
    final Map<String, byte[]> results = new LinkedHashMap<String, byte[]>(4, .75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, byte[]> entry) { return size() > 4; }
    };

    byte[] remember(String key, byte[] value) {
        if (value.length <= 16_000_000) results.put(key, value);
        return value;
    }

    /** The connection index of each circuit at this revision, built when first read. */
    final Map<String, CircuitConnections> connections = new HashMap<>();
    /** Move gestures of this revision by circuit and selection: a drag asks again with other offsets. */
    final Map<String, MoveGesture> moves = new HashMap<>();

    /** Loads a revision whole. */
    LoadedProject(String document, String revision, Element load, byte[] text) throws Exception {
        this.document = document;
        this.revision = revision;
        String directory = load.getAttribute("directory");
        loader = new NativeCircuitLoader.CheckedLoader(directory.isEmpty() ? null : new File(directory));
        // Coverage-checked load: non-fatal runtime reports (attribute values
        // this runtime defaults, e.g. 2.7.1 trigger=high) become messages in
        // the observation; a dropped comp or wire still fails the load.
        ByteArrayOutputStream log = new ByteArrayOutputStream();
        PrintStream previous = System.out;
        try {
            System.setOut(new PrintStream(log, true, "UTF-8"));
            file = loader.open(text, load.getAttribute("name"));
        } finally {
            System.setOut(previous);
        }
        stdout = log.toString("UTF-8");
        String message;
        while ((message = file.getMessage()) != null) messages.add(message);
        for (String warning : loader.reported) messages.add("loader: " + warning);
        List<String> names = new ArrayList<>();
        for (Node n = load.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (!(n instanceof Element)) continue;
            Element item = (Element) n;
            if (item.getTagName().equals("lib")) names.add(item.getAttribute("name"));
            else if (item.getTagName().equals("circuit")) {
                Circuit circuit = file.getCircuit(item.getAttribute("name"));
                if (circuit == null) throw new IllegalStateException("电路 \"" + item.getAttribute("name") + "\" 没有载入");
                ids.loaded(circuit, DocumentIds.split(item.getAttribute("components")),
                    DocumentIds.wires(item.getAttribute("wires")));
            }
        }
        WorkerTiming.mark("ids");
        List<Library> loaded = file.getLibraries();
        if (loader.reported.isEmpty() && names.size() == loaded.size()) {
            libraries = new HashMap<>();
            for (int i = 0; i < names.size(); i++) libraries.put(names.get(i), loaded.get(i));
        } else libraries = null;
    }

    /** The project every drawing and observation of this file uses: one, so they leave no listeners behind. */
    Project project() {
        if (project == null) {
            project = new Project(file);
            project.getSimulator().shutDown();
        }
        return project;
    }

    /** Forgets what was read from the circuits as they were. */
    void changed() {
        results.clear();
        connections.clear();
        moves.clear();
    }

    /** One circuit's part of a change. */
    private static final class Change {
        final Circuit circuit;
        final DocumentIds.Sheet sheet;
        final String[] remove, add;
        final int[][] wires;
        final List<Component> take = new ArrayList<>(), put = new ArrayList<>();
        final List<Wire> unwire = new ArrayList<>(), rewire = new ArrayList<>();
        boolean pins;

        Change(Circuit circuit, DocumentIds.Sheet sheet, Element element) {
            this.circuit = circuit;
            this.sheet = sheet;
            remove = DocumentIds.split(element.getAttribute("remove"));
            add = DocumentIds.split(element.getAttribute("add"));
            wires = DocumentIds.wires(element.getAttribute("wires"));
        }
    }

    /**
     * Moves this project to revision `next`. True when it holds that
     * revision now; false when it has to be loaded whole, and this is then
     * unchanged. An exception means applying failed part way: drop this.
     */
    boolean advance(String next, Element change, byte[] text) throws Exception {
        if (libraries == null) return false;
        List<Change> changes = new ArrayList<>();
        try {
            for (Node n = change.getFirstChild(); n != null; n = n.getNextSibling()) {
                if (!(n instanceof Element) || !((Element) n).getTagName().equals("circuit")) continue;
                Circuit circuit = file.getCircuit(((Element) n).getAttribute("name"));
                if (circuit == null) return false;
                changes.add(new Change(circuit, ids.sheet(circuit), (Element) n));
            }
            if (!build(text, changes)) return false;
        } catch (Exception error) {
            // Nothing has changed yet.
            return false;
        }
        WorkerTiming.mark("patch.plan");
        int reports = loader.reported.size();
        new Apply(changes).execute(null);
        if (loader.reported.size() != reports) throw new IllegalStateException("Logisim reported a problem");
        for (Change c : changes) {
            for (String id : c.remove) c.sheet.remove(id);
            for (int i = 0; i < c.add.length; i++) c.sheet.put(c.add[i], c.put.get(i));
            c.sheet.wires(c.wires);
        }
        revision = next;
        changed();
        return true;
    }

    private static final Method REPAIRS = method("considerRepairs", Document.class, Element.class);

    /** Parses the added elements; made once per thread (a factory is not thread-safe). */
    private static final ThreadLocal<DocumentBuilderFactory> BUILDERS = ThreadLocal.withInitial(() -> {
        try {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(true);
            factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            return factory;
        } catch (javax.xml.parsers.ParserConfigurationException error) {
            throw new IllegalStateException(error);
        }
    });

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
     * Finds the removed components and builds the added ones. The added
     * elements come as a small document of the file's version, one circuit
     * per change, so the reader's version repairs apply to them exactly as in
     * a whole load. False when something does not resolve; nothing has
     * changed.
     */
    private boolean build(byte[] text, List<Change> changes) throws Exception {
        try {
            NativeCircuitLoader.validate(text);
        } catch (IllegalArgumentException rejected) {
            return false;
        }
        Document parsed = BUILDERS.get().newDocumentBuilder().parse(new ByteArrayInputStream(text));
        Element root = parsed.getDocumentElement();
        String source = root.getAttribute("source");
        // Before 2.6.3 the reader also rewrites library references across the file.
        if (!source.isEmpty() && LogisimVersion.parse(source).compareTo(LogisimVersion.get(2, 6, 3)) < 0) return false;
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
        Main.FILE_VERSION = source.isEmpty() ? Main.VERSION : LogisimVersion.parse(source);
        XmlReader.ReadContext context = reader.new ReadContext(file);
        context.libs.putAll(libraries);
        List<Element> parts = new ArrayList<>();
        for (Node node = root.getFirstChild(); node != null; node = node.getNextSibling())
            if (node instanceof Element && node.getNodeName().equals("circuit")) parts.add((Element) node);
        if (parts.size() != changes.size()) return false;
        try {
            for (int i = 0; i < changes.size(); i++) {
                Change change = changes.get(i);
                for (String id : change.remove) {
                    Component found = change.sheet.component(id);
                    if (found == null) return false;
                    change.take.add(found);
                }
                for (Element element : comps(parts.get(i)))
                    change.put.add(XmlCircuitReader.getComponent(element, context));
                if (change.put.size() != change.add.length) return false;
                for (Component component : change.take) change.pins |= component.getFactory() instanceof Pin;
                for (Component component : change.put) change.pins |= component.getFactory() instanceof Pin;
                // A drawn appearance places its pins from the appear element
                // as the circuit is created; a whole load redoes that.
                if (change.pins && !change.circuit.getAppearance().isDefaultAppearance()) return false;
                // Exactly what XmlCircuitReader.addWire gives: a wire between
                // the parsed ends; one of no length is never added.
                Set<Wire> next = new HashSet<>();
                for (int[] w : change.wires) {
                    if (w[0] != w[2] && w[1] != w[3]) return false;
                    if (w[0] != w[2] || w[1] != w[3])
                        next.add(Wire.create(com.cburch.logisim.data.Location.create(w[0], w[1]),
                            com.cburch.logisim.data.Location.create(w[2], w[3])));
                }
                Set<Wire> current = new HashSet<>(change.circuit.getWires());
                for (Wire wire : current) if (!next.contains(wire)) change.unwire.add(wire);
                for (Wire wire : next) if (!current.contains(wire)) change.rewire.add(wire);
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
