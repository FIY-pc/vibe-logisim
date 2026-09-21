"""Component references and manual placement from native library tools.

Preview is transient. A successful placement publishes exactly one ordinary
circuit revision; callers keep the normal save/undo and source protections.
"""
import copy
import json
import re
import xml.etree.ElementTree as ET
from collections import OrderedDict

from studio.domain.tool_errors import CircuitToolError

class PlacementService:
    def __init__(self, workspace, inspect_snapshot):
        self.w = workspace
        self.inspect = inspect_snapshot
        self.cache = OrderedDict()
        self.catalog_revision = None
        self.catalog_id = None

    def catalog_identity(self):
        """The palette depends on libraries, symbols and the dependency graph,
        not wires, gate positions or ordinary component placements."""
        w = self.w
        if self.catalog_revision != w.revision_id:
            self.catalog_id = w.project_store.document.palette_identity(w.package.dependencies)
            self.catalog_revision = w.revision_id
        return self.catalog_id

    def _check(self, body):
        w = self.w
        w.application._revision(body)
        name = body.get('circuit')
        if not isinstance(name, str) or not any(c['name'] == name for c in w.raw_project['circuits']):
            raise ValueError('请选择当前文件中的电路')
        return name

    def _request(self, operation, body):
        request = ET.Element(operation, circuit=body['circuit'])
        if operation != 'component-catalog':
            library, tool, values = body.get('library', ''), body.get('tool'), body.get('attributes', {})
            if not isinstance(library, str) or not isinstance(tool, str) or not 1 <= len(tool) <= 1024:
                raise ValueError('请选择组件库中的元件')
            if not isinstance(values, dict) or len(values) > 128 or any(not isinstance(k, str) or not isinstance(v, str) or len(v) > 4096 for k, v in values.items()):
                raise ValueError('元件属性无效')
            request.set('library', library); request.set('tool', tool)
            for name, value in values.items():
                ET.SubElement(request, 'set', name=name, value=value)
        if operation == 'place-component':
            for axis in ('x', 'y'):
                value = body.get(axis)
                if type(value) is not int or abs(value) > 1_000_000 or value % 10:
                    raise ValueError('请将元件放在十像素网格上')
                request.set(axis, str(value))
        return request

    def _native(self, operation, body, *, include_images=True, strict_attributes=False):
        request = self._request(operation, body)
        if not include_images:
            request.set('images', 'false')
        if strict_attributes:
            request.set('strictAttributes', 'true')
        with self.w.observation_artifact() as artifact:
            for lib in self.w.raw_project['libraries']:
                ET.SubElement(request, 'library', id=lib.get('name'), desc=lib.get('desc'))
            try:
                return self.w.workbench._native(artifact, request)
            except ValueError as error:
                match = re.search(r'java\.lang\.(?:IllegalArgumentException|IllegalStateException): ([^\n]+)', str(error))
                if match:
                    raise ValueError(match[1]) from error
                raise

    def query(self, kind, body, *, include_images=True, strict_attributes=False):
        with self.w.lock:
            if kind not in {'catalog', 'template'}:
                raise ValueError('未知元件查询')
            self._check(body)
            binding = {k: body[k] for k in ('projectId', 'revisionId', 'circuit')}
            key = (kind, include_images, strict_attributes, self.catalog_identity(), json.dumps({k:v for k,v in body.items() if k not in {'projectId','revisionId'}}, ensure_ascii=False, sort_keys=True))
            if key in self.cache:
                self.cache.move_to_end(key)
                return {**copy.deepcopy(self.cache[key]), **binding}
            native = self._native('component-catalog' if kind == 'catalog' else 'component-template', body,
                                  include_images=include_images, strict_attributes=strict_attributes)
            result = binding
            if kind == 'catalog':
                result['groups'] = [{**g.attrib, 'tools': [dict(t.attrib) for t in g.findall('tool')]} for g in native.findall('group')]
            else:
                result.update(native.attrib)
                result['bounds'] = {k: int(v) for k, v in native.find('bounds').attrib.items()}
                result['ports'] = [{
                    **{k: int(p.get(k)) for k in ('index', 'x', 'y', 'width')},
                    'direction': p.get('direction'), 'exclusive': p.get('exclusive') == 'true',
                    'runtimeTooltip': p.get('runtimeTooltip'),
                    **{key: p.get(key) for key in ('nativeDirection', 'directionSource', 'semanticRole')
                       if key in p.attrib},
                } for p in native.findall('port')]
                result['attributes'] = [{**a.attrib, 'editable': a.get('editable') == 'true', 'options': [dict(o.attrib) for o in a.findall('option')]} for a in native.findall('attribute')]
                result['xml'] = ET.tostring(native.find('comp'), encoding='unicode')
                image = native.find('image')
                if image is not None:
                    result['image'] = {**{k: int(v) for k, v in image.attrib.items()}, 'url': image.text}
            self.cache[key] = copy.deepcopy(result)
            while len(self.cache) > 96:
                self.cache.popitem(last=False)
            return result

    def describe(self, body):
        """Optional model projection of the same native palette used by the UI."""
        template = 'tool' in body
        if not template and 'attributes' in body:
            raise ValueError('请指定 tool 查询元件属性，或只提供 circuit 查询目录')
        if template and 'library' not in body:
            catalog_body = {
                key: body[key] for key in ('projectId', 'revisionId', 'circuit') if key in body
            }
            catalog = self.query('catalog', catalog_body, include_images=False, strict_attributes=True)
            matches = []
            for group in catalog.get('groups', []):
                library = group.get('id') or ''
                for tool in group.get('tools', []):
                    if tool.get('name') == body.get('tool'):
                        matches.append({'library': library, 'tool': tool['name']})
            if not matches:
                raise CircuitToolError(
                    'UNKNOWN_COMPONENT',
                    f'当前文件没有名为 {body.get("tool")} 的可放置元件。',
                    hint='先用 describe_component({circuit}) 读取当前项目的精确元件目录。',
                    context={'tool': body.get('tool'), 'matches': []},
                )
            if len(matches) > 1:
                raise CircuitToolError(
                    'AMBIGUOUS_COMPONENT',
                    f'元件名 {body.get("tool")} 在当前文件的多个组件库中存在。',
                    hint='从 context.matches 选择正确的 library 后重试。',
                    context={'tool': body.get('tool'), 'matches': matches},
                )
            body = {**body, 'library': matches[0]['library']}
        elif template and body.get('library'):
            # The native project stores numeric library IDs, while the same
            # catalog exposes human-readable descriptions such as #Wiring.
            # Accept either exact project-local spelling without guessing
            # across projects, and keep the returned binding canonical.
            library = body['library']
            libraries = [lib for lib in self.w.raw_project.get('libraries', [])
                         if isinstance(lib, dict)]
            alias_matches = [lib.get('name') for lib in libraries
                             if lib.get('desc') == library and isinstance(lib.get('name'), str)]
            if len(alias_matches) == 1:
                body = {**body, 'library': alias_matches[0]}
        result = self.query('template' if template else 'catalog', body, include_images=False, strict_attributes=True)
        result.update(kind='template' if template else 'catalog', authority='exact-runtime',
                      libraryScope='Library IDs belong to this project only; empty library means a subcircuit in this file.')
        if not template and 'library' in body:
            groups = result['groups']
            result['groups'] = [group for group in groups if group['id'] == body['library']]
            if not result['groups']:
                ids = ', '.join(group['id'] for group in groups if group['id'])
                raise ValueError(f'组件库不在当前文件中: {body["library"]}；当前库 ID: {ids}；当前文件的子电路使用空字符串')
        if template:
            result.update(library=body['library'], tool=body['tool'], origin={'x': 0, 'y': 0},
                          coordinates='Bounds and indexed ports are offsets from comp loc=(0,0). Change loc to place the XML and add that location to every port offset. This query does not place anything.',
                          attributeSemantics='Values are effective native standard strings after overrides; without overrides they are current library-tool defaults, not necessarily factory defaults. Only editable attributes accept overrides. Native-accepted decimal/0x hexadecimal integer formats may normalize only when exactly equal (e.g. 0 to 0x0). Other values require native standard strings. Unsupported, truncated or normalized-away values are rejected.')
        return result

    def place(self, body):
        w = self.w
        name = self._check(body)
        if w.history.disk_status()['changed']:
            raise ValueError('文件已在外部修改，请先读取当前版本')
        native = self._native('place-component', body)
        circuit = w.project_store.document.circuit(name)
        serialized = native.find('comp')
        # Preserve every existing element, appearance and library identifier.
        # Only the new component is serialized from the native factory defaults.
        before_count = len(circuit.findall('comp'))
        circuit.append(copy.deepcopy(serialized))
        snapshot = w.project_store.freeze_circuit(circuit)
        # The native loader validates the frozen file and its electrical widths.
        # Complete net descriptions and pixels are read projections, requested
        # only when a caller needs to display/inspect the resulting revision.
        check = ET.Element('check-placement', circuit=name, factory=native.get('factory'),
                           count=str(before_count + 1), x=str(body['x']), y=str(body['y']))
        for attr in native.findall('attribute'):
            if attr.get('name') in body.get('attributes', {}):
                ET.SubElement(check, 'attribute', name=attr.get('name'), value=attr.get('value'))
        w.workbench._native(w.frozen_path, check, snapshot.frozen_path)
        return w.history.advance('place', '放置 ' + native.get('factory'), snapshot.revision_id,
                                 prepared=snapshot, circuits=[name], factory=native.get('factory'), location={'x': body['x'], 'y': body['y']})
