/*
 * Disposable exact-runtime observer for Vibe Logisim Experiment 001.
 *
 * This class intentionally lives in Logisim's circuit package. It observes the
 * package-private connectivity objects computed by the exact target runtime;
 * it does not reproduce their geometry, Tunnel, or Splitter algorithms.
 */
package com.cburch.logisim.circuit;

import com.cburch.logisim.Main;
import com.cburch.logisim.comp.Component;
import com.cburch.logisim.comp.ComponentFactory;
import com.cburch.logisim.comp.ComponentDrawContext;
import com.cburch.logisim.proj.Project;
import com.cburch.logisim.comp.EndData;
import com.cburch.logisim.data.Attribute;
import com.cburch.logisim.data.AttributeOption;
import com.cburch.logisim.data.Direction;
import com.cburch.logisim.data.AttributeSet;
import com.cburch.logisim.data.BitWidth;
import com.cburch.logisim.data.Bounds;
import com.cburch.logisim.data.Location;
import com.cburch.logisim.file.LogisimFile;
import com.cburch.logisim.instance.Instance;
import com.cburch.logisim.instance.Port;
import com.cburch.logisim.instance.StdAttr;
import com.cburch.logisim.std.wiring.Pin;
import com.cburch.logisim.std.wiring.Tunnel;
import com.cburch.logisim.tools.AddTool;
import com.cburch.logisim.tools.Library;
import com.cburch.logisim.tools.Tool;

import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.SortedMap;

public final class ExactRuntimeObserver {
    private static final String SCHEMA =
        "vibe-logisim.experiment-001.runtime-observation/v0";
    private static final String OBSERVER_VERSION = "spike-1";
    private static final String EXPECTED_RUNTIME_SHA256 =
        "9eb1aae5e87cf0c6e4af845dde00624338c6dce25d945b6482cad017aa6cbb34";
    private static final String COURSE_RUNTIME_SHA256 =
        "b2400702fb9e8e4c71c512d7e09678a788039f402be55164209cde4cee8fc996";
    private static boolean courseRuntime;

    /**
     * Which runtime later answers describe: the course build leaves port
     * roles it does not verify unnamed (semanticRole).
     */
    public static void useRuntime(String runtimeDigest) {
        courseRuntime = COURSE_RUNTIME_SHA256.equals(runtimeDigest);
    }

    private static final Comparator<Component> COMPONENT_ORDER =
        Comparator.comparingInt((Component c) -> c.getLocation().getY())
            .thenComparingInt(c -> c.getLocation().getX())
            .thenComparing(c -> c.getFactory().getName())
            .thenComparing(c -> attributeFingerprint(c.getAttributeSet()));

    private final LogisimFile file;
    private final Project project;
    private final Circuit focus;
    private final Map<Circuit, Map<Component, String>> idsByCircuit =
        new IdentityHashMap<Circuit, Map<Component, String>>();
    private final DocumentIds.Sheet sheet;
    private final Map<Component, String> focusIds;
    private final List<Object> unknowns = new ArrayList<Object>();
    private final Coverage coverage = new Coverage();
    private final List<Object> loaderMessages;

    private ExactRuntimeObserver(
        LogisimFile file, Project project, DocumentIds ids, Circuit focus, List<Object> loaderMessages
    ) {
        this.file = file;
        this.project = project;
        this.focus = focus;
        for (Circuit circuit : file.getCircuits()) idsByCircuit.put(circuit, ids.sheet(circuit).ids());
        this.sheet = ids.sheet(focus);
        this.focusIds = sheet.ids();
        this.loaderMessages = loaderMessages;
    }

    /**
     * One circuit of a loaded revision, named the document's way: components
     * by their document ids, wires by the document wire over each stretch.
     * The worker keeps the project (and its Project, so drawing leaves no
     * listeners behind).
     */
    public static String observeLoaded(LogisimFile file, Project project, DocumentIds ids,
            String document, String revision, String name, Path runtime, String runtimeDigest,
            String stdout, List<Object> messages) throws Exception {
        courseRuntime = COURSE_RUNTIME_SHA256.equals(runtimeDigest);
        if (!courseRuntime && !EXPECTED_RUNTIME_SHA256.equals(runtimeDigest))
            throw new IllegalArgumentException("Unsupported runtime digest");
        Circuit focus = file.getCircuit(name);
        if (focus == null) throw new IllegalArgumentException("Unknown circuit: " + name);
        ExactRuntimeObserver observer = new ExactRuntimeObserver(file, project, ids, focus, messages);
        phase("ids");
        Map<String, Object> result = observer.observe(document, revision, runtime, runtimeDigest, stdout);
        StringBuilder out = new StringBuilder(256 * 1024);
        Json.writeCompact(result, out);
        phase("json");
        return out.toString();
    }

    /** A worker timing mark; a no-op outside a timed worker request. */
    private static void phase(String name) {
        com.cburch.logisim.file.WorkerTiming.mark("observe." + name);
    }

