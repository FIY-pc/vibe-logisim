"""arrange_candidate: re-place and physically wire a circuit in one operation.

Routing is a global optimisation. Asking a model to place and route one net
per tool call makes every later net thread through the leftovers of earlier
ones, and in practice the model gives up and hand-writes a router that does
not know Logisim's rules. This tool makes "arrange" a single deterministic
compilation step with a structural proof:

  observe -> classify nets -> layered placement -> ordered global routing ->
  emit -> re-observe -> netlist equivalence (every {port} group sharing a net
  is identical before/after; constants compared per driven port) -> candidate.

The model chooses parameters (what stays a tunnel, what is pinned, spacing)
and judges the rendered result; it never chooses wire geometry.
"""
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import re
import shutil
import uuid
import xml.etree.ElementTree as ET

from studio.domain.schematic_layout import SchematicLayout
from studio.domain.tool_errors import CircuitToolError


def _attr(component, name):
    for item in component["attributes"]:
        if item.get("name") == name:
            return item.get("value", item.get("standard"))
    return None


def _identity_map(xml_text, circuit_name):
    """(original loc, factory) -> ordinal, for non-tunnel, non-constant parts."""
    root = ET.fromstring(xml_text)
    c = next(x for x in root.findall("circuit") if x.get("name") == circuit_name)
    identity, k = {}, 0
    for el in c.findall("comp"):
        if el.get("name") in ("Tunnel", "Constant"):
            continue
        x, y = map(int, re.findall(r"-?\d+", el.get("loc")))
        identity[((x, y), el.get("name"))] = k
        k += 1
    return identity


def netlist_signature(focus, identity_of_loc, moved_map=None):
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
                val = _attr(comp, "value")
                const_driven.setdefault(key, set()).add((str(val).lower(), e["width"]))
            elif comp["factoryName"] != "Tunnel":
                groups.setdefault(key, set()).add((ident[comp["componentId"]], e["index"]))
    result = set()
    for key, ports in groups.items():
        consts = frozenset(const_driven.get(key, ()))
        if consts:
            for port in ports:
                result.add((frozenset([port]), consts))
        elif len(ports) >= 2:
            result.add((frozenset(ports), consts))
    return result


def readability(xml_text, circuit_name):
    root = ET.fromstring(xml_text)
    c = next(x for x in root.findall("circuit") if x.get("name") == circuit_name)
    comps = c.findall("comp")
    wires = []
    for w in c.findall("wire"):
        a = tuple(map(int, re.findall(r"-?\d+", w.get("from"))))
        b = tuple(map(int, re.findall(r"-?\d+", w.get("to"))))
        wires.append((a, b))
    xs = [int(re.findall(r"-?\d+", x.get("loc"))[0]) for x in comps]
    ys = [int(re.findall(r"-?\d+", x.get("loc"))[1]) for x in comps]
    horizontal = [(min(a[0], b[0]), max(a[0], b[0]), a[1]) for a, b in wires if a[1] == b[1]]
    vertical = [(min(a[1], b[1]), max(a[1], b[1]), a[0]) for a, b in wires if a[0] == b[0]]
    crossings = sum(1 for x1, x2, y in horizontal for y1, y2, x in vertical if x1 < x < x2 and y1 < y < y2)
    return {
        "components": len(comps),
        "tunnels": sum(1 for x in comps if x.get("name") == "Tunnel"),
        "wireSegments": len(wires),
        "wireLength": sum(abs(a[0] - b[0]) + abs(a[1] - b[1]) for a, b in wires),
        "crossings": crossings,
        "extent": {"width": (max(xs) - min(xs)) if xs else 0, "height": (max(ys) - min(ys)) if ys else 0},
    }


def arrange_candidate(workbench, args):
    w, name = workbench.workspace, args["circuit"]
    parent_id = args.get("candidateId")
    parent_dir, parent = workbench._metadata(parent_id) if parent_id else (None, None)
    if parent_dir:
        before = (parent_dir / "artifact.circ").read_bytes()
    else:
        with w.observation_artifact() as source:
            before = source.read_bytes()
    if args.get("artifactSha256") and hashlib.sha256(before).hexdigest() != args["artifactSha256"]:
        raise CircuitToolError("STALE_REVISION", "整理所引用的电路已变化",
                               hint="使用同一次 inspect_circuit 的 artifactSha256。")
    candidate_id = "candidate-" + uuid.uuid4().hex[:16]
    directory = w.state_root / "candidates" / candidate_id
    directory.mkdir(parents=True)
    artifact = directory / "artifact.circ"
    try:
        artifact.write_bytes(before)
        for filename, data in w.package.contents.items():
            (directory / filename).write_bytes(data)
        before_full = w.observer.run_full(artifact, name)
        before_focus = before_full["focus"]
        before_xml = before.decode("utf-8")
        identity = _identity_map(before_xml, name)
        before_sig = netlist_signature(before_focus, identity)

        options = {
            "pinned_ids": list(args.get("pinnedComponentIds") or []),
            "keep_tunnels": list(args.get("keepTunnels") or []),
            "localise_constants": args.get("localiseConstants", True),
        }
        if args.get("panelBelowY") is not None:
            options["panel_below_y"] = int(args["panelBelowY"])
        layout = SchematicLayout(before_xml, name, before_focus, **options)
        if args.get("columnGap") is not None:
            layout.column_gap = int(args["columnGap"])
        if args.get("maxLayerSpan") is not None:
            layout.max_layer_span = int(args["maxLayerSpan"])
        after_xml = layout.emit()
        artifact.write_text(after_xml, encoding="utf-8")

        after_full = w.observer.run_full(artifact, name, directory / (hashlib.sha256(name.encode()).hexdigest() + ".png"))
        after_focus = after_full["focus"]
        orig_of = {}
        for comp in before_focus["components"]:
            dx, dy = layout.placement.get(comp["componentId"], (0, 0))
            orig_of[((comp["location"]["x"] + dx, comp["location"]["y"] + dy), comp["factoryName"])] = (
                (comp["location"]["x"], comp["location"]["y"]), comp["factoryName"])
        moved_map = {}
        for comp in after_focus["components"]:
            k = ((comp["location"]["x"], comp["location"]["y"]), comp["factoryName"])
            if k in orig_of:
                moved_map[comp["componentId"]] = orig_of[k]
        after_sig = netlist_signature(after_focus, identity, moved_map)
        lost, gained = before_sig - after_sig, after_sig - before_sig
        invalid = [b["bundleId"] for b in after_focus.get("wireBundles", []) if not b.get("valid", True)]
        equivalent = not lost and not gained and not invalid
        if not equivalent:
            # Never publish a candidate whose connectivity differs from the source.
            shutil.rmtree(directory, ignore_errors=True)
            raise CircuitToolError(
                "ARRANGE_NOT_EQUIVALENT",
                f"整理结果的连通性与原电路不一致（丢失 {len(lost)} 组、新增 {len(gained)} 组、无效线束 {len(invalid)}），已丢弃。",
                hint="这是工具缺陷或电路含有工具未覆盖的结构；请把该电路与错误报告一起反馈，不要用手写脚本绕过。",
                context={"lost": len(lost), "gained": len(gained), "invalidBundles": len(invalid), "report": layout.report},
            )
        metrics_before = readability(before_xml, name)
        metrics_after = readability(after_xml, name)
        inherited = [c for c in parent.get("changes", []) if c["circuit"] != name] if parent else []
        inherited.append({
            "circuit": name,
            "componentsBefore": len(before_focus["components"]),
            "componentsAfter": len(after_focus["components"]),
            "wiresAfter": len(after_focus["wires"]),
            "render": after_full["render"],
            "coverage": after_full["coverage"],
            "arrangement": layout.report,
            "readabilityBefore": metrics_before,
            "readabilityAfter": metrics_after,
            "netlistEquivalent": True,
            "netGroupsCompared": len(before_sig),
            "interfacePreserved": True,
            "wireGeometryPreserved": False,
        })
        metadata = {
            "id": candidate_id, "projectId": w.history.record["id"], "baseRevisionId": w.revision_id,
            "parentCandidateId": parent_id, "artifactSha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
            "title": str(args.get("title") or "整理布局与连线")[:120], "changes": inherited,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "checks": [], "dependencies": [{"name": d["name"], "sha256": d["sha256"]} for d in w.package.dependencies],
            "interfacePreserved": True, "sourceUnchanged": True,
            "verification": "netlist-equivalence+native-reload",
        }
        workbench._save(directory, metadata)
        return {
            **metadata,
            "arrangement": layout.report,
            "readability": {"before": metrics_before, "after": metrics_after},
            "netlist": {"equivalent": True, "groupsCompared": len(before_sig), "invalidBundles": 0},
            "note": ("连通性已按网表逐端口组核对（不是仿真）。可用 render_circuit(candidateId) 看图，"
                     "调整 keepTunnels / pinnedComponentIds / columnGap 后重新整理；满意后 checkout_candidate 写回。"),
        }
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise
