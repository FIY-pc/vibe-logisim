"""Optional rerouting proposal with native acceptance and ordinary candidate access."""
from datetime import datetime, timezone
import hashlib
import shutil
import uuid
import xml.etree.ElementTree as ET

from studio.domain.rerouting import reroute
from studio.domain.connectivity import assert_preserved_connections
from studio.domain.tool_errors import CircuitToolError
from studio.project.wire_selection import remove_wires
from studio.project.document import CircuitDocument


def reroute_candidate(workbench, args):
    w = workbench.workspace
    name = args['circuit']
    parent_id = args.get('candidateId')
    parent_dir, parent = workbench._metadata(parent_id) if parent_id else (None, None)
    if parent_dir:
        before = (parent_dir / 'artifact.circ').read_bytes()
    else:
        with w.observation_artifact() as artifact:
            before = artifact.read_bytes()
    if hashlib.sha256(before).hexdigest() != args['artifactSha256']:
        raise CircuitToolError('STALE_REVISION', '导线所属电路已变化',
                               hint='重新 inspect_circuit(includeWires=true)，使用该次返回的 artifactSha256 和 wireIds。')
    document = CircuitDocument.parse(before, 'artifact.circ')
    circuit = document.circuit(name)
    wire_ids = args['wireIds']
    if len(set(wire_ids)) != len(wire_ids):
        raise ValueError('wireIds 不能重复')
    candidate_id = 'candidate-' + uuid.uuid4().hex[:16]
    directory = w.state_root / 'candidates' / candidate_id
    directory.mkdir(parents=True)
    artifact = directory / 'artifact.circ'
    try:
        artifact.write_bytes(before)
        for filename, data in w.package.contents.items():
            (directory / filename).write_bytes(data)
        baseline = w.observer.run_full(artifact, name)
        if any(baseline['coverage'].get(k, 0) for k in ('invalidBundleEnds', 'widthIncompatibilities', 'unknownWidthEnds')):
            raise ValueError('电路包含未知位宽或位宽冲突，暂不能确认重新布线保持连接')
        proposed, summary = reroute(baseline, set(wire_ids))
        remove_wires(circuit, {'wires': baseline['focus']['wires']}, set(wire_ids))
        for wire in proposed:
            ET.SubElement(circuit, 'wire', {key: f"({wire[key]['x']},{wire[key]['y']})" for key in ('from', 'to')})
        artifact.write_bytes(document.replace_circuit(circuit).data)
        render_path = directory / (hashlib.sha256(name.encode()).hexdigest() + '.png')
        after = w.observer.run_full(artifact, name, render_path)
        def components(document):
            return [{**c, 'factory': c['factoryName']} for c in document['focus']['components']]
        checked = assert_preserved_connections(components(baseline), components(after), set(), 0, 0)
        if any(after['coverage'].get(k, 0) > baseline['coverage'].get(k, 0)
               for k in ('invalidBundleEnds', 'widthIncompatibilities', 'unknownWidthEnds')):
            raise ValueError('重新布线产生了电气冲突，未发布候选')
        workbench._native(w.frozen_path, ET.Element('check-interface', circuit=name), artifact)
        inherited = [dict(c) for c in parent.get('changes', []) if c['circuit'] != name] if parent else []
        for change in inherited:
            filename = hashlib.sha256(change['circuit'].encode()).hexdigest() + '.png'
            shutil.copyfile(parent_dir / filename, directory / filename)
        inherited.append({'circuit': name, 'componentsBefore': len(components(baseline)),
                          'componentsAfter': len(components(after)), 'wiresAfter': len(after['focus']['wires']),
                          'render': after['render'], 'coverage': after['coverage'], 'routing': summary,
                          'wiringProof': {'authority': 'native-bit-net-partition', 'checkedPortBits': checked,
                                          'scope': 'All port-bit relationships preserved; behavior and readability not judged.'}})
        metadata = {'id': candidate_id, 'projectId': w.history.record['id'], 'baseRevisionId': w.revision_id,
                    'parentCandidateId': parent_id, 'artifactSha256': hashlib.sha256(artifact.read_bytes()).hexdigest(),
                    'title': str(args.get('title') or '整理导线路径')[:120], 'changes': inherited,
                    'createdAt': datetime.now(timezone.utc).isoformat(),
                    'checks': [c for c in parent.get('checks', []) if c['circuit'] != name] if parent else [],
                    'dependencies': [{'name': d['name'], 'sha256': d['sha256']} for d in w.package.dependencies],
                    'interfacePreserved': True, 'sourceUnchanged': True, 'verification': 'native-bit-net-partition-only'}
        workbench._save(directory, metadata)
        return metadata
    except Exception:
        # Only this invocation's unpublished disposable artifact is removed.
        shutil.rmtree(directory)
        raise