    private Map<String, Object> observe(
        String document, String revisionId, Path runtimeJar, String runtimeDigest, String loaderStdout
    ) throws Exception {
        measureGeometry();
        phase("geometry");
        NetIndex nets = new NetIndex(focus, sheet, coverage, unknowns, true);
        nets.compute();
        phase("nets");

        List<Object> components = observeComponents(nets);
        phase("components");
        List<Object> states = observeStateElements(nets);
        List<Object> tunnels = observeTunnels(nets);
        phase("tunnels");
        List<Object> circuitSummaries = observeCircuitSummaries();
        phase("summaries");
        List<Object> paths = observePathsToFocus();
        List<Object> widthErrors = observeWidthErrors();
        phase("paths");

        addStandingUnknowns();
        if (!widthErrors.isEmpty()) {
            unknowns.add(obj(
                "code", "WIDTH_INCOMPATIBILITY",
                "claim", "The exact runtime reported width-incompatible points.",
                "count", widthErrors.size()
            ));
        }

        List<Object> loaderMessages = new ArrayList<Object>(this.loaderMessages);
        if (!loaderMessages.isEmpty()) {
            unknowns.add(obj(
                "code", "LOADER_MESSAGES_PRESENT",
                "claim", "The runtime loader emitted messages; comp/wire coverage was verified "
                    + "against the source document, but attribute values named in loader "
                    + "messages fell back to runtime defaults.",
                "messages", loaderMessages
            ));
        }

        Map<String, Object> observer = obj(
            "version", OBSERVER_VERSION,
            "disposition", "disposable measurement spike",
            "connectivityAuthority",
                "Logisim-ITA CircuitWires.BundleMap and WireThread from the exact runtime",
            "doesNotInfer", Arrays.asList(
                "geometric crossing connectivity",
                "cross-revision identity",
                "dynamic instance traces",
                "circuit correctness"
            )
        );
        Map<String, Object> revision = obj("document", document, "revision", revisionId);
        Map<String, Object> runtime = obj(
            "reportedVersion", Main.VERSION,
            "jarPath", runtimeJar.toAbsolutePath().normalize().toString(),
            "jarSha256", runtimeDigest,
            "expectedJarSha256", courseRuntime ? COURSE_RUNTIME_SHA256 : EXPECTED_RUNTIME_SHA256,
            "javaVersion", System.getProperty("java.version")
        );
        Map<String, Object> project = obj(
            "name", file.getName(),
            "mainCircuit", file.getMainCircuit() == null ? null : file.getMainCircuit().getName(),
            "runtimeLoaderStdout", nonEmptyLines(loaderStdout),
            "loaderMessages", loaderMessages,
            "libraries", observeLibraries(),
            "circuits", circuitSummaries
        );
        Map<String, Object> focusObject = obj(
            "circuit", focus.getName(),
            "bounds", bounds(focus.getBounds()),
            "instancePaths", paths,
            "components", components,
            "wires", nets.wiresJson(),
            "wireBundles", nets.bundlesJson(true),
            "bitNets", nets.netsJson(),
            "stateElements", states,
            "tunnels", tunnels,
            "widthIncompatibilities", widthErrors
        );

        phase("ledger");
        Map<String, Object> full = obj(
            "schema", SCHEMA,
            "mode", "full-ledger",
            "observer", observer,
            "revision", revision,
            "runtime", runtime,
            "project", project,
            "focus", focusObject,
            "coverage", coverage.toJson(),
            "unknowns", unknowns
        );
        return full;
    }

    /** Some native components cache approximate bounds until their first paint,
     * then overwrite them with the current (possibly zoomed) font metrics.
     * Establish geometry in one canonical, unscaled graphics context before
     * every observation. Display rendering must not change subsequent facts.
     * A one-pixel surface bounds memory; drawing each component explicitly
     * avoids viewport culling and never starts simulation.
     */
    private void measureGeometry() {
        Graphics2D g = new BufferedImage(1, 1, BufferedImage.TYPE_INT_ARGB).createGraphics();
        try {
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
            ComponentDrawContext context = new ComponentDrawContext(null, focus,
                project.getCircuitState(focus), g, g, true);
            context.setShowState(false);
            context.setShowColor(true);
            for (Component component : sortedComponents(focus)) component.draw(context);
        } finally { g.dispose(); }
    }

    private List<Object> observeComponents(NetIndex nets) {
        List<Component> ordered = sortedComponents(focus);
        List<Object> result = new ArrayList<Object>();
        Graphics2D measurement = new BufferedImage(1, 1, BufferedImage.TYPE_INT_ARGB).createGraphics();
        try {
        for (Component component : ordered) {
            coverage.components++;
            String id = focusIds.get(component);
            Bounds componentBounds = component.getBounds();

            List<Object> ends = new ArrayList<Object>();
            Instance instance = instanceOrNull(component);
            List<Port> ports = instance == null
                ? Collections.<Port>emptyList() : instance.getPorts();
            for (int index = 0; index < component.getEnds().size(); index++) {
                EndData end = component.getEnd(index);
                coverage.ends++;
                int width = width(end.getWidth());
                if (width < 0) {
                    coverage.unknownWidthEnds++;
                } else {
                    coverage.endBits += width;
                }
                List<Object> netBits = nets.netBits(component, index, end);
                coverage.mappedEndBits += netBits.size();
                if (width >= 0 && netBits.size() == width) coverage.mappedEnds++;
                String role = semanticRole(component, index);
                if (role == null) coverage.endsWithoutRole++;
                else coverage.endsWithRole++;
                String tooltip = null;
                if (index < ports.size()) {
                    try {
                        tooltip = ports.get(index).getToolTip();
                    } catch (Throwable ignored) {
                        tooltip = null;
                    }
                }
                Map<String, Object> observedEnd = obj(
                    "index", index,
                    "location", location(end.getLocation()),
                    "width", width < 0 ? null : width,
                    "exclusive", end.isExclusive(),
                    "semanticRole", role,
                    "runtimeTooltip", emptyToNull(tooltip),
                    "netBits", netBits,
                    "localOccupants", focus.getComponents(end.getLocation()).size()
                );
                NativePortSemantics.putDirection(observedEnd, component, index);
                Boolean registered = registeredInput(component, index);
                if (registered != null) observedEnd.put("registered", registered);
                ends.add(observedEnd);
            }

            String provenance = factoryProvenance(component.getFactory());
            if (provenance == null) {
                coverage.unresolvedFactoryProvenance++;
            }
            Map<String, Object> selector = obj(
                "circuit", focus.getName(),
                "factory", component.getFactory().getName(),
                "location", location(component.getLocation()),
                "label", componentLabel(component)
            );
            result.add(obj(
                "componentId", id,
                "selector", selector,
                "factoryName", component.getFactory().getName(),
                "displayName", safeDisplayName(component.getFactory()),
                "factoryClass", component.getFactory().getClass().getName(),
                "factoryProvenance", provenance,
                "location", location(component.getLocation()),
                "bounds", bounds(componentBounds),
                "visualBounds", bounds(component.getBounds(measurement)),
                "attributes", attributes(component.getAttributeSet()),
                "ends", ends,
                "subcircuit", component.getFactory() instanceof SubcircuitFactory
                    ? ((SubcircuitFactory) component.getFactory()).getSubcircuit().getName()
                    : null,
                "storage", storageKind(component)
            ));
        }
        } finally {
            measurement.dispose();
        }
        return result;
    }

    private List<Object> observeStateElements(NetIndex nets) {
        List<Object> result = new ArrayList<Object>();
        for (Component component : sortedComponents(focus)) {
            if (!NativePortSemantics.isVerifiedRegister(component)) continue;
            coverage.knownStateElements++;
            List<Object> ports = new ArrayList<Object>();
            for (int i = 0; i < component.getEnds().size(); i++) {
                EndData end = component.getEnd(i);
                ports.add(obj(
                    "role", NativePortSemantics.registerRole(component, i),
                    "endIndex", i,
                    "netBits", nets.netBits(component, i, end)
                ));
            }
            result.add(obj(
                "componentId", focusIds.get(component),
                "kind", "Register",
                "roleMappingProfile", NativePortSemantics.registerProfile(component),
                "label", componentLabel(component),
                "ports", ports
            ));
        }
        return result;
    }

