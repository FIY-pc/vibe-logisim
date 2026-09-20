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
import com.cburch.logisim.file.Loader;
import com.cburch.logisim.file.LogisimFile;
import com.cburch.logisim.instance.Instance;
import com.cburch.logisim.instance.Port;
import com.cburch.logisim.instance.StdAttr;
import com.cburch.logisim.std.wiring.Pin;
import com.cburch.logisim.std.wiring.Tunnel;
import com.cburch.logisim.tools.AddTool;
import com.cburch.logisim.tools.Library;
import com.cburch.logisim.tools.Tool;

import java.io.File;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import javax.imageio.ImageIO;
import java.io.IOException;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

public final class ExactRuntimeObserver {
    private static final String SCHEMA =
        "vibe-logisim.experiment-001.runtime-observation/v0";
    private static final String OBSERVER_VERSION = "spike-1";
    private static final String EXPECTED_RUNTIME_SHA256 =
        "9eb1aae5e87cf0c6e4af845dde00624338c6dce25d945b6482cad017aa6cbb34";
    private static final String COURSE_RUNTIME_SHA256 =
        "b2400702fb9e8e4c71c512d7e09678a788039f402be55164209cde4cee8fc996";
    private static boolean courseRuntime;
    private static final int COMPACT_SPATIAL_NEIGHBORS_PER_REGION_COMPONENT = 2;

    private static final Comparator<Component> COMPONENT_ORDER =
        Comparator.comparingInt((Component c) -> c.getLocation().getY())
            .thenComparingInt(c -> c.getLocation().getX())
            .thenComparing(c -> c.getFactory().getName())
            .thenComparing(c -> attributeFingerprint(c.getAttributeSet()));

    private static final Comparator<Wire> WIRE_ORDER =
        Comparator.comparingInt((Wire w) -> w.getEnd0().getY())
            .thenComparingInt(w -> w.getEnd0().getX())
            .thenComparingInt(w -> w.getEnd1().getY())
            .thenComparingInt(w -> w.getEnd1().getX());

    private final LogisimFile file;
    private final Circuit focus;
    private final Region region;
    private final boolean compactMode;
    private final Map<Circuit, Map<Component, String>> idsByCircuit =
        new IdentityHashMap<Circuit, Map<Component, String>>();
    private final Map<Component, String> focusIds;
    private final List<Object> unknowns = new ArrayList<Object>();
    private final Coverage coverage = new Coverage();
    private List<Object> retainedLoaderMessages;

    private ExactRuntimeObserver(
        LogisimFile file, Circuit focus, Region region, boolean compactMode
    ) {
        this.file = file;
        this.focus = focus;
        this.region = region;
        this.compactMode = compactMode;
        for (Circuit circuit : file.getCircuits()) {
            idsByCircuit.put(circuit, assignComponentIds(circuit));
        }
        this.focusIds = idsByCircuit.get(focus);
    }

    public static void main(String[] args) {
        System.setProperty("java.awt.headless", "true");
        try {
            Options options = Options.parse(args);

            Path artifact = new File(options.artifact).getCanonicalFile().toPath();
            if (!Files.isRegularFile(artifact)) {
                throw new IllegalArgumentException("missing artifact: " + artifact);
            }
            Region region = options.region;
            if (region != null && (region.width <= 0 || region.height <= 0)) {
                throw new IllegalArgumentException("region width and height must be positive");
            }

            Path runtimeJar = requiredPropertyPath("observer.runtime.jar");
            Path observerSource = optionalPropertyPath("observer.source.path");
            Path observerBundle = requiredPropertyPath("observer.bundle.path");
            String runtimeDigest = sha256(runtimeJar);
            courseRuntime = COURSE_RUNTIME_SHA256.equals(runtimeDigest);
            if (!courseRuntime && !EXPECTED_RUNTIME_SHA256.equals(runtimeDigest)) {
                throw new IllegalStateException(
                    "runtime digest mismatch: expected " + EXPECTED_RUNTIME_SHA256
                        + " but got " + runtimeDigest
                );
            }

            Loader loader = new Loader(null) {
                @Override
                public void showError(String description) {
                    // A GUI error dialog masks the useful loader diagnostic in headless mode.
                    // Do not continue with a partially loaded circuit and call it exact evidence.
                    throw new IllegalStateException("Logisim load error: " + description);
                }
            };
            ByteArrayOutputStream loaderOutput = new ByteArrayOutputStream();
            PrintStream originalOut = System.out;
            LogisimFile file;
            try {
                System.setOut(new PrintStream(loaderOutput, true, "UTF-8"));
                file = loader.openLogisimFile(artifact.toFile());
            } finally {
                System.setOut(originalOut);
            }
            Circuit focus = file.getCircuit(options.circuit);
            if (focus == null) {
                throw new IllegalArgumentException("missing circuit: " + options.circuit);
            }

            ExactRuntimeObserver observer = new ExactRuntimeObserver(
                file, focus, region, options.compact
            );
            Map<String, Object> document = observer.observe(
                artifact, runtimeJar, runtimeDigest, observerSource, observerBundle,
                loaderOutput.toString("UTF-8")
            );
            String renderPath = System.getenv("VIBE_OBSERVER_RENDER_PATH");
            if (renderPath != null && !renderPath.isEmpty()) {
                document.put("render", render(file, focus, new File(renderPath)));
            }
            StringBuilder out = new StringBuilder(256 * 1024);
            if (options.compact) Json.writeCompact(document, out);
            else Json.write(document, out, 0);
            out.append('\n');
            System.out.print(out.toString());
            System.exit(0);
        } catch (Throwable error) {
            error.printStackTrace(System.err);
            System.exit(1);
        }
    }

