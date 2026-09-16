from __future__ import annotations


"""Export an editable staging artifact; import any supported native circuit.

The agent can implement with scripts or HDL tools. Import is a version-bound
transaction, independent of those tools. It never writes the working state.
"""
import base64
from datetime import datetime, timezone
import hashlib
import uuid
import xml.etree.ElementTree as ET

from studio.project.changes import attach_diff


def export_bundle(w, revision, candidate_id=None):
    with w.lock:
        if revision != w.revision_id: raise ValueError("工程已变化，请重新开始")
        w.package.verify_frozen(w.revision_dir)
        artifact = w.frozen_path
        if candidate_id:
            directory, _ = w.workbench._metadata(candidate_id)
            artifact = directory / "artifact.circ"
        files = {"design.circ": artifact.read_bytes(), **w.package.contents}
        for r in w.package.resources:
            files["materials/" + r["name"]] = w.package.resource_contents[r["id"]]
        return {"projectId": w.history.record["id"], "revisionId": revision,
                "sourceName": w.source_name,
                "files": {name: base64.b64encode(payload).decode() for name, payload in files.items()}}


def import_circuit(workbench, args):
    w = workbench.workspace
    data = args.get("circuitXml")
    if not isinstance(data, str) or len(data.encode()) > 8 * 1024 * 1024:
        raise ValueError("提交需要不超过 8 MB 的电路文件")
    if "<!DOCTYPE" in data.upper() or "<!ENTITY" in data.upper():
        raise ValueError("电路不能包含外部实体")
    root = ET.fromstring(data)
    if root.tag != "project": raise ValueError("不是 Logisim 工程")
    source = ET.fromstring(w.frozen_path.read_bytes())
    # A generated circuit cannot smuggle executable libraries or absolute file
    # dependencies into the host. Existing vetted libraries remain frozen.
    from studio.project.changes import signature
    if signature(root) == signature(source): return {"unchanged": True}
    if sorted((signature(c) for c in source.findall("lib")), key=repr) != sorted((signature(c) for c in root.findall("lib")), key=repr):
        raise ValueError("本次电路修改不能变更组件库声明；请保留原 lib 节点")
    if root.get("source") != source.get("source"):
        raise ValueError("请保留当前 Logisim source 版本")
    names = [c.get("name") for c in root.findall("circuit")]
    if not names or any(not n for n in names) or len(names) != len(set(names)):
        raise ValueError("电路定义名称不能为空或重复")
    if root.find("main") is None or root.find("main").get("name") not in names:
        raise ValueError("主电路不存在")
    # Prevent missing/recursive subcircuits being silently dropped by the loader.
    graph = {c.get("name"): [p.get("name") for p in c.findall("comp") if p.get("lib") is None] for c in root.findall("circuit")}
    visiting, done = set(), set()
    def visit(name):
        if name not in graph: raise ValueError("引用了不存在的子电路：" + str(name))
        if name in visiting: raise ValueError("子电路不能递归引用：" + name)
        if name in done: return
        visiting.add(name)
        for child in graph[name]: visit(child)
        visiting.remove(name); done.add(name)
    for name in graph: visit(name)
    payload = data.encode()
    if payload == w.frozen_path.read_bytes(): return {"unchanged": True}
    sha = hashlib.sha256(payload).hexdigest()
    for existing in workbench.list():
        if existing["artifactSha256"] == sha: return existing
    candidate_id = "candidate-" + uuid.uuid4().hex[:16]
    directory = w.state_root / "candidates" / candidate_id
    directory.mkdir(parents=True)
    (directory / "artifact.circ").write_bytes(payload)
    for name, content in w.package.contents.items(): (directory / name).write_bytes(content)
    metadata = {"id": candidate_id, "projectId": w.history.record["id"], "baseRevisionId": w.revision_id, "artifactSha256": sha,
                "title": str(args.get("title") or "AI 电路修改")[:120], "changes": [], "checks": [],
                "createdAt": datetime.now(timezone.utc).isoformat(), "sourceUnchanged": True,
                "dependencies": [{"name": d["name"], "sha256": d["sha256"]} for d in w.package.dependencies],
                "verification": "native-load-only", "interfacePreserved": None}
    # Load EVERY definition: a shared interface change also affects its parents.
    # Incomplete circuits are valid drafts; width/behavior issues are evidence,
    # not a reason to silently discard an otherwise loadable change.
    metadata["nativeCoverage"] = {}
    for name in names:
        observation = w.observer.run_full(directory / "artifact.circ", name)
        metadata["nativeCoverage"][name] = observation.get("coverage", {})
        actual = w._transform_exact(observation, w.observer.profile())["circuit"]
        expected = next(c for c in root.findall("circuit") if c.get("name") == name)
        if len(actual["components"]) != len(expected.findall("comp")):
            raise ValueError("原生加载未保留全部组件：" + name)
    attach_diff(workbench, directory, metadata)
    workbench._save(directory, metadata)
    return metadata