    private List<Object> observeTunnels(NetIndex nets) {
        Map<String, List<String>> peers = new LinkedHashMap<String, List<String>>();
        for (Component component : sortedComponents(focus)) {
            if (!(component.getFactory() instanceof Tunnel)) continue;
            String label = componentLabel(component);
            peers.computeIfAbsent(label == null ? "" : label, k -> new ArrayList<String>())
                .add(focusIds.get(component));
        }

        List<Object> result = new ArrayList<Object>();
        for (Component component : sortedComponents(focus)) {
            if (!(component.getFactory() instanceof Tunnel)) continue;
            String label = componentLabel(component);
            EndData end = component.getEnd(0);
            result.add(obj(
                "componentId", focusIds.get(component),
                "label", label,
                "location", location(component.getLocation()),
                "width", width(end.getWidth()),
                "netBits", nets.netBits(component, 0, end),
                "sameLabelPeers", peers.get(label == null ? "" : label)
            ));
        }
        return result;
    }

    private List<Object> observeCircuitSummaries() {
        List<Object> result = new ArrayList<Object>();
        for (Circuit circuit : file.getCircuits()) {
            List<Object> instances = new ArrayList<Object>();
            Map<Component, String> ids = idsByCircuit.get(circuit);
            for (Component component : sortedComponents(circuit)) {
                if (component.getFactory() instanceof SubcircuitFactory) {
                    instances.add(obj(
                        "instanceId", ids.get(component),
                        "target", ((SubcircuitFactory) component.getFactory())
                            .getSubcircuit().getName(),
                        "location", location(component.getLocation()),
                        "bounds", bounds(component.getBounds()),
                        "label", componentLabel(component)
                    ));
                }
            }
            result.add(obj(
                "name", circuit.getName(),
                "bounds", bounds(circuit.getBounds()),
                "componentCount", circuit.getNonWires().size(),
                "wireCount", circuit.getWires().size(),
                "instances", instances
            ));
        }
        return result;
    }

    private List<Object> observePathsToFocus() {
        List<InstanceEdge> edges = new ArrayList<InstanceEdge>();
        Set<Circuit> targeted = Collections.newSetFromMap(
            new IdentityHashMap<Circuit, Boolean>());
        for (Circuit parent : file.getCircuits()) {
            for (Component component : sortedComponents(parent)) {
                if (!(component.getFactory() instanceof SubcircuitFactory)) continue;
                Circuit target = ((SubcircuitFactory) component.getFactory()).getSubcircuit();
                targeted.add(target);
                edges.add(new InstanceEdge(
                    parent, target, idsByCircuit.get(parent).get(component),
                    component.getLocation(), componentLabel(component)
                ));
            }
        }

        List<Circuit> roots = new ArrayList<Circuit>();
        for (Circuit circuit : file.getCircuits()) {
            if (!targeted.contains(circuit)) roots.add(circuit);
        }
        if (roots.isEmpty() && file.getMainCircuit() != null) roots.add(file.getMainCircuit());

        List<Object> result = new ArrayList<Object>();
        for (Circuit root : roots) {
            findPaths(root, focus, edges, new ArrayList<InstanceEdge>(),
                Collections.newSetFromMap(new IdentityHashMap<Circuit, Boolean>()), result);
            if (result.size() >= 256) break;
        }
        if (result.size() >= 256) {
            unknowns.add(obj(
                "code", "INSTANCE_PATH_LIMIT",
                "claim", "Instance paths were capped at 256.",
                "limit", 256
            ));
        }
        return result;
    }

    private void findPaths(
        Circuit current, Circuit target, List<InstanceEdge> edges,
        List<InstanceEdge> path, Set<Circuit> active, List<Object> result
    ) {
        if (result.size() >= 256) return;
        if (current == target) {
            List<Object> steps = new ArrayList<Object>();
            for (InstanceEdge edge : path) steps.add(edge.toJson());
            result.add(obj("root", path.isEmpty() ? current.getName() : path.get(0).parent.getName(),
                "steps", steps));
            return;
        }
        if (path.size() >= 16 || !active.add(current)) return;
        for (InstanceEdge edge : edges) {
            if (edge.parent != current) continue;
            path.add(edge);
            findPaths(edge.target, target, edges, path, active, result);
            path.remove(path.size() - 1);
        }
        active.remove(current);
    }

    private List<Object> observeWidthErrors() {
        Set<WidthIncompatibilityData> errors = focus.getWidthIncompatibilityData();
        if (errors == null || errors.isEmpty()) return Collections.emptyList();
        List<Object> result = new ArrayList<Object>();
        for (WidthIncompatibilityData error : errors) {
            List<Object> points = new ArrayList<Object>();
            for (int i = 0; i < error.size(); i++) {
                points.add(obj(
                    "location", location(error.getPoint(i)),
                    "width", width(error.getBitWidth(i))
                ));
            }
            result.add(obj("points", points));
        }
        coverage.widthIncompatibilities = result.size();
        return result;
    }

    private List<Object> observeLibraries() {
        List<Object> result = new ArrayList<Object>();
        Set<Library> seen = Collections.newSetFromMap(new IdentityHashMap<Library, Boolean>());
        for (Library library : file.getLibraries()) {
            describeLibrary(library, null, result, seen);
        }
        return result;
    }

    private void describeLibrary(
        Library library, String parent, List<Object> out, Set<Library> seen
    ) {
        if (!seen.add(library)) return;
        String here = parent == null ? library.getName() : parent + "/" + library.getName();
        out.add(obj(
            "path", here,
            "name", library.getName(),
            "displayName", library.getDisplayName(),
            "class", library.getClass().getName(),
            "toolCount", library.getTools().size()
        ));
        for (Library child : library.getLibraries()) {
            describeLibrary(child, here, out, seen);
        }
    }