    /** Same observation contract for the desktop's resident read-only runtime. */
    public static String observeLoaded(LogisimFile file, Path artifact, String name,
            Path runtime, String runtimeDigest, Path bundle, String stdout,
            List<Object> messages, String renderPath) throws Exception {
        courseRuntime = COURSE_RUNTIME_SHA256.equals(runtimeDigest);
        if (!courseRuntime && !EXPECTED_RUNTIME_SHA256.equals(runtimeDigest))
            throw new IllegalArgumentException("Unsupported runtime digest");
        Circuit focus=file.getCircuit(name);
        if(focus==null)throw new IllegalArgumentException("Unknown circuit: "+name);
        ExactRuntimeObserver observer=new ExactRuntimeObserver(file,focus,null,false);
        observer.retainedLoaderMessages=messages;
        Map<String,Object> document=observer.observe(artifact,runtime,runtimeDigest,null,bundle,stdout);
        if(renderPath!=null&&!renderPath.isEmpty())document.put("render",render(file,focus,new File(renderPath)));
        StringBuilder out=new StringBuilder(256*1024);Json.writeCompact(document,out);return out.toString();
    }

    private static Map<String, Object> render(LogisimFile file, Circuit circuit, File output) throws Exception {
        BufferedImage measure = new BufferedImage(1, 1, BufferedImage.TYPE_INT_ARGB);
        Graphics2D mg = measure.createGraphics();
        Bounds box = circuit.getBounds(mg).expand(24);
        mg.dispose();
        // This bitmap is the overview. The desktop requests native viewport
        // pixels separately at the actual zoom/DPR. Do not redraw a 24 MP
        // off-screen surface for every small edit in a long course circuit.
        double scale = Math.min(2.0, Math.min(2048.0 / Math.max(box.getWidth(), box.getHeight()),
            Math.sqrt(4_000_000.0 / Math.max(1.0, (double) box.getWidth() * box.getHeight()))));
        BufferedImage bitmap = new BufferedImage(Math.max(1, (int) Math.ceil(box.getWidth() * scale)),
            Math.max(1, (int) Math.ceil(box.getHeight() * scale)), BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = bitmap.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.scale(scale, scale);
        g.translate(-box.getX(), -box.getY());
        g.setColor(Color.BLACK);
        Project project = new Project(file);
        project.getSimulator().shutDown();
        ComponentDrawContext context = new ComponentDrawContext(null, circuit,
            project.getCircuitState(circuit), g, g, true);
        context.setShowState(false);
        context.setShowColor(true);
        circuit.draw(context, null);
        g.dispose();
        ImageIO.write(bitmap, "png", output);
        return obj("bounds", bounds(box), "scale", scale, "authority", "Logisim native Circuit.draw");
    }

    private Map<String, Object> observe(
        Path artifact, Path runtimeJar, String runtimeDigest, Path observerSource,
        Path observerBundle,
        String loaderStdout
    ) throws Exception {
        NetIndex nets = new NetIndex(focus, focusIds, coverage, unknowns);
        nets.compute();

        List<Object> components = observeComponents(nets);
        List<Object> states = observeStateElements(nets);
        List<Object> tunnels = observeTunnels(nets);
        List<Object> spatial = observeSpatialAdjacency();
        List<Object> circuitSummaries = observeCircuitSummaries();
        List<Object> paths = observePathsToFocus();
        List<Object> widthErrors = observeWidthErrors();

        addStandingUnknowns();
        if (!widthErrors.isEmpty()) {
            unknowns.add(obj(
                "code", "WIDTH_INCOMPATIBILITY",
                "claim", "The exact runtime reported width-incompatible points.",
                "count", widthErrors.size()
            ));
        }

        List<Object> loaderMessages = retainedLoaderMessages == null ? new ArrayList<Object>() : new ArrayList<Object>(retainedLoaderMessages);
        for (; retainedLoaderMessages == null;) {
            String message = file.getMessage();
            if (message == null) break;
            loaderMessages.add(message);
        }
        if (!loaderMessages.isEmpty()) {
            unknowns.add(obj(
                "code", "LOADER_MESSAGES_PRESENT",
                "claim", "The runtime loader emitted messages; component coverage may be incomplete.",
                "messages", loaderMessages
            ));
        }

        Map<String, Object> observer = obj(
            "version", OBSERVER_VERSION,
            "disposition", "disposable measurement spike",
            "sourcePath", observerSource == null ? null
                : observerSource.toAbsolutePath().normalize().toString(),
            "sourceSha256", observerSource == null ? null : sha256(observerSource),
            "bundleSha256", sha256Tree(observerBundle),
            "connectivityAuthority",
                "Logisim-ITA CircuitWires.BundleMap and WireThread from the exact runtime",
            "doesNotInfer", Arrays.asList(
                "geometric crossing connectivity",
                "cross-revision identity",
                "dynamic instance traces",
                "circuit correctness"
            )
        );
        Map<String, Object> revision = obj(
            "artifactPath", artifact.toString(),
            "artifactSha256", sha256(artifact)
        );
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
            "region", region == null ? null : region.toJson(),
            "instancePaths", paths,
            "components", components,
            "wires", nets.wiresJson(),
            "wireBundles", nets.bundlesJson(),
            "bitNets", nets.netsJson(),
            "stateElements", states,
            "tunnels", tunnels,
            "spatialAdjacency", spatial,
            "widthIncompatibilities", widthErrors
        );

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
        return compactMode ? compactProjection(full) : full;
    }

