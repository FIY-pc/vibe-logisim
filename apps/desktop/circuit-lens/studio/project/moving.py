"""Model-directed layout movement using the same geometry as human dragging."""
from datetime import datetime, timezone
import hashlib
import shutil
import uuid
import xml.etree.ElementTree as ET

from studio.domain.connectivity import assert_preserved_connections
from studio.domain.tool_errors import CircuitToolError
from studio.project.document import CircuitDocument
from studio.project.layout import layout_request, position_request
from studio.project.layout_document import apply_layout, apply_positions


def move_candidate(workbench, args):
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
        raise CircuitToolError('STALE_REVISION', '所选对象所属电路已变化',
                               hint='重新 inspect_circuit，使用同一次观察的 artifactSha256 和对象 ID。')
    candidate_id = 'candidate-' + uuid.uuid4().hex[:16]
    directory = w.state_root / 'candidates' / candidate_id
    directory.mkdir(parents=True)
    artifact = directory / 'artifact.circ'
    try:
        artifact.write_bytes(before)
        for filename, data in w.package.contents.items():
            (directory / filename).write_bytes(data)
        baseline = w.observer.run_full(artifact, name)
        scene = w._transform_exact(baseline, w.observer.profile())['circuit']
        document = CircuitDocument.parse(before, 'artifact.circ')
        circuit = document.circuit(name)
        positions = None
        if 'positions' in args:
            positions = position_request(scene, args)
            selected, dx, dy = set(positions), 0, 0
            apply_positions(circuit, scene, positions)
            movement = {'positions': [{'componentId': key, 'x': x, 'y': y}
                                      for key, (x, y) in positions.items()]}
        else:
            selected, wire_ids, dx, dy = layout_request(scene, args)
            if not dx and not dy:
                raise ValueError('移动距离为零；如需观察原图，请使用 render_circuit')
            apply_layout(circuit, scene, selected, wire_ids, dx, dy)
            movement = {'componentIds': sorted(selected), 'wireIds': sorted(wire_ids), 'delta': {'x': dx, 'y': dy}}
        artifact.write_bytes(document.replace_circuit(circuit).data)
        render_path = directory / (hashlib.sha256(name.encode()).hexdigest() + '.png')
        after = w.observer.run_full(artifact, name, render_path)
        after_scene = w._transform_exact(after, w.observer.profile())['circuit']
        checked = assert_preserved_connections(scene['components'], after_scene['components'], selected, dx, dy, positions=positions)
        if any(after['coverage'].get(k, 0) > baseline['coverage'].get(k, 0)
               for k in ('invalidBundleEnds', 'widthIncompatibilities', 'unknownWidthEnds')):
            raise ValueError('移动产生了电气冲突，请调整目标位置')
        workbench._native(w.frozen_path, ET.Element('check-interface', circuit=name), artifact)
        inherited = [dict(c) for c in parent.get('changes', []) if c['circuit'] != name] if parent else []
        for change in inherited:
            filename = hashlib.sha256(change['circuit'].encode()).hexdigest() + '.png'
            shutil.copyfile(parent_dir / filename, directory / filename)
        inherited.append({
            'circuit': name, 'componentsBefore': len(scene['components']),
            'componentsAfter': len(after_scene['components']), 'wiresAfter': len(after_scene['wires']),
            'render': after['render'], 'coverage': after['coverage'],
            'movement': movement,
            'wiringProof': {'authority': 'native-bit-net-partition', 'checkedPortBits': checked,
                            'scope': 'All port-bit relationships preserved; behavior and readability not judged.'},
        })
        metadata = {
            'id': candidate_id, 'projectId': w.history.record['id'], 'baseRevisionId': w.revision_id,
            'parentCandidateId': parent_id, 'artifactSha256': hashlib.sha256(artifact.read_bytes()).hexdigest(),
            'title': str(args.get('title') or '调整电路布局')[:120], 'changes': inherited,
            'createdAt': datetime.now(timezone.utc).isoformat(),
            'checks': [c for c in parent.get('checks', []) if c['circuit'] != name] if parent else [],
            'dependencies': [{'name': d['name'], 'sha256': d['sha256']} for d in w.package.dependencies],
            'interfacePreserved': True, 'sourceUnchanged': True, 'verification': 'native-bit-net-partition-only',
        }
        workbench._save(directory, metadata)
        return metadata
    except Exception:
        shutil.rmtree(directory)
        raise