    private void addStandingUnknowns() {
        unknowns.add(obj(
            "code", "NO_DYNAMIC_INSTANCE_TRACE",
            "claim", "This static definition observation does not identify values or state transitions in a particular hierarchical instance."
        ));
        unknowns.add(obj(
            "code", "REVISION_LOCAL_IDENTITIES",
            "claim", "Component, bundle and net IDs are bound to this artifact revision; no cross-revision identity map is asserted."
        ));
        unknowns.add(obj(
            "code", "PARTIAL_PORT_SEMANTICS",
            "claim", "Semantic roles are exact-profile overlays only for known task-relevant factories; other ends retain direction, width and runtime tooltip but no guessed role.",
            "endsWithoutRole", coverage.endsWithoutRole
        ));
        unknowns.add(obj(
            "code", "PARTIAL_STATEFUL_CLASSIFICATION",
            "claim", "Only Register implementations with verified class SHA-256 are classified as state elements; arbitrary external stateful factories are not inferred."
        ));
        unknowns.add(obj(
            "code", "NO_CORRECTNESS_CLAIM",
            "claim", "Runtime-interpreted connectivity does not establish circuit behavior."
        ));
    }

    private String factoryProvenance(ComponentFactory factory) {
        if (factory instanceof SubcircuitFactory) {
            return "project-circuit:" + ((SubcircuitFactory) factory).getSubcircuit().getName();
        }
        for (Library library : file.getLibraries()) {
            String found = findFactoryLibrary(library, factory, library.getName(),
                Collections.newSetFromMap(new IdentityHashMap<Library, Boolean>()));
            if (found != null) return found;
        }
        return null;
    }

    private static String findFactoryLibrary(
        Library library, ComponentFactory factory, String path, Set<Library> seen
    ) {
        if (!seen.add(library)) return null;
        try {
            for (Tool tool : library.getTools()) {
                if (tool instanceof AddTool && ((AddTool) tool).getFactory() == factory) {
                    return "library:" + path;
                }
            }
        } catch (Throwable ignored) {
            // Reported through unresolvedFactoryProvenance rather than guessed.
        }
        for (Library child : library.getLibraries()) {
            String found = findFactoryLibrary(child, factory,
                path + "/" + child.getName(), seen);
            if (found != null) return found;
        }
        return null;
    }

    /**
     * IDs are derived from the component's anchor location ("c1300_540" for
     * (1300,540); "cm20_40" for (-20,40)), so a part that is not moved keeps its
     * ID across edits elsewhere in the circuit and a caller that placed a part
     * can address it without another discovery page. Parts sharing one anchor
     * are disambiguated by a "_2", "_3", ... suffix in COMPONENT_ORDER.
     */
    // ---- storage shape --------------------------------------------------------
    //
    // What a component does with time, read from the runtime's nets and not
    // from any name: a built-in register or flip-flop holds its inputs for a
    // cycle ("delay"); a counter or random source changes on its own
    // ("state"); a subcircuit is storage when every one of its inputs only
    // reaches storage inside it, and "state" when that storage feeds logic of
    // its own (a program counter with its adder, a state machine) rather than
    // just the output pins (a pipeline register). Nested instances are
    // classified recursively. The layout engine lays out stage boundaries from
    // this; a register file (write port registered, read port combinational)
    // is not storage, but its registered inputs are reported per end.

    private static final Set<String> DELAY_FACTORIES = new HashSet<String>(Arrays.asList(
        "Register", "Shift Register", "D Flip-Flop", "T Flip-Flop", "J-K Flip-Flop", "S-R Flip-Flop"));
    private static final Set<String> STATE_FACTORIES = new HashSet<String>(Arrays.asList(
        "Counter", "Random"));

    private static final class Shape {
        String storage;
        final Map<Component, Boolean> registeredInputs = new IdentityHashMap<Component, Boolean>();
    }

    private final Map<Circuit, Shape> shapes = new IdentityHashMap<Circuit, Shape>();

    private String storageKind(Component component) {
        ComponentFactory factory = component.getFactory();
        if (factory instanceof SubcircuitFactory) {
            return shape(((SubcircuitFactory) factory).getSubcircuit()).storage;
        }
        String name = factory.getName();
        if (DELAY_FACTORIES.contains(name)) return "delay";
        if (STATE_FACTORIES.contains(name)) return "state";
        return null;
    }

    /** For an input end of a subcircuit instance: does the signal only reach storage inside? */
    private Boolean registeredInput(Component instance, int endIndex) {
        if (!(instance.getFactory() instanceof SubcircuitFactory)) return null;
        EndData end = instance.getEnd(endIndex);
        if (!end.isInput() || end.isOutput()) return null;
        Component pin = pinOfEnd(instance, endIndex);
        if (pin == null) return null;
        Circuit target = ((SubcircuitFactory) instance.getFactory()).getSubcircuit();
        return shape(target).registeredInputs.get(pin);
    }

    /** The definition's Pin behind end {@code index} of an instance (the order computePorts used). */
    private static Component pinOfEnd(Component instance, int index) {
        SubcircuitFactory factory = (SubcircuitFactory) instance.getFactory();
        Circuit target = factory.getSubcircuit();
        Instance[] pins = null;
        AttributeSet attributes = instance.getAttributeSet();
        if (attributes instanceof CircuitAttributes) {
            pins = ((CircuitAttributes) attributes).getPinInstances();
        }
        if (pins == null) {
            Direction facing = attributes.getValue(StdAttr.FACING);
            SortedMap<Location, Instance> offsets =
                target.getAppearance().getPortOffsets(facing == null ? Direction.EAST : facing);
            pins = offsets.values().toArray(new Instance[0]);
        }
        if (index < 0 || index >= pins.length) return null;
        for (Component candidate : target.getNonWires()) {
            if (candidate.getFactory() == Pin.FACTORY && instanceOrNull(candidate) == pins[index]) {
                return candidate;
            }
        }
        return null;
    }

