from __future__ import annotations

from pathlib import Path
import xml.etree.ElementTree as ET

from studio.domain.connectivity import assert_preserved_connections
from studio.project.layout import layout_request, plan_layout, selection_ids
from studio.project.wire_selection import remove_wires
from studio.domain.wire_geometry import on_segment
from studio.project.connections import endpoint_bits

class CircuitEditor:
    def __init__(self, workspace, history, *, inspect_snapshot):
        self.workspace = workspace
        self.history = history
        self.inspect_snapshot = inspect_snapshot

    def edit(self, project_id, revision, body):
        self.history._check(project_id, revision)
        w = self.workspace
        if self.history.disk_status()['changed']:
            raise ValueError('磁盘工程已改变，请先处理外部改动')
        name = body.get('circuit')
        view = w.workbench.inspect({'circuit': name})
        if view.get('authority') != 'exact-runtime':
            raise ValueError('原生元件信息不可用，不能安全修改属性')
        component = next((c for c in view['components'] if c['componentId'] == body.get('componentId')), None)
        attr, value = (body.get('attribute'), body.get('value'))
        if not component or not isinstance(attr, str) or (not isinstance(value, str)) or (len(value) > 1024):
            raise ValueError('属性或对象无效')
        request = ET.Element('property', circuit=name, factory=component['factory'], attribute=attr, value=value, **{k: str(v) for k, v in component['location'].items()})
        memory_edit = attr == 'contents' and component['factory'] == 'ROM'
        if memory_edit:
            request.set('address', str(body.get('address')))
            request.set('expected', str(body.get('expected')))
        with w.observation_artifact() as artifact:
            value = w.workbench._native(Path(artifact), request).text or ''
        circuit = w.project_store.document.circuit(name)
        location = component['location']
        targets = [c for c in circuit.findall('comp') if c.get('name') == component['factory'] and c.get('loc') == f"({location['x']},{location['y']})"]
        if len(targets) != 1:
            raise ValueError('元件位置不唯一，不能安全修改')
        target = targets[0]
        node = next((a for a in target.findall('a') if a.get('name') == attr), None)
        if node is None:
            node = ET.SubElement(target, 'a', name=attr)
        elif (node.text if memory_edit else node.get('val')) == value:
            return w.session()
        if memory_edit:
            node.attrib.pop('val', None)
            node.text = value
        else:
            node.set('val', value)
        snapshot = w.project_store.freeze_circuit(circuit)
        loaded = self.inspect_snapshot(snapshot, name)
        edited = next((c for c in loaded['components'] if c['factory'] == component['factory'] and c['location'] == location))
        actual = edited['attributes'].get(attr)
        accepted = actual == value
        if loaded['authority'] != 'exact-runtime' or not accepted:
            raise ValueError('原生运行时未接受此属性值')
        target_revision = snapshot.revision_id
        summary = f"地址 {body.get('address')} → {body.get('value')}" if memory_edit else value
        return self.history.advance('edit', f"{component['label'] or component['factory']} · {attr} → {summary}", target_revision, prepared=snapshot, circuits=[name], componentId=component['componentId'], attribute=attr, value=summary)

    def move(self, project_id, revision, body):
        self.history._check(project_id, revision)
        w = self.workspace
        if self.history.disk_status()['changed']:
            raise ValueError('磁盘工程已改变，请先处理外部改动')
        name = body.get('circuit')
        view = w.workbench.inspect({'circuit': name})
        if view.get('authority') != 'exact-runtime':
            raise ValueError('原生元件信息不可用，不能安全移动对象')
        scene = w.circuit_view(name)['circuit']
        selected, wire_ids, dx, dy = layout_request(scene, body)
        ids = sorted(selected)
        targets = [c for c in view['components'] if c['componentId'] in selected]
        if not dx and (not dy):
            return w.session()
        circuit = w.project_store.document.circuit(name)
        locations = {(c['factory'], c['location']['x'], c['location']['y']) for c in targets}
        pin_moves = {}
        changed = 0
        for node in circuit.findall('comp'):
            point = tuple((int(value) for value in node.get('loc', '(0,0)').strip('()').split(',')))
            if (node.get('name'), *point) not in locations:
                continue
            node.set('loc', f'({point[0] + dx},{point[1] + dy})')
            if node.get('name') == 'Pin':
                # Appearance port references use x,y, unlike component loc=(x,y).
                # Move the referenced Pin without changing its external port position.
                pin_moves[f'{point[0]},{point[1]}'] = f'{point[0] + dx},{point[1] + dy}'
            changed += 1
        if changed != len(targets):
            raise ValueError('对象位置不唯一，不能安全移动')
        segments = plan_layout(scene, selected, wire_ids, dx, dy)
        for wire in list(circuit.findall('wire')):
            circuit.remove(wire)
        for start, end in segments:
            ET.SubElement(circuit, 'wire', {'from': f'({start[0]},{start[1]})', 'to': f'({end[0]},{end[1]})'})
        for port in circuit.findall('appear/circ-port'):
            if port.get('pin') in pin_moves:
                port.set('pin', pin_moves[port.get('pin')])
        snapshot = w.project_store.freeze_circuit(circuit)
        loaded = self.inspect_snapshot(snapshot, name)
        if loaded['authority'] != 'exact-runtime':
            raise ValueError('原生运行时未接受此移动')
        checked_bits = assert_preserved_connections(view['components'], loaded['components'], set(ids), dx, dy)
        coverage = w.circuit_view(name).get('coverage', {})
        if any(loaded.get('coverage', {}).get(key, 0) > coverage.get(key, 0)
               for key in ('invalidBundleEnds', 'widthIncompatibilities')):
            raise ValueError('移动产生了电气冲突，请调整位置')
        if pin_moves:
            try:
                w.workbench._native(w.frozen_path, ET.Element('check-interface', circuit=name), snapshot.frozen_path)
            except Exception as error:
                raise ValueError('移动会改变父图的封装接口，请保持引脚顺序或先设置固定封装') from error
        target_revision = snapshot.revision_id
        return self.history.advance('move', f'移动 {len(targets)} 个元件、{len(wire_ids)} 段导线' if wire_ids else f'移动 {len(targets)} 个对象', target_revision, prepared=snapshot, circuits=[name], componentIds=ids, wireIds=sorted(wire_ids), delta={'x': dx, 'y': dy}, preservedPortBits=checked_bits)

    def wire(self, project_id, revision, body):
        self.history._check(project_id, revision)
        w = self.workspace
        if self.history.disk_status()['changed']:
            raise ValueError('磁盘工程已改变，请先处理外部改动')
        name = body.get('circuit')
        start, end = (body.get('start'), body.get('end'))
        raw_points = body.get('points')
        if raw_points is not None:
            if not isinstance(raw_points, list) or len(raw_points) < 2:
                raise ValueError('导线路径至少需要两个点')
            start, end = (raw_points[0], raw_points[-1])
        if not isinstance(name, str) or not isinstance(start, dict) or (not isinstance(end, dict)):
            raise ValueError('导线端点无效')
        try:
            a = (int(start['x']), int(start['y']))
            b = (int(end['x']), int(end['y']))
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError('导线端点必须是整数坐标') from error
        if a == b or any((value % 10 for value in (*a, *b))):
            raise ValueError('导线端点必须落在不同的十像素网格点')
        points = [start, end] if raw_points is None else raw_points
        parsed_points = []
        for point in points:
            if not isinstance(point, dict):
                raise ValueError('导线路径点无效')
            try:
                parsed_points.append((int(point['x']), int(point['y'])))
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError('导线路径点必须是整数坐标') from error
        if parsed_points[0] != a or parsed_points[-1] != b or any((p == q or any((value % 10 for value in (*p, *q))) or (p[0] != q[0] and p[1] != q[1]) for p, q in zip(parsed_points, parsed_points[1:]))):
            raise ValueError('导线路径必须由不同的正交网格点组成')
        inspected = w.workbench.inspect({'circuit': name})
        if inspected.get('authority') != 'exact-runtime':
            raise ValueError('原生端口信息不可用，不能安全布线')
        scene = w.circuit_view(name)['circuit']
        from_bits, to_bits = endpoint_bits(scene, a), endpoint_bits(scene, b)
        if len(from_bits) != len(to_bits):
            raise ValueError(f'端口位宽不匹配：{len(from_bits)} → {len(to_bits)}；请显式使用 Splitter')
        circuit = w.project_store.document.circuit(name)
        # Either end of a gesture may land on an existing wire. Only split at
        # the requested endpoints, never at an unrelated interior crossing.
        for node in list(circuit.findall('wire')):
            p, q = [tuple(int(v) for v in node.get(key).strip('()').split(',')) for key in ('from', 'to')]
            cuts = sorted({p, q, *(end for end in (a, b) if on_segment(end, p, q))})
            if len(cuts) > 2:
                circuit.remove(node)
                for start, end in zip(cuts, cuts[1:]):
                    ET.SubElement(circuit, 'wire', {'from': f'({start[0]},{start[1]})', 'to': f'({end[0]},{end[1]})'})
        wires = {(node.get('from'), node.get('to')) for node in circuit.findall('wire')}
        wire_keys = wires | {(end, start) for start, end in wires}
        segments = list(zip(parsed_points, parsed_points[1:]))
        existing_segments = [(f'({p[0]},{p[1]})', f'({q[0]},{q[1]})') in wire_keys for p, q in segments]
        if existing_segments and all(existing_segments):
            return w.session()
        if any(existing_segments):
            raise ValueError('导线已经存在')
        for p, q in segments:
            ET.SubElement(circuit, 'wire', {'from': f'({p[0]},{p[1]})', 'to': f'({q[0]},{q[1]})'})
        snapshot = w.project_store.freeze_circuit(circuit)
        loaded = self.inspect_snapshot(snapshot, name)
        if loaded.get('authority') != 'exact-runtime':
            raise ValueError('原生运行时未接受此导线')
        checked_bits = assert_preserved_connections(inspected['components'], loaded['components'], set(), 0, 0,
                                                    joins=zip(from_bits, to_bits))
        baseline_coverage = w.circuit_view(name).get('coverage', {})
        if any(loaded.get('coverage', {}).get(key, 0) > baseline_coverage.get(key, 0)
               for key in ('invalidBundleEnds', 'widthIncompatibilities')):
            raise ValueError('导线路径产生了位宽冲突，请调整拐点')
        target_revision = snapshot.revision_id
        return self.history.advance('wire', f'连接导线 ({a[0]},{a[1]}) → ({b[0]},{b[1]})', target_revision, prepared=snapshot, circuits=[name], start={'x': a[0], 'y': a[1]}, end={'x': b[0], 'y': b[1]}, points=[{'x': x, 'y': y} for x, y in parsed_points], segments=len(segments), preservedPortBits=checked_bits)

    def delete_wires(self, project_id, revision, body):
        return self.delete(project_id, revision, body)

    def delete(self, project_id, revision, body):
        self.history._check(project_id, revision)
        w = self.workspace
        if self.history.disk_status()['changed']:
            raise ValueError('磁盘工程已改变，请先处理外部改动')
        name = body.get('circuit')
        view = w.workbench.inspect({'circuit': name})
        if view.get('authority') != 'exact-runtime':
            raise ValueError('原生元件信息不可用，不能安全删除对象')
        ids = selection_ids(body, 'componentIds')
        if not ids and body.get('componentId'): ids={body['componentId']}
        wires = selection_ids(body, 'wireIds')
        targets = [c for c in view['components'] if c['componentId'] in ids]
        if len(targets) != len(ids) or not (ids or wires):
            raise ValueError('请选择当前电路中的元件或导线')
        circuit = w.project_store.document.circuit(name)
        remove_wires(circuit, w.circuit_view(name)['circuit'], wires)
        target_keys = {(target['factory'], target['location']['x'], target['location']['y']) for target in targets}
        components = []
        removed = 0
        for node in circuit.findall('comp'):
            point = tuple((int(value) for value in node.get('loc', '(0,0)').strip('()').split(',')))
            if (node.get('name'), *point) in target_keys:
                removed += 1
            else:
                components.append(node)
        if removed != len(targets):
            raise ValueError('对象位置不唯一，不能安全删除')
        for node in list(circuit):
            if node.tag == 'comp' and node not in components:
                circuit.remove(node)
        appearance = circuit.find('appear')
        if appearance is not None:
            pin_locations = {f"{target['location']['x']},{target['location']['y']}" for target in targets if target['factory'] == 'Pin'}
            for port in appearance.findall('circ-port'):
                if port.get('pin') in pin_locations:
                    appearance.remove(port)
        snapshot = w.project_store.freeze_circuit(circuit)
        loaded = self.inspect_snapshot(snapshot, name)
        if loaded['authority'] != 'exact-runtime' or any((c['factory'] == target['factory'] and c['location'] == target['location'] for target in targets for c in loaded['components'])):
            raise ValueError('原生运行时未接受此删除')
        target_revision = snapshot.revision_id
        title = f'删除 {len(targets)} 个元件、{len(wires)} 段导线' if ids and wires else f'删除 {len(targets)} 个对象' if ids else f'删除 {len(wires)} 段导线'
        return self.history.advance('delete' if ids else 'delete-wire', title, target_revision, prepared=snapshot, circuits=[name], componentIds=sorted(ids), wireIds=sorted(wires))