    private Map<String, Object> compactProjection(Map<String, Object> full) {
        if (region == null) {
            throw new IllegalStateException("compact projection requires a region");
        }

        Map<String, Object> fullFocus = asObject(full.get("focus"));
        List<Object> allComponents = asList(fullFocus.get("components"));
        List<Object> allNets = asList(fullFocus.get("bitNets"));
        List<Object> allSpatial = asList(fullFocus.get("spatialAdjacency"));
        Map<String, Map<String, Object>> componentsById =
            new LinkedHashMap<String, Map<String, Object>>();
        for (Object value : allComponents) {
            Map<String, Object> component = asObject(value);
            componentsById.put((String) component.get("componentId"), component);
        }

        Set<String> regionIds = new LinkedHashSet<String>();
        for (Map.Entry<String, Map<String, Object>> entry : componentsById.entrySet()) {
            if (Boolean.TRUE.equals(entry.getValue().get("inRegion"))) {
                regionIds.add(entry.getKey());
            }
        }

        Set<String> relevantNetIds = new LinkedHashSet<String>();
        for (String componentId : regionIds) {
            collectComponentNetIds(componentsById.get(componentId), relevantNetIds);
        }

        Map<String, Map<String, Object>> netsById =
            new LinkedHashMap<String, Map<String, Object>>();
        Set<String> electricalIds = new LinkedHashSet<String>();
        int relatedContacts = 0;
        for (Object value : allNets) {
            Map<String, Object> net = asObject(value);
            String netId = (String) net.get("netId");
            netsById.put(netId, net);
            if (!relevantNetIds.contains(netId)) continue;
            for (Object contactValue : asList(net.get("contacts"))) {
                Map<String, Object> contact = asObject(contactValue);
                electricalIds.add((String) contact.get("componentId"));
                relatedContacts++;
            }
        }

        Set<String> spatialIds = new LinkedHashSet<String>();
        List<Object> compactSpatial = new ArrayList<Object>();
        for (Object value : allSpatial) {
            Map<String, Object> adjacency = asObject(value);
            String componentId = (String) adjacency.get("componentId");
            if (!regionIds.contains(componentId)) continue;
            List<Object> nearest = asList(adjacency.get("nearest"));
            List<Object> selectedNearest = new ArrayList<Object>();
            int limit = Math.min(COMPACT_SPATIAL_NEIGHBORS_PER_REGION_COMPONENT, nearest.size());
            for (int i = 0; i < limit; i++) {
                Map<String, Object> neighbor = asObject(nearest.get(i));
                spatialIds.add((String) neighbor.get("componentId"));
                selectedNearest.add(neighbor);
            }
            compactSpatial.add(obj(
                "componentId", componentId,
                "nearest", selectedNearest
            ));
        }

        Set<String> emittedIds = new LinkedHashSet<String>();
        emittedIds.addAll(regionIds);
        emittedIds.addAll(electricalIds);
        emittedIds.addAll(spatialIds);

        List<Object> compactComponents = new ArrayList<Object>();
        int omittedPresentationAttributes = 0;
        int omittedAdjacentNetBits = 0;
        for (String componentId : sortedStrings(emittedIds)) {
            Map<String, Object> component = componentsById.get(componentId);
            if (component == null) continue;
            List<String> reasons = new ArrayList<String>();
            if (regionIds.contains(componentId)) reasons.add("region-intersection");
            if (electricalIds.contains(componentId)) reasons.add("shared-region-bit-net");
            if (spatialIds.contains(componentId)) reasons.add("spatial-neighbor");

            Map<String, Object> compactAttributes = new LinkedHashMap<String, Object>();
            for (Object attributeValue : asList(component.get("attributes"))) {
                Map<String, Object> attribute = asObject(attributeValue);
                String name = (String) attribute.get("name");
                if ("labelfont".equals(name) || "labelcolor".equals(name)) {
                    omittedPresentationAttributes++;
                    continue;
                }
                compactAttributes.put(name, attribute.get("standard"));
            }

            List<Object> compactEnds = new ArrayList<Object>();
            for (Object endValue : asList(component.get("ends"))) {
                Map<String, Object> end = asObject(endValue);
                List<Object> keptBits = new ArrayList<Object>();
                int omitted = 0;
                for (Object bitValue : asList(end.get("netBits"))) {
                    Map<String, Object> bit = asObject(bitValue);
                    if (relevantNetIds.contains(bit.get("netId"))) keptBits.add(bit);
                    else omitted++;
                }
                omittedAdjacentNetBits += omitted;
                compactEnds.add(obj(
                    "index", end.get("index"),
                    "location", end.get("location"),
                    "width", end.get("width"),
                    "direction", end.get("direction"),
                    "semanticRole", end.get("semanticRole"),
                    "runtimeTooltip", end.get("runtimeTooltip"),
                    "relevantNetBits", keptBits,
                    "omittedNetBitCount", omitted
                ));
            }

            compactComponents.add(obj(
                "componentId", componentId,
                "inclusionReasons", reasons,
                "selector", component.get("selector"),
                "factoryName", component.get("factoryName"),
                "factoryClass", component.get("factoryClass"),
                "factoryProvenance", component.get("factoryProvenance"),
                "location", component.get("location"),
                "bounds", component.get("bounds"),
                "inRegion", component.get("inRegion"),
                "attributes", compactAttributes,
                "ends", compactEnds,
                "subcircuit", component.get("subcircuit")
            ));
        }

        List<Object> compactNets = new ArrayList<Object>();
        Set<String> relevantBundleIds = new LinkedHashSet<String>();
        for (String netId : sortedStrings(relevantNetIds)) {
            Map<String, Object> net = netsById.get(netId);
            if (net == null) continue;
            compactNets.add(net);
            for (Object sliceValue : asList(net.get("slices"))) {
                relevantBundleIds.add((String) asObject(sliceValue).get("bundleId"));
            }
        }

        List<Object> compactBundles = new ArrayList<Object>();
        for (Object value : asList(fullFocus.get("wireBundles"))) {
            Map<String, Object> bundle = asObject(value);
            if (relevantBundleIds.contains(bundle.get("bundleId"))) compactBundles.add(bundle);
        }
        List<Object> compactWires = new ArrayList<Object>();
        for (Object value : asList(fullFocus.get("wires"))) {
            Map<String, Object> wire = asObject(value);
            if (relevantBundleIds.contains(wire.get("bundleId"))) compactWires.add(wire);
        }

        List<Object> compactStates = new ArrayList<Object>();
        for (Object value : asList(fullFocus.get("stateElements"))) {
            Map<String, Object> state = asObject(value);
            if (!emittedIds.contains(state.get("componentId"))) continue;
            if (regionIds.contains(state.get("componentId"))
                || containsRelevantStateNet(state, relevantNetIds)) {
                compactStates.add(state);
            }
        }
        List<Object> compactTunnels = new ArrayList<Object>();
        for (Object value : asList(fullFocus.get("tunnels"))) {
            Map<String, Object> tunnel = asObject(value);
            if (emittedIds.contains(tunnel.get("componentId"))
                && containsRelevantBits(asList(tunnel.get("netBits")), relevantNetIds)) {
                compactTunnels.add(tunnel);
            }
        }

        List<Object> compactCircuits = relevantCircuitSummaries(
            asObject(full.get("project")), asList(fullFocus.get("instancePaths"))
        );
        Map<String, Object> fullProject = asObject(full.get("project"));
        Map<String, Object> compactProject = obj(
            "name", fullProject.get("name"),
            "mainCircuit", fullProject.get("mainCircuit"),
            "runtimeLoaderStdout", fullProject.get("runtimeLoaderStdout"),
            "loaderMessages", fullProject.get("loaderMessages"),
            "libraries", fullProject.get("libraries"),
            "relevantCircuits", compactCircuits
        );

        List<Object> compactUnknowns = new ArrayList<Object>(asList(full.get("unknowns")));
        compactUnknowns.add(obj(
            "code", "COMPACT_ONE_HOP_PROJECTION",
            "claim", "The public view includes region components, their bit-net contacts, and two nearest spatial neighbors per region component. It does not recursively expand adjacent components' other nets.",
            "omittedCircuitComponents", allComponents.size() - emittedIds.size(),
            "omittedCircuitBitNets", allNets.size() - relevantNetIds.size()
        ));
        compactUnknowns.add(obj(
            "code", "PUBLIC_ARTIFACT_TRUST_BOUNDARY",
            "claim", "Compact mode projects its input; it does not detect or remove private harness or golden circuits. The input artifact must already be public and sanitized."
        ));

        Map<String, Object> projectionCoverage = obj(
            "regionComponents", regionIds.size(),
            "electricalContactComponents", electricalIds.size(),
            "spatialNeighborComponents", spatialIds.size(),
            "emittedComponents", emittedIds.size(),
            "relevantBitNets", compactNets.size(),
            "relevantNetContacts", relatedContacts,
            "relevantWireBundles", compactBundles.size(),
            "relevantWires", compactWires.size(),
            "relatedStateElements", compactStates.size(),
            "relatedTunnels", compactTunnels.size(),
            "omittedComponents", allComponents.size() - emittedIds.size(),
            "omittedBitNets", allNets.size() - relevantNetIds.size(),
            "omittedAdjacentNetBits", omittedAdjacentNetBits,
            "omittedPresentationAttributes", omittedPresentationAttributes,
            "spatialNeighborLimitPerRegionComponent",
                COMPACT_SPATIAL_NEIGHBORS_PER_REGION_COMPONENT
        );
        Map<String, Object> componentSets = obj(
            "region", sortedStrings(regionIds),
            "electricalContacts", sortedStrings(electricalIds),
            "spatialNeighbors", sortedStrings(spatialIds),
            "emitted", sortedStrings(emittedIds)
        );
        Map<String, Object> projection = obj(
            "circuit", fullFocus.get("circuit"),
            "circuitBounds", fullFocus.get("bounds"),
            "region", fullFocus.get("region"),
            "selectionRules", Arrays.asList(
                "all components whose runtime bounds intersect the requested region",
                "all component contacts on bit-nets touched by region component ends",
                "up to two closest components by bounds gap for each region component",
                "only bit-nets touched directly by region component ends"
            ),
            "componentSets", componentSets,
            "components", compactComponents,
            "bitNets", compactNets,
            "wireBundles", compactBundles,
            "wires", compactWires,
            "stateElements", compactStates,
            "tunnels", compactTunnels,
            "spatialAdjacency", compactSpatial,
            "instancePaths", fullFocus.get("instancePaths"),
            "widthIncompatibilities", fullFocus.get("widthIncompatibilities")
        );
        return obj(
            "schema", "vibe-logisim.experiment-001.public-projection/v0",
            "mode", "compact-public",
            "observer", full.get("observer"),
            "revision", full.get("revision"),
            "runtime", full.get("runtime"),
            "project", compactProject,
            "projection", projection,
            "coverage", obj(
                "sourceLedger", full.get("coverage"),
                "projection", projectionCoverage
            ),
            "unknowns", compactUnknowns
        );
    }

    private static List<Object> relevantCircuitSummaries(
        Map<String, Object> project, List<Object> paths
    ) {
        Set<String> names = new LinkedHashSet<String>();
        for (Object pathValue : paths) {
            Map<String, Object> path = asObject(pathValue);
            names.add((String) path.get("root"));
            for (Object stepValue : asList(path.get("steps"))) {
                Map<String, Object> step = asObject(stepValue);
                names.add((String) step.get("parentCircuit"));
                names.add((String) step.get("targetCircuit"));
            }
        }
        List<Object> result = new ArrayList<Object>();
        for (Object circuitValue : asList(project.get("circuits"))) {
            Map<String, Object> circuit = asObject(circuitValue);
            if (names.contains(circuit.get("name"))) result.add(circuit);
        }
        return result;
    }

    private static void collectComponentNetIds(
        Map<String, Object> component, Set<String> destination
    ) {
        for (Object endValue : asList(component.get("ends"))) {
            for (Object bitValue : asList(asObject(endValue).get("netBits"))) {
                destination.add((String) asObject(bitValue).get("netId"));
            }
        }
    }

    private static boolean containsRelevantStateNet(
        Map<String, Object> state, Set<String> relevantNetIds
    ) {
        for (Object portValue : asList(state.get("ports"))) {
            if (containsRelevantBits(asList(asObject(portValue).get("netBits")), relevantNetIds)) {
                return true;
            }
        }
        return false;
    }

    private static boolean containsRelevantBits(
        List<Object> bits, Set<String> relevantNetIds
    ) {
        for (Object bitValue : bits) {
            if (relevantNetIds.contains(asObject(bitValue).get("netId"))) return true;
        }
        return false;
    }

    private static List<String> sortedStrings(Collection<String> values) {
        List<String> result = new ArrayList<String>(values);
        Collections.sort(result);
        return result;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asObject(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> asList(Object value) {
        return (List<Object>) value;
    }

    private List<Object> observeComponents(NetIndex nets) {
        List<Component> ordered = sortedComponents(focus);
        List<Object> result = new ArrayList<Object>();
        for (Component component : ordered) {
            coverage.components++;
            String id = focusIds.get(component);
            Bounds componentBounds = component.getBounds();
            boolean inRegion = region == null || region.intersects(componentBounds);
            if (inRegion) coverage.componentsInRegion++;

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
                ends.add(obj(
                    "index", index,
                    "location", location(end.getLocation()),
                    "width", width < 0 ? null : width,
                    "direction", endDirection(end),
                    "exclusive", end.isExclusive(),
                    "semanticRole", role,
                    "runtimeTooltip", emptyToNull(tooltip),
                    "netBits", netBits,
                    "localOccupants", focus.getComponents(end.getLocation()).size()
                ));
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
                "inRegion", inRegion,
                "attributes", attributes(component.getAttributeSet()),
                "ends", ends,
                "subcircuit", component.getFactory() instanceof SubcircuitFactory
                    ? ((SubcircuitFactory) component.getFactory()).getSubcircuit().getName()
                    : null
            ));
        }
        return result;
    }