    private Shape shape(Circuit circuit) {
        Shape shape = shapes.get(circuit);
        if (shape != null) return shape;
        shape = new Shape();
        shapes.put(circuit, shape); // registered first: a definition reached again through itself is combinational
        circuit.wires.ensureComputed();

        // bit net -> components reading it; component -> bit nets it drives
        Map<Object, List<Component>> readers = new HashMap<Object, List<Component>>();
        Map<Component, Set<Object>> drives = new IdentityHashMap<Component, Set<Object>>();
        List<Component> inputs = new ArrayList<Component>();
        Set<Component> outputs = Collections.newSetFromMap(new IdentityHashMap<Component, Boolean>());
        Set<Component> storage = Collections.newSetFromMap(new IdentityHashMap<Component, Boolean>());
        Set<Component> logic = Collections.newSetFromMap(new IdentityHashMap<Component, Boolean>());
        boolean stateInside = false;
        for (Component component : sortedComponents(circuit)) {
            String kind = storageKind(component);
            if (kind != null) {
                storage.add(component);
                if (kind.equals("state")) stateInside = true;
            }
            boolean pin = component.getFactory() == Pin.FACTORY;
            boolean passive = pin || component.getFactory() instanceof Tunnel
                || "Splitter".equals(component.getFactory().getName());
            boolean drivesSomething = false;
            for (int i = 0; i < component.getEnds().size(); i++) {
                EndData end = component.getEnd(i);
                Map<String, Object> direction = new LinkedHashMap<String, Object>();
                NativePortSemantics.putDirection(direction, component, i);
                String d = String.valueOf(direction.get("direction"));
                boolean in = d.equals("input") || d.equals("inout");
                boolean out = d.equals("output") || d.equals("inout");
                if (pin) {
                    // A Pin's single end faces the circuit: it drives the net
                    // when the pin is an input of the definition.
                    if (out) inputs.add(component);
                    if (in) outputs.add(component);
                }
                for (Object net : bitNets(circuit, end)) {
                    if (in) readers.computeIfAbsent(net, k -> new ArrayList<Component>()).add(component);
                    if (out) {
                        drives.computeIfAbsent(component, k -> new HashSet<Object>()).add(net);
                        drivesSomething = true;
                    }
                }
            }
            if (!pin && !passive && kind == null && drivesSomething) logic.add(component);
        }

        boolean allRegistered = !storage.isEmpty() && !inputs.isEmpty();
        for (Component input : inputs) {
            Set<Component> reached = reach(input, readers, drives, storage);
            boolean combinational = false;
            for (Component c : reached) {
                if (outputs.contains(c) && c != input) { combinational = true; break; }
            }
            shape.registeredInputs.put(input, !combinational);
            if (combinational) allRegistered = false;
        }
        if (allRegistered) {
            boolean stateful = stateInside;
            for (Component s : storage) {
                if (stateful) break;
                for (Component c : reach(s, readers, drives, storage)) {
                    if (logic.contains(c)) { stateful = true; break; }
                }
            }
            shape.storage = stateful ? "state" : "delay";
        }
        return shape;
    }

    /**
     * The nets of an end's bits as NetIndex resolves them, without its
     * records: the runtime's wire thread, or the point of an end that no
     * bundle reaches. Bits of an unknown width or an invalid bundle have none.
     */
    private static List<Object> bitNets(Circuit circuit, EndData end) {
        int width = width(end.getWidth());
        if (width <= 0) return Collections.emptyList();
        WireBundle bundle = circuit.wires.getWireBundle(end.getLocation());
        if (bundle != null && (!bundle.isValid() || bundle.threads == null)) return Collections.emptyList();
        List<Object> nets = new ArrayList<Object>(width);
        Location point = end.getLocation();
        for (int bit = 0; bit < width; bit++) {
            if (bundle == null) nets.add(point.getX() + "," + point.getY() + "#" + bit);
            else if (bit < bundle.threads.length) nets.add(bundle.threads[bit].find());
        }
        return nets;
    }

    /** Components a signal leaving {@code from} reaches through combinational parts; storage stops it. */
    private static Set<Component> reach(
        Component from, Map<Object, List<Component>> readers,
        Map<Component, Set<Object>> drives, Set<Component> storage
    ) {
        Set<Component> seen = Collections.newSetFromMap(new IdentityHashMap<Component, Boolean>());
        Deque<Component> queue = new ArrayDeque<Component>();
        queue.add(from);
        while (!queue.isEmpty()) {
            Component current = queue.remove();
            for (Object net : drives.getOrDefault(current, Collections.<Object>emptySet())) {
                for (Component next : readers.getOrDefault(net, Collections.<Component>emptyList())) {
                    if (next == from || !seen.add(next)) continue;
                    if (!storage.contains(next)) queue.add(next);
                }
            }
        }
        return seen;
    }

    static List<Component> sortedComponents(Circuit circuit) {
        List<Component> result = new ArrayList<Component>(circuit.getNonWires());
        Collections.sort(result, COMPONENT_ORDER);
        return result;
    }

    static String semanticRole(Component component, int index) {
        String factoryName = component.getFactory().getName();
        int endCount = component.getEnds().size();
        if (component.getFactory() instanceof Tunnel) return "tunnel:" + componentLabel(component);
        if (component.getFactory() == Pin.FACTORY) {
            EndData end = component.getEnd(index);
            return end.isOutput() && !end.isInput() ? "circuitInput"
                : end.isInput() && !end.isOutput() ? "circuitOutput" : "circuitInOut";
        }
        String registerRole = NativePortSemantics.registerRole(component, index);
        if (registerRole != null) return registerRole;
        if (courseRuntime) return null;
        if ("Decoder".equals(factoryName)) {
            boolean enabled = booleanAttribute(component.getAttributeSet(), "enable");
            int outputs = endCount - (enabled ? 2 : 1);
            if (index < outputs) return "decodedOutput[" + index + "]";
            if (index == outputs) return "select";
            if (enabled && index == outputs + 1) return "enable";
        }
        if ("Multiplexer".equals(factoryName)) {
            boolean enabled = booleanAttribute(component.getAttributeSet(), "enable");
            int inputs = endCount - (enabled ? 3 : 2);
            if (index < inputs) return "dataInput[" + index + "]";
            if (index == inputs) return "select";
            if (enabled && index == inputs + 1) return "enable";
            if (index == endCount - 1) return "output";
        }
        if (factoryName.endsWith(" Gate")) {
            return index == 0 ? "output" : "input[" + (index - 1) + "]";
        }
        if ("Constant".equals(factoryName)) return index == 0 ? "output" : null;
        if ("Comparator".equals(factoryName)) {
            String[] roles = { "inputA", "inputB", "less", "equal", "greater" };
            return index < roles.length ? roles[index] : null;
        }
        return null;
    }

    private static boolean booleanAttribute(AttributeSet attributes, String name) {
        Attribute<?> attribute = attributes.getAttribute(name);
        if (attribute == null) return false;
        Object value = attributes.getValue(attribute);
        return Boolean.TRUE.equals(value) || "true".equalsIgnoreCase(String.valueOf(value));
    }

