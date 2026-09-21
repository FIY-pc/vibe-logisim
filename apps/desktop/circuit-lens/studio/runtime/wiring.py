from __future__ import annotations


"""Physical bus wiring, with Logisim's bit-net partition as the acceptance authority.

The router proposes geometry. It never decides whether that geometry is electrically
correct: every existing and added port bit is compared after a fresh native load.
"""

from collections import defaultdict
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import shutil
import uuid
import xml.etree.ElementTree as ET

from studio.domain.routing import Router, Partition
from studio.domain.tool_errors import CircuitToolError
from studio.project.document import CircuitDocument
from studio.project.wire_selection import remove_wires
from studio.runtime.construction_parts import check_interfaces, prepare_parts


def point(value):
    return value["x"], value["y"]


def identity(component):
    return component["factoryName"], point(component["location"])


def translate_path(points, dx, dy):
    """Translate an existing orthogonal path without changing its topology."""
    if not isinstance(points, (list, tuple)) or len(points) < 2:
        raise ValueError("路径至少需要两个点")
    try:
        source = [(int(p["x"]), int(p["y"])) if isinstance(p, dict)
                  else (int(p[0]), int(p[1])) for p in points]
        dx, dy = int(dx), int(dy)
    except (KeyError, TypeError, ValueError, IndexError) as error:
        raise ValueError("路径点或位移无效") from error
    if any(p == q or (p[0] != q[0] and p[1] != q[1])
           for p, q in zip(source, source[1:])):
        raise ValueError("路径必须由不同的正交线段组成")
    if any(value % 10 for p in source for value in p) or dx % 10 or dy % 10:
        raise ValueError("路径和位移必须落在十像素网格上")
    return [(x + dx, y + dy) for x, y in source]



def ports(document):
    return {(identity(c), e["index"]): e
            for c in document["focus"]["components"] for e in c["ends"]}


def port_bits(end):
    width = end["width"]
    bits = {b["bit"]: b["netId"] for b in end["netBits"]}
    if (type(width) is not int or width < 1 or len(end["netBits"]) != width
            or set(bits) != set(range(width)) or any(net is None for net in bits.values())):
        raise ValueError("端口位宽或逐位网络未知，无法确认连接")
    return [bits[i] for i in range(width)]


def endpoint_context(ref, component, end):
    """Keep a width failure actionable without returning the whole observation."""
    return {
        **(ref if isinstance(ref, dict) else {}),
        "componentId": component.get("componentId"),
        "factory": component.get("factoryName"),
        "label": (component.get("selector") or {}).get("label"),
        "portName": end.get("runtimeTooltip"),
        "width": end.get("width"),
        "direction": end.get("direction"),
        "location": end.get("location"),
    }


def width_mismatch(connection, left, right):
    """Return a model-facing error for the common size-versus-width mistake."""
    return CircuitToolError(
        "PORT_WIDTH_MISMATCH",
        f"连接位宽不同: {connection.get('name')}: {left[1]['width']} ≠ {right[1]['width']}",
        hint="from 和 to 的端口 width 必须相同；width 是数据位宽，size 等几何属性不能代替它。",
        context={
            "connection": connection.get("name"),
            "from": endpoint_context(connection.get("from"), *left),
            "to": endpoint_context(connection.get("to"), *right),
        },
    )


def disconnected_ports(workspace, document, name, baseline, parts, directory):
    """Native relationships BEFORE placement can merge nets.

    Observe each added part alone, retaining its native internal bit ties (e.g.
    Splitter). Scope load-local net IDs separately from the baseline and other
    additions. Never recover this partition from the already fused prepared graph.
    """
    components = []
    def extend(observed, scope):
        copied = deepcopy(observed["focus"]["components"])
        for c in copied:
            for end in c["ends"]:
                if end["width"] is not None and end["width"] > 0:
                    port_bits(end)  # Validate before namespacing could hide a null net ID.
                for bit in end["netBits"]:
                    bit["netId"] = (scope, bit["netId"])
        components.extend(copied)
    extend(baseline, "baseline")
    isolated = document.circuit(name)
    for node in list(isolated):
        if node.tag in {"comp", "wire"}:
            isolated.remove(node)
    scratch = directory / "isolated-ports.circ"
    try:
        for alias, key, component, _ in parts:
            isolated.append(component)
            scratch.write_bytes(document.replace_circuit(isolated).data)
            observed = workspace.observer.run_full(scratch, name)
            if [identity(c) for c in observed["focus"]["components"]] != [key]:
                raise ValueError(f"无法独立确认新增部件端口: {alias}")
            extend(observed, key)
            isolated.remove(component)
    finally:
        scratch.unlink(missing_ok=True)
    return {"focus": {"components": components}}


