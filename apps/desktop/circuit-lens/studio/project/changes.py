from __future__ import annotations



"""Construction-independent source diff. Ambiguous identities stay remove/add.

Compare every definition against the frozen base, not the last tool operation.
Wire differences describe serialized segments, not electrical equivalence.
"""
from collections import Counter, defaultdict
import hashlib
import xml.etree.ElementTree as ET


def signature(node, omit=()):
    if node is None:
        return None
    return (node.tag, tuple(sorted((k, v) for k, v in node.attrib.items() if k not in omit)),
            (node.text or "").strip(), tuple(sorted((signature(c) for c in node), key=repr)))


def point(value):
    x, y = value.strip("()").split(",")
    return {"x": int(x), "y": int(y)}


def component(node, native=None):
    loc = point(node.get("loc"))
    attrs = {a.get("name"): a.get("val", a.text or "") for a in node.findall("a")}
    return {"factory": node.get("name"), "label": attrs.get("label", node.get("name")),
            "location": loc, "attributes": attrs,
            "bounds": (native or {}).get("bounds") or {"x": loc["x"]-15, "y": loc["y"]-15, "width": 30, "height": 30}}


def component_pairs(before, after):
    old = list(before.findall("comp")) if before is not None else []
    new = list(after.findall("comp")) if after is not None else []
    pairs = []
    # Exact components first; then unique location/type, then labelled moved
    # components, then unique identical components excluding their location.
    def label(c):
        return next((a.get("val") for a in c.findall("a") if a.get("name") == "label"), None)
    def match(key):
        left, right = defaultdict(list), defaultdict(list)
        for c in old:
            if key(c) is not None: left[key(c)].append(c)
        for c in new:
            if key(c) is not None: right[key(c)].append(c)
        for k in sorted(left.keys() & right.keys(), key=repr):
            if len(left[k]) == len(right[k]) == 1:
                a, b = left[k][0], right[k][0]
                pairs.append((a, b)); old.remove(a); new.remove(b)
    match(signature)
    match(lambda c: (c.get("lib"), c.get("name"), c.get("loc")))
    match(lambda c: (c.get("lib"), c.get("name"), label(c)) if label(c) else None)
    match(lambda c: signature(c, ("loc",)))
    return pairs, old, new


def definition_diff(before, after, old_native=None, new_native=None):
    pairs, old, new = component_pairs(before, after)
    def native_lookup(document):
        # Native observer schema is normalized by Workspace before arriving here.
        return {(c["factory"], c["location"]["x"], c["location"]["y"]): c
                for c in (document or {}).get("components", [])}
    native = [native_lookup(old_native), native_lookup(new_native)]
    def describe(c, side):
        p = point(c.get("loc"))
        return component(c, native[side].get((c.get("name"), p["x"], p["y"])))
    items = []
    for a, b in pairs:
        if signature(a) != signature(b):
            first, last = describe(a, 0), describe(b, 1)
            fields = [k for k in sorted(first["attributes"].keys() | last["attributes"].keys())
                      if first["attributes"].get(k) != last["attributes"].get(k)]
            if a.get("loc") != b.get("loc"): fields.insert(0, "位置")
            items.append({"kind": "component", "change": "modified", "before": first, "after": last, "fields": fields})
    items += [{"kind": "component", "change": "removed", "before": describe(c, 0)} for c in old]
    items += [{"kind": "component", "change": "added", "after": describe(c, 1)} for c in new]
    def wires(root):
        return Counter(tuple(sorted((w.get("from"), w.get("to")))) for w in root.findall("wire")) if root is not None else Counter()
    a, b = wires(before), wires(after)
    for change, delta, side in (("removed", a-b, "before"), ("added", b-a, "after")):
        for (start, end), count in sorted(delta.items()):
            items.extend({"kind": "wire", "change": change, side: {"from": point(start), "to": point(end)}} for _ in range(count))
    other = lambda root: tuple(signature(c) for c in root if c.tag not in {"comp", "wire"}) if root is not None else ()
    return {"items": items, "definitionChanged": other(before) != other(after),
            "counts": dict(Counter(i["change"] for i in items)),
            "scope": "components-and-physical-wire-segments"}


def attach_diff(workbench, directory, metadata):
    w = workbench.workspace
    before = ET.fromstring(w.frozen_path.read_bytes())
    after = ET.fromstring((directory / "artifact.circ").read_bytes())
    old = {c.get("name"): c for c in before.findall("circuit")}
    new = {c.get("name"): c for c in after.findall("circuit")}
    existing = {c["circuit"]: c for c in metadata.get("changes", [])}
    changes = []
    for name in dict.fromkeys([*old, *new]):
        a, b = old.get(name), new.get(name)
        change = existing.get(name, {"circuit": name})
        # A wiring candidate may carry native connectivity proof even when its
        # artifact has no definition-level change relative to the workspace
        # snapshot. Preserve that fact for candidate review instead of letting
        # the structural diff erase it.
        unchanged = signature(a) == signature(b)
        if unchanged and not change.get("wiringProof"):
            continue
        native = []
        for side, circuit, artifact in (("before", a, w.frozen_path), ("after", b, directory / "artifact.circ")):
            if circuit is None:
                native.append(None); continue
            filename = hashlib.sha256(name.encode()).hexdigest() + ("-before" if side == "before" else "") + ".png"
            observation = w.observer.run_full(artifact, name, directory / filename)
            view = w._transform_exact(observation, w.observer.profile())["circuit"]
            native.append(view)
            change["beforeRender" if side == "before" else "render"] = observation["render"]
        change.update({"componentsBefore": len(a.findall("comp")) if a is not None else 0,
                       "componentsAfter": len(b.findall("comp")) if b is not None else 0,
                       "wiresAfter": len(b.findall("wire")) if b is not None else 0,
                       "definitionStatus": "unchanged" if unchanged else "added" if a is None else "removed" if b is None else "modified",
                       "diff": definition_diff(a, b, *native) if not unchanged else {"items": [], "definitionChanged": False,
                                                                                       "counts": {}, "scope": "components-and-physical-wire-segments"}})
        changes.append(change)
    metadata["changes"] = changes
    def settings(root):
        return (sorted(root.attrib.items()), tuple(signature(c) for c in root if c.tag != "circuit"))
    metadata["projectSettingsChanged"] = settings(before) != settings(after)
    metadata["diffVersion"] = 1
    return metadata