    private List<Object> observeStateElements(NetIndex nets) {
        List<Object> result = new ArrayList<Object>();
        // The course fork has a different Register port layout. Its raw ends
        // remain observable; do not attach the newer fork's state-role overlay.
        if (courseRuntime) return result;
        for (Component component : sortedComponents(focus)) {
            String factoryClass = component.getFactory().getClass().getName();
            if (!"com.cburch.logisim.std.memory.Register".equals(factoryClass)) continue;
            coverage.knownStateElements++;
            List<Object> ports = new ArrayList<Object>();
            for (int i = 0; i < component.getEnds().size(); i++) {
                EndData end = component.getEnd(i);
                ports.add(obj(
                    "role", registerRole(i),
                    "endIndex", i,
                    "netBits", nets.netBits(component, i, end)
                ));
            }
            result.add(obj(
                "componentId", focusIds.get(component),
                "kind", "Register",
                "roleMappingProfile", "Logisim-ITA 2.16.2.2 Register port order",
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

    private List<Object> observeSpatialAdjacency() {
        if (region == null) return Collections.emptyList();
        List<Component> all = sortedComponents(focus);
        List<Object> result = new ArrayList<Object>();
        for (Component source : all) {
            if (!region.intersects(source.getBounds())) continue;
            final Component sourceFinal = source;
            List<Component> neighbors = new ArrayList<Component>(all);
            neighbors.remove(source);
            Collections.sort(neighbors, Comparator
                .comparingInt((Component other) -> boundsGap(sourceFinal.getBounds(), other.getBounds()))
                .thenComparing(other -> focusIds.get(other)));
            List<Object> nearest = new ArrayList<Object>();
            for (int i = 0; i < Math.min(5, neighbors.size()); i++) {
                Component other = neighbors.get(i);
                nearest.add(obj(
                    "componentId", focusIds.get(other),
                    "boundsGap", boundsGap(source.getBounds(), other.getBounds()),
                    "relative", relativePosition(source.getBounds(), other.getBounds())
                ));
            }
            result.add(obj(
                "componentId", focusIds.get(source),
                "nearest", nearest
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
            "claim", courseRuntime
                ? "Stateful role overlays are not yet calibrated for this course runtime; raw ends and connectivity remain available."
                : "Only the exact Register factory is classified as a state element in this task adapter; arbitrary external stateful factories are not inferred."
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

    private static Map<Component, String> assignComponentIds(Circuit circuit) {
        Map<Component, String> result = new IdentityHashMap<Component, String>();
        int index = 0;
        for (Component component : sortedComponents(circuit)) {
            result.put(component, String.format(Locale.ROOT, "c%03d", index++));
        }
        return result;
    }

    private static List<Component> sortedComponents(Circuit circuit) {
        List<Component> result = new ArrayList<Component>(circuit.getNonWires());
        Collections.sort(result, COMPONENT_ORDER);
        return result;
    }

    private static String semanticRole(Component component, int index) {
        String className = component.getFactory().getClass().getName();
        String factoryName = component.getFactory().getName();
        int endCount = component.getEnds().size();
        if (component.getFactory() instanceof Tunnel) return "tunnel:" + componentLabel(component);
        if (component.getFactory() == Pin.FACTORY) {
            EndData end = component.getEnd(index);
            return end.isOutput() && !end.isInput() ? "circuitInput"
                : end.isInput() && !end.isOutput() ? "circuitOutput" : "circuitInOut";
        }
        if (courseRuntime) return null;
        if ("com.cburch.logisim.std.memory.Register".equals(className)) {
            return registerRole(index);
        }
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

    private static String registerRole(int index) {
        String[] roles = { "q", "d", "clock", "clear", "enable", "chipSelect", "preset" };
        return index >= 0 && index < roles.length ? roles[index] : "unknown";
    }

    private static boolean booleanAttribute(AttributeSet attributes, String name) {
        Attribute<?> attribute = attributes.getAttribute(name);
        if (attribute == null) return false;
        Object value = attributes.getValue(attribute);
        return Boolean.TRUE.equals(value) || "true".equalsIgnoreCase(String.valueOf(value));
    }

    private static Instance instanceOrNull(Component component) {
        try {
            return Instance.getInstanceFor(component);
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static String componentLabel(Component component) {
        AttributeSet attributes = component.getAttributeSet();
        if (!attributes.containsAttribute(StdAttr.LABEL)) return null;
        return emptyToNull(attributes.getValue(StdAttr.LABEL));
    }

    private static List<Object> attributes(AttributeSet attributes) {
        List<Object> result = new ArrayList<Object>();
        for (Attribute<?> attribute : attributes.getAttributes()) {
            Object value = attributes.getValue(attribute);
            String standard;
            String display;
            try {
                standard = standardString(attribute, value);
            } catch (Throwable error) {
                standard = String.valueOf(value);
            }
            try {
                display = displayString(attribute, value);
            } catch (Throwable error) {
                display = standard;
            }
            result.add(obj(
                "name", attribute.getName(),
                "standard", standard,
                "display", display,
                "displayName", attribute.getDisplayName(),
                "readOnly", attributes.isReadOnly(attribute) || !attributes.isToSave(attribute),
                "options", attributeOptions(attributes, attribute),
                "valueClass", value == null ? null : value.getClass().getName()
            ));
        }
        return result;
    }

    @SuppressWarnings({ "unchecked", "rawtypes" })
    private static List<Object> attributeOptions(AttributeSet attributes, Attribute attribute) {
        List<Object> options = new ArrayList<Object>();
        // Consult the native editor model, never infer enums from current CPU fields.
        try {
            List<NativeAttributeAdapter.Choice> choices=NativeAttributeAdapter.choices(attributes,attribute);
            if(choices.size()<=128)for(NativeAttributeAdapter.Choice choice:choices) {
                options.add(obj("value",choice.value,"label",choice.label));
            }
        } catch (Throwable unavailable) { options.clear(); }
        return options;
    }

    @SuppressWarnings({ "unchecked", "rawtypes" })
    private static String standardString(Attribute attribute, Object value) {
        return attribute.toStandardString(value);
    }

    @SuppressWarnings({ "unchecked", "rawtypes" })
    private static String displayString(Attribute attribute, Object value) {
        return attribute.toDisplayString(value);
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

    private static String safeDisplayName(ComponentFactory factory) {
        try {
            return factory.getDisplayName();
        } catch (Throwable error) {
            return factory.getName();
        }
    }

    private static String endDirection(EndData end) {
        if (end.isInput() && end.isOutput()) return "inout";
        if (end.isInput()) return "input";
        if (end.isOutput()) return "output";
        return "none";
    }

    private static int width(BitWidth width) {
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

    private static int boundsGap(Bounds a, Bounds b) {
        int ax1 = a.getX();
        int ay1 = a.getY();
        int ax2 = ax1 + a.getWidth();
        int ay2 = ay1 + a.getHeight();
        int bx1 = b.getX();
        int by1 = b.getY();
        int bx2 = bx1 + b.getWidth();
        int by2 = by1 + b.getHeight();
        int dx = Math.max(0, Math.max(ax1 - bx2, bx1 - ax2));
        int dy = Math.max(0, Math.max(ay1 - by2, by1 - ay2));
        return dx + dy;
    }

    private static String relativePosition(Bounds source, Bounds other) {
        int sx = source.getX() + source.getWidth() / 2;
        int sy = source.getY() + source.getHeight() / 2;
        int ox = other.getX() + other.getWidth() / 2;
        int oy = other.getY() + other.getHeight() / 2;
        int dx = ox - sx;
        int dy = oy - sy;
        if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? "left" : "right";
        if (dy != 0) return dy < 0 ? "above" : "below";
        return "overlap";
    }

    private static Path requiredPropertyPath(String name) throws IOException {
        String value = System.getProperty(name);
        if (value == null || value.isEmpty()) {
            throw new IllegalArgumentException("missing system property: " + name);
        }
        return new File(value).getCanonicalFile().toPath();
    }

    private static Path optionalPropertyPath(String name) throws IOException {
        String value = System.getProperty(name);
        if (value == null || value.isEmpty()) return null;
        return new File(value).getCanonicalFile().toPath();
    }

    private static String sha256(Path path) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[64 * 1024];
        java.io.InputStream input = Files.newInputStream(path);
        try {
            for (;;) {
                int count = input.read(buffer);
                if (count < 0) break;
                digest.update(buffer, 0, count);
            }
        } finally {
            input.close();
        }
        return hex(digest.digest());
    }

    private static String sha256Tree(Path root) throws Exception {
        if (Files.isRegularFile(root)) return sha256(root);
        if (!Files.isDirectory(root)) {
            throw new IllegalArgumentException("missing observer bundle: " + root);
        }
        List<Path> files = new ArrayList<Path>();
        Stream<Path> stream = Files.walk(root);
        try {
            stream.filter(Files::isRegularFile).forEach(files::add);
        } finally {
            stream.close();
        }
        Collections.sort(files, Comparator.comparing(path -> root.relativize(path).toString()));
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] zero = new byte[] { 0 };
        byte[] buffer = new byte[64 * 1024];
        for (Path file : files) {
            String relative = root.relativize(file).toString().replace(File.separatorChar, '/');
            digest.update(relative.getBytes(StandardCharsets.UTF_8));
            digest.update(zero);
            java.io.InputStream input = Files.newInputStream(file);
            try {
                for (;;) {
                    int count = input.read(buffer);
                    if (count < 0) break;
                    digest.update(buffer, 0, count);
                }
            } finally {
                input.close();
            }
            digest.update(zero);
        }
        return hex(digest.digest());
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

    private static String emptyToNull(String value) {
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

    private static final class Options {
        final boolean compact;
        final String artifact;
        final String circuit;
        final Region region;

        Options(boolean compact, String artifact, String circuit, Region region) {
            this.compact = compact;
            this.artifact = artifact;
            this.circuit = circuit;
            this.region = region;
        }

        static Options parse(String[] args) {
            int offset = 0;
            boolean compact = false;
            if (args.length > 0 && "--compact".equals(args[0])) {
                compact = true;
                offset = 1;
            } else if (args.length > 0 && "--full".equals(args[0])) {
                offset = 1;
            }
            int remaining = args.length - offset;
            if (remaining != 2 && remaining != 6) {
                throw usage();
            }
            Region region = remaining == 6
                ? new Region(
                    Integer.parseInt(args[offset + 2]), Integer.parseInt(args[offset + 3]),
                    Integer.parseInt(args[offset + 4]), Integer.parseInt(args[offset + 5]))
                : null;
            if (compact && region == null) {
                throw new IllegalArgumentException("--compact requires X Y WIDTH HEIGHT");
            }
            return new Options(compact, args[offset], args[offset + 1], region);
        }

        private static IllegalArgumentException usage() {
            return new IllegalArgumentException(
                "usage: ExactRuntimeObserver [--full] ARTIFACT.circ CIRCUIT [X Y WIDTH HEIGHT]\n"
                    + "   or: ExactRuntimeObserver --compact ARTIFACT.circ CIRCUIT X Y WIDTH HEIGHT"
            );
        }
    }

    private static final class Region {
        final int x;
        final int y;
        final int width;
        final int height;

        Region(int x, int y, int width, int height) {
            this.x = x;
            this.y = y;
            this.width = width;
            this.height = height;
        }

        boolean intersects(Bounds bounds) {
            return bounds.getX() + bounds.getWidth() >= x
                && bounds.getY() + bounds.getHeight() >= y
                && bounds.getX() <= x + width
                && bounds.getY() <= y + height;
        }

        Map<String, Object> toJson() {
            return obj("x", x, "y", y, "width", width, "height", height);
        }
    }

    private static final class Coverage {
        int components;
        int componentsInRegion;
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
                "componentsInRegion", componentsInRegion,
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

    private static final class BundleRecord {
        final WireBundle bundle;
        String id;
        final List<String> wireIds = new ArrayList<String>();

        BundleRecord(WireBundle bundle) {
            this.bundle = bundle;
        }
    }

    private static final class NetRecord {
        final WireThread root;
        final String pointKey;
        String id;
        final List<Object> contacts = new ArrayList<Object>();

        NetRecord(WireThread root, String pointKey) {
            this.root = root;
            this.pointKey = pointKey;
        }
    }

    private static final class NetIndex {
        final Circuit circuit;
        final Map<Component, String> componentIds;
        final Coverage coverage;
        final List<Object> unknowns;
        final Map<WireBundle, BundleRecord> bundles =
            new IdentityHashMap<WireBundle, BundleRecord>();
        final Map<WireThread, NetRecord> threadNets =
            new IdentityHashMap<WireThread, NetRecord>();
        final Map<String, NetRecord> pointNets = new LinkedHashMap<String, NetRecord>();
        final Map<String, String> endBitNet = new HashMap<String, String>();
        final List<Wire> wires;
        final Map<Wire, String> wireIds = new IdentityHashMap<Wire, String>();

        NetIndex(
            Circuit circuit, Map<Component, String> componentIds,
            Coverage coverage, List<Object> unknowns
        ) {
            this.circuit = circuit;
            this.componentIds = componentIds;
            this.coverage = coverage;
            this.unknowns = unknowns;
            // Loaded files may repeat the same interned native Wire. One
            // selectable object must have one ID and one geometry record.
            this.wires = new ArrayList<Wire>(new java.util.LinkedHashSet<Wire>(circuit.getWires()));
            Collections.sort(this.wires, WIRE_ORDER);
            for (int i = 0; i < this.wires.size(); i++) {
                wireIds.put(this.wires.get(i), String.format(Locale.ROOT, "w%03d", i));
            }
        }

        void compute() {
            circuit.wires.ensureComputed();
            for (Wire wire : wires) {
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
            for (Wire wire : wires) {
                WireBundle bundle = circuit.wires.getWireBundle(wire.getEnd0());
                BundleRecord record = bundles.get(bundle);
                if (record != null) record.wireIds.add(wireIds.get(wire));
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
                        net.contacts.add(obj(
                            "componentId", componentId,
                            "endIndex", endIndex,
                            "bit", bit,
                            "location", location(end.getLocation()),
                            "direction", endDirection(end),
                            "semanticRole", semanticRole(component, endIndex)
                        ));
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

        List<Object> wiresJson() {
            List<Object> result = new ArrayList<Object>();
            for (Wire wire : wires) {
                WireBundle bundle = circuit.wires.getWireBundle(wire.getEnd0());
                BundleRecord record = bundles.get(bundle == null ? null : bundle.find());
                result.add(obj(
                    "wireId", wireIds.get(wire),
                    "from", location(wire.getEnd0()),
                    "to", location(wire.getEnd1()),
                    "bundleId", record == null ? null : record.id
                ));
            }
            return result;
        }

        List<Object> bundlesJson() {
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
                result.add(obj(
                    "bundleId", record.id,
                    "valid", bundle.isValid(),
                    "width", width(bundle.getWidth()),
                    "widthDeterminant", bundle.getWidthDeterminant() == null
                        ? null : location(bundle.getWidthDeterminant()),
                    "points", points,
                    "wireIds", record.wireIds,
                    "bitNets", bitNets
                ));
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

    private static final class Json {
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

        private static void string(String value, StringBuilder out) {
            out.append('"');
            for (int i = 0; i < value.length(); i++) {
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