def touching_ports(prepared, baseline, added_keys):
    """Find placement contacts before choosing a connectivity reference."""
    at = defaultdict(list)
    for key, end in ports(prepared).items():
        at[point(end["location"])].append((key, end))
    pairs = []
    for p, ends in at.items():
        if not any(key[0] in added_keys for key, _ in ends):
            continue
        # Exact segment containment also catches off-grid native wire geometry.
        for wire in baseline["focus"]["wires"]:
            a, b = point(wire["from"]), point(wire["to"])
            if ((a[0] == b[0] == p[0] and min(a[1], b[1]) <= p[1] <= max(a[1], b[1]))
                    or (a[1] == b[1] == p[1] and min(a[0], b[0]) <= p[0] <= max(a[0], b[0]))):
                raise ValueError(f"新增端口 {p} 接触已有导线；暂仅支持无导线占用的显式双端口贴合")
        if len(ends) == 1:
            continue
        if len(ends) != 2:
            raise ValueError(f"新增端口 {p} 出现未要求的端口接触；仅支持显式连接的两个端口贴合")
        pairs.append(tuple(key for key, _ in ends))
    return pairs


def contact_partition(reference, pairs, resolved):
    """Accept contacts only when their exact port pair was explicitly requested."""
    requested = {frozenset(((identity(ac), a["index"]), (identity(bc), b["index"])))
                 for _, (ac, a), (bc, b) in resolved}
    reference_ports = ports(reference)
    contacts = Partition()
    for pair in pairs:
        a, b = (reference_ports[key] for key in pair)
        p = point(a["location"])
        if frozenset(pair) not in requested:
            raise ValueError(f"新增端口 {p} 出现未要求的端口接触；仅支持显式连接的两个端口贴合")
        if a["width"] != b["width"]:
            raise ValueError(f"贴合端口连接位宽不同: {p}")
        for x, y in zip(port_bits(a), port_bits(b)):
            contacts.join(x, y)
    return contacts


def compare_partition(before, after, expected=None):
    """Equality of partitions, not equality of ephemeral observer net IDs."""
    old, new = ports(before), ports(after)
    expected = expected or Partition()
    forward, backward = {}, {}
    count = 0
    for key, end in old.items():
        other = new.get(key)
        if other is None or other["width"] != end["width"]:
            raise ValueError(f"端口或位宽被改变: {key}")
        if end["width"] is None or end["width"] < 1:
            continue  # Existing untyped probes are not evidence of a complete circuit.
        for bit, (old_net, got) in enumerate(zip(port_bits(end), port_bits(other))):
            wanted = expected.root(old_net)
            if forward.setdefault(wanted, got) != got:
                raise ValueError(f"要求连接的信号仍然断开: {key} bit {bit}")
            if backward.setdefault(got, wanted) != wanted:
                raise ValueError(f"出现未要求的短接: {key} bit {bit}")
            count += 1
    return count



def wire_candidate(workbench, args):
    directory = workbench.workspace.state_root / 'candidates' / ('candidate-' + uuid.uuid4().hex[:16])
    directory.mkdir(parents=True)
    try:
        return _wire_candidate(workbench, args, directory)
    except Exception:
        shutil.rmtree(directory)
        raise


def _wire_candidate(workbench, args, directory):
    workspace = workbench.workspace
    name = args.get("circuit")
    additions, connections = args.get("additions", []), args.get("connections", [])
    removals = args.get("removeWireIds", [])
    if not isinstance(name, str) or not isinstance(additions, list) or len(additions) > 80:
        raise ValueError("指定一个电路，最多新增 80 个部件")
    if not isinstance(connections, list) or len(connections) > 240:
        raise ValueError("最多指定 240 条完整端口连接；分位请显式添加 Splitter")
    if (not isinstance(removals, list) or len(removals) > 512
            or any(not isinstance(wire_id, str) for wire_id in removals)
            or len(set(removals)) != len(removals)):
        raise CircuitToolError('INVALID_ARGUMENT', 'removeWireIds 需为最多512个不重复的原生导线ID。')
    if not additions and not connections and not removals:
        raise CircuitToolError('INVALID_ARGUMENT', '请指定新增元件、连接或要删除的导线。')
    if removals and not args.get('artifactSha256'):
        raise CircuitToolError('INVALID_ARGUMENT', '删除导线需要同一次观察的 artifactSha256。',
                               hint='使用 inspect_circuit(includeWires=true) 返回的 artifactSha256 和 wireIds。')
    parent_id = args.get("candidateId")
    if parent_id:
        parent_dir, parent = workbench._metadata(parent_id)
        previous_artifact = parent_dir / "artifact.circ"
        before = previous_artifact.read_bytes()
    else:
        parent = None
        previous_artifact = workspace.frozen_path
        with workspace.observation_artifact() as frozen:
            before = frozen.read_bytes()
    if 'artifactSha256' in args and args['artifactSha256'] != hashlib.sha256(before).hexdigest():
        raise CircuitToolError('STALE_REVISION', '导线或端口所属电路已变化。',
                               hint='重新观察同一 source/candidate，使用该次 artifactSha256 和对象ID。')
    document = CircuitDocument.parse(before, 'artifact.circ')
    circuit = document.circuit(name)
    candidate_id = directory.name
    artifact = directory / "artifact.circ"
    artifact.write_bytes(before)
    for filename, data in workspace.package.contents.items():
        (directory / filename).write_bytes(data)
    baseline = workspace.observer.run_full(artifact, name)
    components_before = baseline["focus"]["components"]
    # References always name the observation BEFORE removal; native IDs may be
    # reassigned by a subsequent load. Bind them to component identity now.
    aliases = {c["componentId"]: identity(c) for c in components_before}
    removed_wires = []
    if removals:
        available = {wire['wireId']: wire for wire in baseline['focus']['wires']}
        unknown = [wire_id for wire_id in removals if wire_id not in available]
        if unknown:
            raise CircuitToolError('INVALID_WIRE_SELECTION', '所选导线不属于这次原生观察。',
                                   hint='使用 inspect_circuit(includeWires=true) 的 wireGeometry.wires 中的 wireId。',
                                   context={'unknownWireIds': unknown[:16], 'unknownCount': len(unknown)})
        removed_wires = [available[wire_id] for wire_id in removals]
        remove_wires(circuit, {'wires': baseline['focus']['wires']}, set(removals))
        artifact.write_bytes(document.replace_circuit(circuit).data)
        baseline = workspace.observer.run_full(artifact, name)
        # The remaining native graph, not the original shorted graph, is the
        # authority for requested joins and preservation of every other bit net.
    if any(baseline.get("coverage", {}).get(k, 0) for k in ("invalidBundleEnds", "widthIncompatibilities")):
        raise ValueError("剩余电路仍有位宽冲突，无法确认连接；可调整要移除的导线或直接编辑文件")
    if len({identity(c) for c in components_before}) != len(components_before):
        raise ValueError("存在同类型同位置的重叠部件，无法唯一绑定端口；请先在编辑器中分开")
    added_attrs = {}
    parts = prepare_parts(workbench, artifact, name, additions, aliases, document.projection['libraries'])
    wiring_libraries = {lib['name'] for lib in document.projection['libraries'] if lib['desc'] == '#Wiring'}
    added_pins = {key for _, key, component, _ in parts
                  if component.get('lib') in wiring_libraries and component.get('name') == 'Pin'}
    for alias, key, component, attrs in parts:
        circuit.append(component)
        aliases[alias] = key
        added_attrs[key] = attrs
    def write():
        artifact.write_bytes(document.replace_circuit(circuit).data)
    if parts:
        write()
        prepared = workspace.observer.run_full(artifact, name)
    else:
        prepared = baseline
    native_components = {identity(c): c for c in prepared["focus"]["components"]}
    for key, attrs in added_attrs.items():
        c = native_components.get(key)
        if c is None:
            raise ValueError(f"原生引擎未加载新增部件: {key}")
        actual = {a["name"]: a.get("standard") for a in c["attributes"]}
        for attr, value in attrs.items():
            if actual.get(attr) != value:
                raise ValueError(f"原生引擎未接受属性 {key} {attr}={value} (actual: {actual.get(attr)})")
    touching = touching_ports(prepared, baseline, added_attrs)
    if touching:
        reference = disconnected_ports(workspace, document, name, baseline, parts, directory)
    else:
        # With every new port clear of all ports/wires, placement has not fused
        # them. Keep the complete native partition, including Splitter bit ties,
        # without an extra native load per addition. New Tunnels are disallowed
        # by prepare_parts, so they cannot add hidden non-geometric joins here.
        compare_partition(baseline, prepared)
        reference = prepared
    partition = Partition()
    resolved = []
    reference_components = {identity(c): c for c in reference["focus"]["components"]}
    def endpoint(ref):
        if not isinstance(ref, dict) or ref.get("component") not in aliases or type(ref.get("port")) is not int:
            raise ValueError("连接端点需为 {component: componentId 或新增 id, port: 原生端口序号}")
        c = reference_components[aliases[ref["component"]]]
        e = next((e for e in c["ends"] if e["index"] == ref["port"]), None)
        if e is None:
            raise ValueError(f"端口不存在或位宽未知: {ref}")
        port_bits(e)
        return c, e
    for connection in connections:
        a, b = endpoint(connection.get("from")), endpoint(connection.get("to"))
        if a[1]["width"] != b[1]["width"]:
            raise width_mismatch(connection, a, b)
        for x, y in zip(port_bits(a[1]), port_bits(b[1])):
            partition.join(x, y)
        resolved.append((connection, a, b))
    contacts = contact_partition(reference, touching, resolved)
    # Full-port output drivers may fan out, but must never merge with another driver.
    drivers = defaultdict(set)
    for c in reference["focus"]["components"]:
        for end in c["ends"]:
            if end["direction"] == "output":
                for net in port_bits(end):
                    drivers[partition.root(net)].add(net)
    if any(len(group) > 1 for group in drivers.values()):
        raise ValueError("连接计划会合并多个原本独立的输出驱动，已拒绝")
    # Placement itself may realize ONLY the explicitly permitted contacts. Then
    # translate requested joins to prepared IDs solely for geometric routing.
    if ports(reference).keys() != ports(prepared).keys():
        raise ValueError("放置后端口集合改变，无法确认连接")
    compare_partition(reference, prepared, contacts)
    routed_partition = Partition()
    native_ports = ports(prepared)
    routed = []
    for connection, (ac, a), (bc, b) in resolved:
        a = native_ports[(identity(ac), a["index"])]
        b = native_ports[(identity(bc), b["index"])]
        for x, y in zip(port_bits(a), port_bits(b)):
            routed_partition.join(x, y)
        routed.append((connection, (ac, a), (bc, b)))
    router = Router(prepared, routed_partition) if routed else None
    signals = []
    for connection, (ac, a), (bc, b) in routed:
        try:
            segments = router.route(a, b)
        except ValueError as error:
            raise ValueError(f"{connection.get('name', '连接')}: {error}") from error
        for start, end in segments:
            ET.SubElement(circuit, "wire", {"from": f"({start[0]},{start[1]})", "to": f"({end[0]},{end[1]})"})
        def description(c, e, ref):
            return {**ref, "factory": c["factoryName"], "label": c.get("selector", {}).get("label"),
                    "portName": e.get("runtimeTooltip"), "location": e["location"]}
        signals.append({"name": str(connection.get("name") or "连接")[:120], "width": a["width"],
                        "from": description(ac, a, connection["from"]), "to": description(bc, b, connection["to"]),
                        "segments": [[list(start), list(end)] for start, end in segments]})
    write()
    render_path = directory / (hashlib.sha256(name.encode()).hexdigest() + ".png")
    after = workspace.observer.run_full(artifact, name, render_path)
    checked_bits = compare_partition(reference, after, partition)
    for key in ("invalidBundleEnds", "widthIncompatibilities"):
        if after.get("coverage", {}).get(key, 0) > baseline.get("coverage", {}).get(key, 0):
            raise ValueError("新增连接产生了电气冲突，未发布候选")
    check_interfaces(workbench, previous_artifact, artifact, name, added_pins)
    (directory / "wiring-observation.json").write_text(json.dumps(after, ensure_ascii=False))
    inherited = [dict(c) for c in parent.get("changes", []) if c["circuit"] != name] if parent else []
    # Retain native images for unchanged modules in a composed candidate.
    if parent:
        for change in inherited:
            filename = hashlib.sha256(change["circuit"].encode()).hexdigest() + ".png"
            (directory / filename).write_bytes((parent_dir / filename).read_bytes())
    prior_change = next((c for c in parent.get("changes", []) if c["circuit"] == name), {}) if parent else {}
    interface_preserved = False if added_pins else prior_change.get("interfacePreserved", True)
    inherited.append({"circuit": name, "componentsBefore": len(components_before),
                      "componentsAfter": len(after["focus"]["components"]), "wiresAfter": len(after["focus"]["wires"]),
                      "interfacePreserved": interface_preserved,
                      "render": after["render"], "coverage": after["coverage"], "connections": signals,
                      "removedWires": [{k: wire[k] for k in ('wireId', 'from', 'to')} for wire in removed_wires],
                      "wiringProof": {"authority": "native-bit-net-partition", "checkedPortBits": checked_bits,
                                      "connections": len(signals), "unexpectedMerges": 0, "missingConnections": 0,
                                      "reference": "remaining-native-graph-after-explicit-wire-removal" if removals else "native-graph-before-routing",
                                      "scope": "All port-bit relationships after the explicitly selected wire removals and requested joins; not behavior."}})
    metadata = {"id": candidate_id, "projectId": workspace.history.record["id"], "baseRevisionId": workspace.revision_id, "parentCandidateId": parent_id,
                "artifactSha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
                "title": str(args.get("title") or "批量连接")[:120], "changes": inherited,
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "checks": [c for c in parent.get("checks", []) if c["circuit"] != name] if parent else [],
                "dependencies": [{"name": d["name"], "sha256": d["sha256"]} for d in workspace.package.dependencies],
                "interfacePreserved": False if added_pins else parent.get("interfacePreserved") if parent else True,
                "sourceUnchanged": True, "verification": "native-bit-net-partition-only"}
    workbench._save(directory, metadata)
    return metadata
