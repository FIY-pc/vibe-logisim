"""Native property edits without inventing component rules or rewiring intent."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import shutil
import uuid
import xml.etree.ElementTree as ET

from studio.domain.tool_errors import CircuitToolError
from studio.project.document import CircuitDocument


def _key(component):
    return component['factory'], component['location']['x'], component['location']['y']


def _ports(component):
    return [{k: end[k] for k in ('index', 'location', 'width', 'direction')}
            for end in component['ends']]


def _interface(workbench, artifact, name):
    symbol = workbench._native(artifact, ET.Element('interface', circuit=name)).find('symbol')
    if symbol is None:
        raise ValueError('原生查询未返回电路接口')
    pins = sorted((dict(pin.attrib) for pin in symbol.findall('pin')), key=lambda p: p['id'])
    uses = sorted(({**use.attrib, 'ports': [dict(port.attrib) for port in use.findall('port')]}
                   for use in symbol.findall('use')), key=lambda u: (u['circuit'], u['x'], u['y']))
    return {'pins': pins, 'uses': uses}


def _affected_circuits(document, name):
    affected = {name}
    while True:
        parents = {c['name'] for c in document.projection['circuits']
                   if any(i['target'] in affected for i in c['instances'])}
        if parents <= affected:
            return affected
        affected.update(parents)


def edit_candidate(workbench, args):
    w, name = workbench.workspace, args['circuit']
    parent_id = args.get('candidateId')
    parent_dir, parent = workbench._metadata(parent_id) if parent_id else (None, None)
    if parent_dir:
        before = (parent_dir / 'artifact.circ').read_bytes()
    else:
        with w.observation_artifact() as source:
            before = source.read_bytes()
    if hashlib.sha256(before).hexdigest() != args['artifactSha256']:
        raise CircuitToolError('STALE_REVISION', '属性编辑所引用的电路已变化',
                               hint='使用同一次 inspect_circuit 的 artifactSha256 和 componentId。')
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
        components = {c['componentId']: c for c in scene['components']}
        document = CircuitDocument.parse(before, 'artifact.circ')
        circuit = document.circuit(name)
        request = ET.Element('edit-components', circuit=name, strictAttributes='true')
        selected, xml_targets = {}, {}
        for edit in args['edits']:
            identifier, attrs = edit['componentId'], edit['attributes']
            if identifier in selected or identifier not in components:
                raise ValueError(f'元件编号不存在或重复: {identifier}；请使用同次观察中的 componentId')
            if not 1 <= len(attrs) <= 128:
                raise ValueError(f'{identifier}: 每个元件需要 1–128 个属性')
            component = components[identifier]
            factory, x, y = _key(component)
            targets = [c for c in circuit.findall('comp')
                       if c.get('name') == factory and c.get('loc') == f'({x},{y})']
            if len(targets) != 1:
                raise ValueError(f'{identifier}: 元件位置不唯一，不能确定修改对象')
            selected[identifier], xml_targets[identifier] = component, targets[0]
            spec = ET.SubElement(request, 'component', id=identifier, factory=factory, x=str(x), y=str(y))
            for attr, value in attrs.items():
                ET.SubElement(spec, 'set', name=attr, value=value)
        result = workbench._native(artifact, request)
        edited = result.findall('component')
        if [item.get('id') for item in edited] != list(selected):
            raise ValueError('原生属性修改未完整返回请求对象')
        expected, changes = {}, []
        for item, edit in zip(edited, args['edits']):
            identifier = item.get('id')
            original = {a.get('name'): a.get('val', a.text or '') for a in item.findall('before/a')}
            values = {a.get('name'): a.get('val', a.text or '') for a in item.findall('a')}
            expected[identifier] = {key: values[key] for key in edit['attributes']}
            target = xml_targets[identifier]
            # Preserve untouched serialization, unknown source attributes and
            # comments. Only write native changes, including coupled properties.
            delta = {key: {'before': original.get(key), 'after': values.get(key)}
                     for key in sorted(original.keys() | values.keys()) if original.get(key) != values.get(key)}
            native_nodes = {a.get('name'): a for a in item.findall('a')}
            for key in delta:
                for node in list(target.findall('a')):
                    if node.get('name') == key:
                        target.remove(node)
                if key in native_nodes:
                    target.append(deepcopy(native_nodes[key]))
            if delta:
                changes.append({'componentId': identifier, 'factory': selected[identifier]['factory'],
                                'location': selected[identifier]['location'], 'attributes': delta})
        if not changes:
            shutil.rmtree(directory)
            return {'unchanged': True, 'candidateId': parent_id, 'artifactSha256': args['artifactSha256']}
        old_interface = _interface(workbench, artifact, name)
        artifact.write_bytes(document.replace_circuit(circuit).data)
        after = w.observer.run_full(artifact, name, directory / (hashlib.sha256(name.encode()).hexdigest() + '.png'))
        after_scene = w._transform_exact(after, w.observer.profile())['circuit']
        lookup = {_key(c): c for c in after_scene['components']}
        if len(lookup) != len(scene['components']) or set(lookup) != {_key(c) for c in scene['components']}:
            raise ValueError('重新加载未保留原有元件；未发布属性修改')
        for identifier, attrs in expected.items():
            loaded = lookup[_key(selected[identifier])]
            for attr, value in attrs.items():
                if loaded['attributes'].get(attr) != value:
                    raise ValueError(f'{identifier}: 重新加载未保留请求属性 {attr}={value}')
        port_changes = []
        for change in changes:
            original = selected[change['componentId']]
            loaded = lookup[_key(original)]
            change['resultComponentId'] = loaded['componentId']
            if _ports(original) != _ports(loaded):
                port_changes.append({'componentId': change['componentId'],
                                     'resultComponentId': loaded['componentId'],
                                     'before': _ports(original), 'after': _ports(loaded)})
        new_interface = _interface(workbench, artifact, name)
        interface_preserved = old_interface == new_interface
        affected = _affected_circuits(document, name)
        parent_coverage = {}
        if not interface_preserved:
            for parent_name in sorted(affected - {name}):
                observation = w.observer.run_full(artifact, parent_name)
                parent_coverage[parent_name] = observation['coverage']
        inherited = [deepcopy(c) for c in parent.get('changes', []) if c['circuit'] != name] if parent else []
        for change in inherited:
            filename = hashlib.sha256(change['circuit'].encode()).hexdigest() + '.png'
            if change['circuit'] in affected:
                observation = w.observer.run_full(artifact, change['circuit'], directory / filename)
                change.update(render=observation['render'], coverage=observation['coverage'])
            else:
                shutil.copyfile(parent_dir / filename, directory / filename)
        prior_change = next((c for c in parent.get('changes', []) if c['circuit'] == name), {}) if parent else {}
        inherited.append({'circuit': name, 'componentsBefore': len(scene['components']),
            'componentsAfter': len(after_scene['components']), 'wiresAfter': len(after_scene['wires']),
            'render': after['render'], 'coverage': after['coverage'], 'attributeEdits': changes,
            'portChanges': port_changes, 'wireGeometryPreserved': True,
            'interfacePreserved': False if not interface_preserved else prior_change.get('interfacePreserved', True),
            'interfaceChange': None if interface_preserved else {'before': old_interface, 'after': new_interface},
            'affectedParentCircuits': sorted(affected - {name}), 'parentCoverage': parent_coverage})
        metadata = {'id': candidate_id, 'projectId': w.history.record['id'], 'baseRevisionId': w.revision_id,
            'parentCandidateId': parent_id, 'artifactSha256': hashlib.sha256(artifact.read_bytes()).hexdigest(),
            'title': str(args.get('title') or '修改元件属性')[:120], 'changes': inherited,
            'createdAt': datetime.now(timezone.utc).isoformat(),
            'checks': [c for c in parent.get('checks', []) if c.get('circuit') not in affected] if parent else [],
            'dependencies': [{'name': d['name'], 'sha256': d['sha256']} for d in w.package.dependencies],
            'interfacePreserved': False if not interface_preserved else (parent.get('interfacePreserved') if parent else True),
            'sourceUnchanged': True, 'verification': 'native-attribute-roundtrip-only'}
        workbench._save(directory, metadata)
        return metadata
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise
