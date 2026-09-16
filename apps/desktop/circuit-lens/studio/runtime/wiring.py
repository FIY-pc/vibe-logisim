from __future__ import annotations


"""Physical bus wiring, with Logisim's bit-net partition as the acceptance authority.

The router proposes geometry. It never decides whether that geometry is electrically
correct: every existing and added port bit is compared after a fresh native load.
"""

from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
import re
import uuid
import xml.etree.ElementTree as ET

from studio.domain.routing import Router, Partition


BUILTINS = {
    "#Wiring": {"Constant", "Bit Extender", "Splitter", "Tunnel"},
    "#Gates": {"NOT Gate", "AND Gate", "OR Gate", "XOR Gate", "NAND Gate", "NOR Gate"},
    "#Plexers": {"Multiplexer", "Demultiplexer"},
    "#Arithmetic": {"Adder", "Subtractor", "Comparator", "Shifter"},
    "#Memory": {"Register", "Counter"},
    "#I/O": {"Button", "LED"},
}


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
        actual = {b["bit"]: b["netId"] for b in other["netBits"]}
        for bit in end["netBits"]:
            wanted = expected.root(bit["netId"])
            got = actual.get(bit["bit"])
            if got is None:
                raise ValueError(f"端口失去确定的电气网络: {key}")
            if forward.setdefault(wanted, got) != got:
                raise ValueError(f"要求连接的信号仍然断开: {key} bit {bit['bit']}")
            if backward.setdefault(got, wanted) != wanted:
                raise ValueError(f"出现未要求的短接: {key} bit {bit['bit']}")
            count += 1
    return count



def wire_candidate(workbench, args):
    workspace = workbench.workspace
    name = args.get("circuit")
    additions, connections = args.get("additions", []), args.get("connections", [])
    if not isinstance(name, str) or not isinstance(additions, list) or len(additions) > 80:
        raise ValueError("指定一个电路，最多新增 80 个部件")
    if not isinstance(connections, list) or not 1 <= len(connections) <= 240:
        raise ValueError("指定 1–240 条完整端口连接；分位请显式添加 Splitter")
    parent_id = args.get("candidateId")
    if parent_id:
        parent_dir, parent = workbench._metadata(parent_id)
        before = (parent_dir / "artifact.circ").read_bytes()
    else:
        parent = None
        with workspace.observation_artifact() as frozen:
            before = frozen.read_bytes()
    matches = list(re.finditer(rb"<circuit\b[^>]*>.*?</circuit>", before, re.S))
    match = next((m for m in matches if ET.fromstring(m.group()).get("name") == name), None)
    if match is None:
        raise ValueError("Unknown circuit")
    circuit = ET.fromstring(match.group())
    candidate_id = "candidate-" + uuid.uuid4().hex[:16]
    directory = workspace.state_root / "candidates" / candidate_id
    directory.mkdir(parents=True)
    artifact = directory / "artifact.circ"
    artifact.write_bytes(before)
    for filename, data in workspace.package.contents.items():
        (directory / filename).write_bytes(data)
    baseline = workspace.observer.run_full(artifact, name)
    if any(baseline.get("coverage", {}).get(k, 0) for k in ("invalidBundleEnds", "widthIncompatibilities")):
        raise ValueError("当前电路已有位宽冲突，暂不支持在冲突网络上自动布线")
    components_before = baseline["focus"]["components"]
    if len({identity(c) for c in components_before}) != len(components_before):
        raise ValueError("存在同类型同位置的重叠部件，无法唯一绑定端口；请先在编辑器中分开")
    aliases = {c["componentId"]: identity(c) for c in components_before}
    libraries = {lib.get("desc"): lib.get("name") for lib in ET.fromstring(before).findall("lib")}
    added_attrs = {}
    for item in additions:
        alias, factory, location = item.get("id"), item.get("factory"), item.get("location")
        if not isinstance(alias, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,47}", alias) or alias in aliases:
            raise ValueError("新增部件 id 必须唯一且不能与已有 componentId 冲突")
        if not isinstance(location, dict) or any(type(location.get(k)) is not int or not 0 <= location[k] <= 6000 or location[k] % 10 for k in ("x", "y")):
            raise ValueError("部件位置需在 0–6000 的 10 单位网格上")
        lib = next((libraries[desc] for desc, names in BUILTINS.items() if factory in names and desc in libraries), None)
        if lib is None:
            raise ValueError(f"尚不支持新增组件: {factory}")
        attrs = item.get("attributes", {})
        if not isinstance(attrs, dict) or len(attrs) > 40 or any(not isinstance(k, str) or not isinstance(v, str) or len(v) > 160 for k, v in attrs.items()):
            raise ValueError("属性必须为原生属性名与短字符串值")
        if factory == "Tunnel":
            raise ValueError("当前物理连线工具不新增 Tunnel；请连接已有端口")
        key = factory, point(location)
        if key in aliases.values():
            raise ValueError("新增部件与已有部件位置重复")
        component = ET.SubElement(circuit, "comp", lib=lib, name=factory, loc=f"({location['x']},{location['y']})")
        for attr, value in attrs.items():
            ET.SubElement(component, "a", name=attr, val=value)
        aliases[alias] = key
        added_attrs[key] = attrs
    def write():
        artifact.write_bytes(before[:match.start()] + ET.tostring(circuit, encoding="utf-8") + before[match.end():])
    write()
    prepared = workspace.observer.run_full(artifact, name)
    compare_partition(baseline, prepared)
    native_components = {identity(c): c for c in prepared["focus"]["components"]}
    old_ports = {point(e["location"]) for c in components_before for e in c["ends"]}
    new_ports = set()
    for key, attrs in added_attrs.items():
        c = native_components.get(key)
        if c is None:
            raise ValueError(f"原生引擎未加载新增部件: {key}")
        for end in c["ends"]:
            p = point(end["location"])
            on_wire = any(p in Router.grid(point(w["from"]), point(w["to"])) for w in baseline["focus"]["wires"])
            if p in old_ports or p in new_ports or on_wire:
                raise ValueError(f"新增端口 {key} {end['index']} 与已有端口或导线重合；请移开后显式连接")
            new_ports.add(p)
        actual = {a["name"]: a.get("standard") for a in c["attributes"]}
        for attr, value in attrs.items():
            if actual.get(attr) != value:
                raise ValueError(f"原生引擎未接受属性 {key} {attr}={value} (actual: {actual.get(attr)})")
    partition = Partition()
    resolved = []
    def endpoint(ref):
        if not isinstance(ref, dict) or ref.get("component") not in aliases or type(ref.get("port")) is not int:
            raise ValueError("连接端点需为 {component: componentId 或新增 id, port: 原生端口序号}")
        c = native_components[aliases[ref["component"]]]
        e = next((e for e in c["ends"] if e["index"] == ref["port"]), None)
        if e is None or e["width"] is None or e["width"] < 1 or len(e["netBits"]) != e["width"]:
            raise ValueError(f"端口不存在或位宽未知: {ref}")
        return c, e
    for connection in connections:
        a, b = endpoint(connection.get("from")), endpoint(connection.get("to"))
        if a[1]["width"] != b[1]["width"]:
            raise ValueError(f"连接位宽不同: {connection.get('name')}: {a[1]['width']} ≠ {b[1]['width']}")
        for x, y in zip(a[1]["netBits"], b[1]["netBits"]):
            partition.join(x["netId"], y["netId"])
        resolved.append((connection, a, b))
    # Full-port output drivers may fan out, but must never merge with another driver.
    drivers = defaultdict(set)
    for c in prepared["focus"]["components"]:
        for end in c["ends"]:
            if end["direction"] == "output":
                for bit in end["netBits"]:
                    drivers[partition.root(bit["netId"])].add(bit["netId"])
    if any(len(group) > 1 for group in drivers.values()):
        raise ValueError("连接计划会合并多个原本独立的输出驱动，已拒绝")
    router = Router(prepared, partition)
    signals = []
    for connection, (ac, a), (bc, b) in resolved:
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
    checked_bits = compare_partition(prepared, after, partition)
    for key in ("invalidBundleEnds", "widthIncompatibilities"):
        if after.get("coverage", {}).get(key, 0) > baseline.get("coverage", {}).get(key, 0):
            raise ValueError("新增连接产生了电气冲突，未发布候选")
    workbench._native(workspace.frozen_path, ET.Element("check-interface", circuit=name), artifact)
    (directory / "wiring-observation.json").write_text(json.dumps(after, ensure_ascii=False))
    inherited = [dict(c) for c in parent.get("changes", []) if c["circuit"] != name] if parent else []
    # Retain native images for unchanged modules in a composed candidate.
    if parent:
        for change in inherited:
            filename = hashlib.sha256(change["circuit"].encode()).hexdigest() + ".png"
            (directory / filename).write_bytes((parent_dir / filename).read_bytes())
    inherited.append({"circuit": name, "componentsBefore": len(components_before),
                      "componentsAfter": len(after["focus"]["components"]), "wiresAfter": len(after["focus"]["wires"]),
                      "render": after["render"], "coverage": after["coverage"], "connections": signals,
                      "wiringProof": {"authority": "native-bit-net-partition", "checkedPortBits": checked_bits,
                                      "connections": len(signals), "unexpectedMerges": 0, "missingConnections": 0,
                                      "scope": "Port-bit connectivity only; not CPU behavior."}})
    metadata = {"id": candidate_id, "projectId": workspace.history.record["id"], "baseRevisionId": workspace.revision_id, "parentCandidateId": parent_id,
                "artifactSha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
                "title": str(args.get("title") or "批量连接")[:120], "changes": inherited,
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "checks": [c for c in parent.get("checks", []) if c["circuit"] != name] if parent else [],
                "dependencies": [{"name": d["name"], "sha256": d["sha256"]} for d in workspace.package.dependencies],
                "interfacePreserved": True, "sourceUnchanged": True, "verification": "native-bit-net-partition-only"}
    workbench._save(directory, metadata)
    return metadata

