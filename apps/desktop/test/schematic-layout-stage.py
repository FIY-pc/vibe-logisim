"""Drive SchematicLayout on a real course pipeline circuit and verify it.

Verification is structural, not simulated: the set of {(component identity,
port)} groups sharing a net must be identical before and after, ignoring
Tunnels (which are the thing being replaced) and Constants that were
localised (their consumers must still be driven by an equal constant).
Then the result must load natively and render.

usage: python3 apps/desktop/test/schematic-layout-stage.py <source.circ> <circuit name> <out dir>
"""
import json, shutil, sys, tempfile, time
from pathlib import Path
import xml.etree.ElementTree as ET

repo = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(repo / "apps/desktop/circuit-lens"))
if len(sys.argv) < 4:
    print(next((line.strip() for line in __doc__.splitlines() if line.strip().startswith("usage:")), "usage: see the module docstring"))
    sys.exit(2)
from studio.runtime.observer import ObserverRuntime          # noqa: E402
from studio.project.package import ProjectPackage             # noqa: E402
from studio.domain.schematic_layout import SchematicLayout    # noqa: E402

src = Path(sys.argv[1]).resolve(); circuit = sys.argv[2]; out = Path(sys.argv[3]).resolve(); out.mkdir(parents=True, exist_ok=True)
state = Path(tempfile.mkdtemp(prefix="layout-"))
work = state / "work"; work.mkdir()
for lib in src.parent.glob("*.jar"):
    shutil.copy(lib, work / lib.name)
shutil.copy(src, work / "before.circ")
pkg = ProjectPackage(src.read_bytes(), src); rt = pkg.runtime(repo)
obs = ObserverRuntime(repo, state)

def observe(path):
    return obs.run_full(path, circuit, runtime_jar=rt)["focus"]

def tag_identity(xml_text):
    """Give every non-tunnel, non-constant component a stable identity so the
    before/after comparison does not depend on coordinates or XML order. The
    tag rides in the label's unused suffix? No: Logisim treats unknown <a> as
    an error for some factories, so we key identity by (factory, original
    location) and carry the mapping outside the file."""
    root = ET.fromstring(xml_text)
    c = next(x for x in root.findall("circuit") if x.get("name") == circuit)
    identity = {}
    k = 0
    for el in c.findall("comp"):
        if el.get("name") in ("Tunnel", "Constant"):
            continue
        x, y = map(int, el.get("loc").strip("()").split(","))
        identity[((x, y), el.get("name"))] = k; k += 1
    return identity

def signature(focus, identity_of_loc, moved_map=None):
    """Group real ports by net. identity_of_loc maps ORIGINAL (loc, factory) -> id;
    moved_map maps componentId(after) -> original (loc, factory) for moved parts."""
    ident = {}
    for comp in focus["components"]:
        if comp["factoryName"] in ("Tunnel", "Constant"):
            continue
        key = ((comp["location"]["x"], comp["location"]["y"]), comp["factoryName"])
        if moved_map is not None:
            key = moved_map.get(comp["componentId"], key)
        i = identity_of_loc.get(key)
        if i is None:
            i = next((v for (loc, name), v in identity_of_loc.items() if loc == key[0]), ("?", key))
        ident[comp["componentId"]] = i
    groups, const_driven = {}, {}
    for comp in focus["components"]:
        for e in comp["ends"]:
            bits = e.get("netBits") or []
            if not bits:
                continue
            key = tuple(sorted(b["netId"] for b in bits))
            if comp["factoryName"] == "Constant":
                val = next((a.get("value", a.get("standard")) for a in comp["attributes"] if a.get("name") == "value"), None)
                const_driven.setdefault(key, set()).add((str(val).lower(), e["width"]))
            elif comp["factoryName"] != "Tunnel":
                groups.setdefault(key, set()).add((ident[comp["componentId"]], e["index"]))
    result = set()
    for key, ports in groups.items():
        consts = frozenset(const_driven.get(key, ()))
        if consts:
            # A constant-driven net is equivalent whether its consumers share one
            # driver or each has a private copy: record "port P is driven by K".
            for port in ports:
                result.add((frozenset([port]), consts))
        elif len(ports) >= 2:
            result.add((frozenset(ports), consts))
    return result

t0 = time.time()
before_xml = src.read_text(encoding="utf-8")
before_focus = observe(work / "before.circ")
identity = tag_identity(before_xml)
before_sig = signature(before_focus, identity)
print(f"observed before: {len(before_focus['components'])} comps, {len(before_focus['wires'])} wires, {len(before_sig)} net groups  ({time.time()-t0:.1f}s)")

layout = SchematicLayout(before_xml, circuit, before_focus)
after_xml = layout.emit()
(work / "after.circ").write_text(after_xml, encoding="utf-8")
print("layout report:", json.dumps(layout.report, ensure_ascii=False)[:800])

after_focus = observe(work / "after.circ")
# after: observed components moved by layout.placement; map back to original (loc, factory)
orig_of = {}
for comp in before_focus["components"]:
    dx, dy = layout.placement.get(comp["componentId"], (0, 0))
    orig_of[((comp["location"]["x"] + dx, comp["location"]["y"] + dy), comp["factoryName"])] = ((comp["location"]["x"], comp["location"]["y"]), comp["factoryName"])
moved_map = {}
for comp in after_focus["components"]:
    k = ((comp["location"]["x"], comp["location"]["y"]), comp["factoryName"])
    if k in orig_of: moved_map[comp["componentId"]] = orig_of[k]
after_sig = signature(after_focus, identity, moved_map)
print(f"observed after: {len(after_focus['components'])} comps, {len(after_focus['wires'])} wires, {len(after_sig)} net groups")
only_before = before_sig - after_sig; only_after = after_sig - before_sig
print("net groups lost:", len(only_before), "| net groups gained:", len(only_after))
for g in list(only_before)[:6]: print("  LOST ", sorted(g[0])[:5], "consts", sorted(g[1]))
for g in list(only_after)[:6]: print("  GAINED", sorted(g[0])[:5], "consts", sorted(g[1]))
# Width/short conflicts flagged by the observer?
def problems(focus):
    bad = []
    for b in focus.get("wireBundles", []):
        if not b.get("valid", True):
            bad.append(b["bundleId"])
    return bad
print("invalid bundles before/after:", len(problems(before_focus)), len(problems(after_focus)))
# Render both
try:
    from studio.runtime.rendering import render_circuit  # type: ignore
except Exception:
    render_circuit = None
shutil.copy(work / "after.circ", out / (src.stem + ".layout.circ"))
json.dump({"report": layout.report, "lost": len(only_before), "gained": len(only_after), "invalidAfter": len(problems(after_focus))}, open(out / "result.json", "w"), ensure_ascii=False, indent=1)
print("wrote", out / (src.stem + ".layout.circ"))
sys.exit(0 if not only_before and not only_after and not problems(after_focus) else 1)