    static Instance instanceOrNull(Component component) {
        try {
            return Instance.getInstanceFor(component);
        } catch (Throwable ignored) {
            return null;
        }
    }

    static String componentLabel(Component component) {
        AttributeSet attributes = component.getAttributeSet();
        if (!attributes.containsAttribute(StdAttr.LABEL)) return null;
        return emptyToNull(attributes.getValue(StdAttr.LABEL));
    }

    /**
     * Name and standard value of every attribute. Display strings and option
     * lists are not part of an observation: building an option list asks the
     * native editor for a Swing combo box per attribute, which dominated the
     * observation of a large page. A component's options come from the
     * component-attributes request, for the components that are asked about.
     */
    private static List<Object> attributes(AttributeSet attributes) {
        List<Object> result = new ArrayList<Object>();
        for (Attribute<?> attribute : attributes.getAttributes()) {
            Object value = attributes.getValue(attribute);
            String standard;
            try {
                standard = standardString(attribute, value);
            } catch (Throwable error) {
                standard = String.valueOf(value);
            }
            result.add(obj("name", attribute.getName(), "standard", standard));
        }
        return result;
    }

    @SuppressWarnings({ "unchecked", "rawtypes" })
    private static String standardString(Attribute attribute, Object value) {
        return attribute.toStandardString(value);
    }

    private static String attributeFingerprint(AttributeSet attributes) {
        StringBuilder out = new StringBuilder();
        for (Attribute<?> attribute : attributes.getAttributes()) {
            out.append(attribute.getName()).append('=');
            try {
                out.append(standardString(attribute, attributes.getValue(attribute)));
            } catch (Throwable error) {
                out.append(String.valueOf(attributes.getValue(attribute)));
            }
            out.append(';');
        }
        return out.toString();
    }

    static String safeDisplayName(ComponentFactory factory) {
        try {
            return factory.getDisplayName();
        } catch (Throwable error) {
            return factory.getName();
        }
    }

    static int width(BitWidth width) {
        return width == null || width == BitWidth.UNKNOWN ? -1 : width.getWidth();
    }

    private static Map<String, Object> location(Location location) {
        return obj("x", location.getX(), "y", location.getY());
    }

    private static Map<String, Object> bounds(Bounds bounds) {
        return obj(
            "x", bounds.getX(), "y", bounds.getY(),
            "width", bounds.getWidth(), "height", bounds.getHeight()
        );
    }

    private static String shortHash(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return hex(digest.digest(value.getBytes(StandardCharsets.UTF_8))).substring(0, 16);
        } catch (Exception impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static String hex(byte[] bytes) {
        // Net IDs need thousands of hashes. General locale-aware formatting
        // for every byte dominates observation without changing any semantics.
        final char[] digits = "0123456789abcdef".toCharArray();
        char[] out = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            int value = bytes[i] & 0xff;
            out[i * 2] = digits[value >>> 4]; out[i * 2 + 1] = digits[value & 15];
        }
        return new String(out);
    }

    static String emptyToNull(String value) {
        return value == null || value.isEmpty() ? null : value;
    }

    private static List<String> nonEmptyLines(String value) {
        List<String> result = new ArrayList<String>();
        if (value == null) return result;
        for (String line : value.split("\\R")) {
            if (!line.trim().isEmpty()) result.add(line);
        }
        return result;
    }

    private static Map<String, Object> obj(Object... keyValues) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        for (int i = 0; i < keyValues.length; i += 2) {
            result.put((String) keyValues[i], keyValues[i + 1]);
        }
        return result;
    }

    static final class Coverage {
        int components;
        int ends;
        int mappedEnds;
        int endBits;
        int mappedEndBits;
        int unknownWidthEnds;
        int invalidBundleEnds;
        int endsWithoutBundle;
        int endsWithRole;
        int endsWithoutRole;
        int unresolvedFactoryProvenance;
        int knownStateElements;
        int widthIncompatibilities;

        Map<String, Object> toJson() {
            return obj(
                "components", components,
                "ends", ends,
                "mappedEnds", mappedEnds,
                "endBits", endBits,
                "mappedEndBits", mappedEndBits,
                "unknownWidthEnds", unknownWidthEnds,
                "invalidBundleEnds", invalidBundleEnds,
                "endsWithoutWireBundle", endsWithoutBundle,
                "endsWithSemanticRole", endsWithRole,
                "endsWithoutSemanticRole", endsWithoutRole,
                "unresolvedFactoryProvenance", unresolvedFactoryProvenance,
                "knownRegisterStateElements", knownStateElements,
                "widthIncompatibilities", widthIncompatibilities
            );
        }
    }

    private static final class InstanceEdge {
        final Circuit parent;
        final Circuit target;
        final String instanceId;
        final Location location;
        final String label;

        InstanceEdge(Circuit parent, Circuit target, String instanceId, Location location, String label) {
            this.parent = parent;
            this.target = target;
            this.instanceId = instanceId;
            this.location = location;
            this.label = label;
        }

        Map<String, Object> toJson() {
            return obj(
                "parentCircuit", parent.getName(),
                "instanceId", instanceId,
                "location", location(location),
                "label", label,
                "targetCircuit", target.getName()
            );
        }
    }

    static final class BundleRecord {
        final WireBundle bundle;
        String id;
        final List<String> wireIds = new ArrayList<String>();

        BundleRecord(WireBundle bundle) {
            this.bundle = bundle;
        }
    }

    static final class NetRecord {
        final WireThread root;
        final String pointKey;
        String id;
        final List<Object> contacts = new ArrayList<Object>();

        NetRecord(WireThread root, String pointKey) {
            this.root = root;
            this.pointKey = pointKey;
        }
    }

    static final class NetIndex {
        final Circuit circuit;
        final DocumentIds.Sheet sheet;
        final Map<Component, String> componentIds;
        final Coverage coverage;
        final List<Object> unknowns;
        final Map<WireBundle, BundleRecord> bundles =
            new IdentityHashMap<WireBundle, BundleRecord>();
        final Map<WireThread, NetRecord> threadNets =
            new IdentityHashMap<WireThread, NetRecord>();
        final Map<String, NetRecord> pointNets = new LinkedHashMap<String, NetRecord>();
        final Map<String, String> endBitNet = new HashMap<String, String>();
        /** The native wires cut at the document's wire ends, named by the document's wires. */
        final List<DocumentIds.Atom> atoms;
        /** Whether each net lists the component ends it joins. */
        final boolean contacts;

        NetIndex(
            Circuit circuit, DocumentIds.Sheet sheet,
            Coverage coverage, List<Object> unknowns, boolean contacts
        ) {
            this.circuit = circuit;
            this.sheet = sheet;
            this.componentIds = sheet.ids();
            this.coverage = coverage;
            this.unknowns = unknowns;
            this.contacts = contacts;
            this.atoms = sheet.atoms(circuit);
        }

        /** The bundle a native wire is in. */
        BundleRecord bundleOf(Wire wire) {
            WireBundle bundle = circuit.wires.getWireBundle(wire.getEnd0());
            return bundle == null ? null : bundles.get(bundle.find());
        }

        void compute() {
            circuit.wires.ensureComputed();
            for (Wire wire : circuit.getWires()) {
                collectBundle(circuit.wires.getWireBundle(wire.getEnd0()));
                collectBundle(circuit.wires.getWireBundle(wire.getEnd1()));
            }
            for (Component component : sortedComponents(circuit)) {
                for (EndData end : component.getEnds()) {
                    collectBundle(circuit.wires.getWireBundle(end.getLocation()));
                }
            }

            for (BundleRecord record : bundles.values()) {
                record.id = "b:" + shortHash(bundleSignature(record.bundle));
            }
            for (DocumentIds.Atom atom : atoms) {
                BundleRecord record = bundleOf(atom.wire);
                if (record != null && atom.id != null && !record.wireIds.contains(atom.id)) record.wireIds.add(atom.id);
            }

            for (BundleRecord bundleRecord : bundles.values()) {
                WireBundle bundle = bundleRecord.bundle;
                if (!bundle.isValid() || bundle.threads == null) continue;
                for (WireThread thread : bundle.threads) {
                    WireThread root = thread.find();
                    if (!threadNets.containsKey(root)) {
                        threadNets.put(root, new NetRecord(root, null));
                    }
                }
            }
            for (NetRecord record : threadNets.values()) {
                record.id = "n:" + shortHash(threadSignature(record.root));
            }

            for (Component component : sortedComponents(circuit)) {
                String componentId = componentIds.get(component);
                for (int endIndex = 0; endIndex < component.getEnds().size(); endIndex++) {
                    EndData end = component.getEnd(endIndex);
                    Map<String, Object> direction = new LinkedHashMap<String, Object>();
                    if (contacts) NativePortSemantics.putDirection(direction, component, endIndex);
                    int width = width(end.getWidth());
                    if (width < 0) continue;
                    WireBundle bundle = circuit.wires.getWireBundle(end.getLocation());
                    if (bundle == null) coverage.endsWithoutBundle++;
                    if (bundle != null && (!bundle.isValid() || bundle.threads == null)) {
                        coverage.invalidBundleEnds++;
                        continue;
                    }
                    for (int bit = 0; bit < width; bit++) {
                        NetRecord net;
                        if (bundle == null) {
                            String pointKey = end.getLocation().getX() + ","
                                + end.getLocation().getY() + "#" + bit;
                            net = pointNets.get(pointKey);
                            if (net == null) {
                                net = new NetRecord(null, pointKey);
                                net.id = "n:p:" + pointKey;
                                pointNets.put(pointKey, net);
                            }
                        } else if (bit < bundle.threads.length) {
                            net = threadNets.get(bundle.threads[bit].find());
                        } else {
                            net = null;
                        }
                        if (net == null) continue;
                        String key = endKey(componentId, endIndex, bit);
                        endBitNet.put(key, net.id);
                        if (!contacts) continue;
                        Map<String, Object> contact = obj(
                            "componentId", componentId,
                            "endIndex", endIndex,
                            "bit", bit,
                            "location", location(end.getLocation()),
                            "semanticRole", semanticRole(component, endIndex)
                        );
                        contact.putAll(direction);
                        net.contacts.add(contact);
                    }
                }
            }
        }

        private void collectBundle(WireBundle bundle) {
            if (bundle == null) return;
            bundle = bundle.find();
            if (!bundles.containsKey(bundle)) bundles.put(bundle, new BundleRecord(bundle));
            if (bundle.threads != null) {
                for (WireThread thread : bundle.threads) {
                    for (CircuitWires.ThreadBundle threadBundle : thread.find().getBundles()) {
                        WireBundle related = threadBundle.b.find();
                        if (!bundles.containsKey(related)) {
                            bundles.put(related, new BundleRecord(related));
                        }
                    }
                }
            }
        }

        List<Object> netBits(Component component, int endIndex, EndData end) {
            int width = width(end.getWidth());
            if (width < 0) return Collections.emptyList();
            String componentId = componentIds.get(component);
            List<Object> result = new ArrayList<Object>();
            for (int bit = 0; bit < width; bit++) {
                String netId = endBitNet.get(endKey(componentId, endIndex, bit));
                if (netId != null) result.add(obj("bit", bit, "netId", netId));
            }
            return result;
        }

        /**
         * The wires as the runtime connects them: native wires cut at the
         * document's wire ends, each with the document wire on it; pieces
         * meet only at their ends.
         */
        List<Object> wiresJson() {
            List<Object> result = new ArrayList<Object>();
            for (DocumentIds.Atom atom : atoms) {
                BundleRecord record = bundleOf(atom.wire);
                result.add(obj(
                    "wireId", atom.id,
                    "from", location(atom.from),
                    "to", location(atom.to),
                    "bundleId", record == null ? null : record.id
                ));
            }
            return result;
        }

        /** The bundles, with the wires each one joins when `withWires`. */
        List<Object> bundlesJson(boolean withWires) {
            List<BundleRecord> ordered = new ArrayList<BundleRecord>(bundles.values());
            Collections.sort(ordered, Comparator.comparing(record -> record.id));
            List<Object> result = new ArrayList<Object>();
            for (BundleRecord record : ordered) {
                WireBundle bundle = record.bundle;
                List<Object> points = new ArrayList<Object>();
                List<Location> orderedPoints = new ArrayList<Location>(bundle.points);
                Collections.sort(orderedPoints, Comparator
                    .comparingInt(Location::getY).thenComparingInt(Location::getX));
                for (Location point : orderedPoints) points.add(location(point));
                List<Object> bitNets = new ArrayList<Object>();
                if (bundle.threads != null) {
                    for (int bit = 0; bit < bundle.threads.length; bit++) {
                        NetRecord net = threadNets.get(bundle.threads[bit].find());
                        bitNets.add(obj("bit", bit, "netId", net == null ? null : net.id));
                    }
                }
                Map<String, Object> json = obj(
                    "bundleId", record.id,
                    "valid", bundle.isValid(),
                    "width", width(bundle.getWidth()),
                    "widthDeterminant", bundle.getWidthDeterminant() == null
                        ? null : location(bundle.getWidthDeterminant()),
                    "points", points
                );
                if (withWires) json.put("wireIds", record.wireIds);
                json.put("bitNets", bitNets);
                result.add(json);
            }
            return result;
        }

        List<Object> netsJson() {
            List<NetRecord> ordered = new ArrayList<NetRecord>(threadNets.values());
            ordered.addAll(pointNets.values());
            Collections.sort(ordered, Comparator.comparing(record -> record.id));
            List<Object> result = new ArrayList<Object>();
            for (NetRecord record : ordered) {
                List<Object> slices = new ArrayList<Object>();
                if (record.root != null) {
                    List<CircuitWires.ThreadBundle> threadBundles =
                        new ArrayList<CircuitWires.ThreadBundle>(record.root.getBundles());
                    Collections.sort(threadBundles, Comparator
                        .comparing((CircuitWires.ThreadBundle tb) -> bundles.get(tb.b.find()).id)
                        .thenComparingInt(tb -> tb.loc));
                    for (CircuitWires.ThreadBundle threadBundle : threadBundles) {
                        BundleRecord bundle = bundles.get(threadBundle.b.find());
                        slices.add(obj("bundleId", bundle.id, "bit", threadBundle.loc));
                    }
                }
                Collections.sort(record.contacts, Comparator
                    .comparing(contact -> String.valueOf(((Map<?, ?>) contact).get("componentId")))
                    .thenComparingInt(contact -> ((Number) ((Map<?, ?>) contact).get("endIndex")).intValue())
                    .thenComparingInt(contact -> ((Number) ((Map<?, ?>) contact).get("bit")).intValue()));
                result.add(obj(
                    "netId", record.id,
                    "kind", record.root == null ? "unbundled-runtime-point" : "runtime-wire-thread",
                    "slices", slices,
                    "contacts", record.contacts,
                    "contactCount", record.contacts.size()
                ));
            }
            return result;
        }

        private String bundleSignature(WireBundle bundle) {
            List<String> points = new ArrayList<String>();
            for (Location point : bundle.points) {
                points.add(point.getX() + "," + point.getY());
            }
            Collections.sort(points);
            return width(bundle.getWidth()) + ":" + String.join(";", points);
        }

        private String threadSignature(WireThread root) {
            List<String> slices = new ArrayList<String>();
            for (CircuitWires.ThreadBundle threadBundle : root.getBundles()) {
                BundleRecord bundle = bundles.get(threadBundle.b.find());
                slices.add(bundle.id + "#" + threadBundle.loc);
            }
            Collections.sort(slices);
            return String.join(";", slices);
        }

        private static String endKey(String componentId, int endIndex, int bit) {
            return componentId + ":" + endIndex + ":" + bit;
        }
    }

    static final class Json {
        static void writeCompact(Object value, StringBuilder out) {
            if (value == null) {
                out.append("null");
            } else if (value instanceof String) {
                string((String) value, out);
            } else if (value instanceof Number || value instanceof Boolean) {
                out.append(value.toString());
            } else if (value instanceof Map) {
                out.append('{');
                int index = 0;
                for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                    if (index++ > 0) out.append(',');
                    string(String.valueOf(entry.getKey()), out);
                    out.append(':');
                    writeCompact(entry.getValue(), out);
                }
                out.append('}');
            } else if (value instanceof Collection) {
                out.append('[');
                int index = 0;
                for (Object item : (Collection<?>) value) {
                    if (index++ > 0) out.append(',');
                    writeCompact(item, out);
                }
                out.append(']');
            } else {
                string(String.valueOf(value), out);
            }
        }

        static void write(Object value, StringBuilder out, int indent) {
            if (value == null) {
                out.append("null");
            } else if (value instanceof String) {
                string((String) value, out);
            } else if (value instanceof Number || value instanceof Boolean) {
                out.append(value.toString());
            } else if (value instanceof Map) {
                map((Map<?, ?>) value, out, indent);
            } else if (value instanceof Collection) {
                collection((Collection<?>) value, out, indent);
            } else {
                string(String.valueOf(value), out);
            }
        }

        private static void map(Map<?, ?> map, StringBuilder out, int indent) {
            out.append('{');
            if (!map.isEmpty()) out.append('\n');
            int index = 0;
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                spaces(out, indent + 2);
                string(String.valueOf(entry.getKey()), out);
                out.append(": ");
                write(entry.getValue(), out, indent + 2);
                if (++index < map.size()) out.append(',');
                out.append('\n');
            }
            if (!map.isEmpty()) spaces(out, indent);
            out.append('}');
        }

        private static void collection(Collection<?> values, StringBuilder out, int indent) {
            out.append('[');
            if (!values.isEmpty()) out.append('\n');
            int index = 0;
            for (Object value : values) {
                spaces(out, indent + 2);
                write(value, out, indent + 2);
                if (++index < values.size()) out.append(',');
                out.append('\n');
            }
            if (!values.isEmpty()) spaces(out, indent);
            out.append(']');
        }

        static void string(String value, StringBuilder out) {
            out.append('"');
            int plain = 0;
            while (plain < value.length()) {
                char ch = value.charAt(plain);
                if (ch < 0x20 || ch == '"' || ch == '\\') break;
                plain++;
            }
            out.append(value, 0, plain);
            for (int i = plain; i < value.length(); i++) {
                char ch = value.charAt(i);
                switch (ch) {
                    case '"': out.append("\\\""); break;
                    case '\\': out.append("\\\\"); break;
                    case '\b': out.append("\\b"); break;
                    case '\f': out.append("\\f"); break;
                    case '\n': out.append("\\n"); break;
                    case '\r': out.append("\\r"); break;
                    case '\t': out.append("\\t"); break;
                    default:
                        if (ch < 0x20) out.append(String.format(Locale.ROOT, "\\u%04x", (int) ch));
                        else out.append(ch);
                }
            }
            out.append('"');
        }

        private static void spaces(StringBuilder out, int count) {
            for (int i = 0; i < count; i++) out.append(' ');
        }
    }
}
