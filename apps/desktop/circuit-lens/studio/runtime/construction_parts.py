"""Prepare model-requested parts using the same native tools as the palette.

Only the running library knows a component's defaults, attributes and ports.
The returned XML is a native serialization, not a second component catalog.
"""
import copy
import re
import xml.etree.ElementTree as ET

from studio.domain.tool_errors import CircuitToolError


def _template_feedback(workbench, circuit, additions):
    """Resolve compact native hints only after a template request fails.

    The normal construction path already asks the native worker for all
    templates. Re-querying the palette is deliberately failure-only: the
    model gets actionable attribute choices without making successful builds
    pay for a second discovery pass.
    """
    workspace = workbench.workspace
    record = getattr(workspace.history, 'record', None) or {}
    hints = []
    def compact(value, limit=256):
        if isinstance(value, str) and len(value) > limit:
            return value[:limit] + '…'
        return value

    for item in additions[:8]:
        hint = {
            'id': item.get('id'),
            'factory': item.get('factory'),
            'library': item.get('library') if 'library' in item else None,
            'requestedAttributes': dict(item.get('attributes') or {}),
        }
        try:
            body = {
                'projectId': record.get('id'),
                'revisionId': workspace.revision_id,
                'circuit': circuit,
                'tool': item.get('factory'),
            }
            if 'library' in item:
                body['library'] = item['library']
            described = workspace.application.placement.describe(body)
            attributes = []
            for attribute in (described.get('attributes') or [])[:24]:
                attributes.append({
                    key: compact(attribute.get(key))
                    for key in ('name', 'value', 'standard', 'editable')
                    if key in attribute
                } | {
                    'options': [
                        {key: compact(option.get(key), 128) for key in ('value', 'label') if key in option}
                        for option in (attribute.get('options') or [])[:16]
                    ],
                })
            hint['effectiveAttributes'] = attributes
            hint['ports'] = [
                {key: port.get(key) for key in ('index', 'width', 'direction', 'runtimeTooltip') if key in port}
                for port in (described.get('ports') or [])[:24]
            ]
        except Exception as lookup_error:
            hint['lookupError'] = str(lookup_error)
        hints.append(hint)
    if len(additions) > len(hints):
        hints.append({'truncated': True, 'omittedCount': len(additions) - len(hints)})
    return hints


def _template_rejection(workbench, circuit, additions, error):
    return CircuitToolError(
        'NATIVE_COMPONENT_TEMPLATE_REJECTED',
        str(error) or '原生组件模板拒绝了新增部件或属性',
        hint='按 context.nativeTemplates 中对应部件的 effectiveAttributes 和 ports 修正 factory、library 或 attributes；不要把几何 size 当作数据 width。',
        context={
            'nativeMessage': str(error),
            'nativeTemplates': _template_feedback(workbench, circuit, additions),
        },
    )


def pin_interface(workbench, artifact, circuit):
    symbol = workbench._native(artifact, ET.Element('interface', circuit=circuit)).find('symbol')
    if symbol is None:
        raise ValueError(f'{circuit}: 原生查询未返回接口，无法确认新增 Pin 的影响')
    uses = symbol.findall('use')
    if uses:
        parents = ', '.join(dict.fromkeys(use.get('circuit') for use in uses))
        raise ValueError(f'{circuit}: 已有父实例（{parents}），wire_candidate 不能新增 Pin 或改变父实例端口映射；'
                         '请使用编辑器的「封装与接口」编辑，或直接编辑 .circ 并同步调整父实例接线')
    return {pin.get('id'): dict(pin.attrib) for pin in symbol.findall('pin')}


def check_interfaces(workbench, before, after, circuit, added_pins):
    """Only an explicitly extended, uninstantiated interface may change."""
    if added_pins:
        old = pin_interface(workbench, before, circuit)
        new = pin_interface(workbench, after, circuit)
        expected = {f'{x},{y}' for _, (x, y) in added_pins}
        if (set(new) != set(old) | expected or expected & set(old)
                or any(new.get(key) != pin for key, pin in old.items())):
            raise ValueError(f'{circuit}: 新增 Pin 未完整保留已有引脚或引脚集合与 additions 不符')
        # Only this definition is replaced and it has no parents. Other definitions
        # cannot change, so do not reload the runtime once per unrelated circuit.
        return
    workbench._native(before, ET.Element('check-interface', circuit=circuit), after)


def prepare_parts(workbench, artifact, circuit, additions, aliases, libraries):
    if not additions:
        return []
    request = ET.Element('component-templates', circuit=circuit)
    for library in libraries:
        ET.SubElement(request, 'library', id=library['name'], desc=library['desc'])
    seen = set(aliases)
    for item in additions:
        if not isinstance(item, dict):
            raise ValueError('新增部件需要 id、factory 和 location')
        alias, tool, location = item.get('id'), item.get('factory'), item.get('location')
        if not isinstance(alias, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,47}', alias) or alias in seen:
            raise ValueError('新增部件 id 必须唯一且不能与已有 componentId 冲突')
        seen.add(alias)
        if not isinstance(tool, str) or not 1 <= len(tool) <= 1024:
            raise ValueError(f'{alias}: factory 需为原生目录中的完整 tool 名称')
        if not isinstance(location, dict) or any(type(location.get(k)) is not int or not 0 <= location[k] <= 6000 or location[k] % 10 for k in ('x', 'y')):
            raise ValueError(f'{alias}: 部件位置需在 0–6000 的 10 单位网格上')
        part = ET.SubElement(request, 'component', id=alias, tool=tool)
        if 'library' in item:
            if not isinstance(item['library'], str):
                raise ValueError(f'{alias}: library 需为目录中的库 ID；当前文件子电路使用空字符串')
            part.set('library', item['library'])
        attrs = item.get('attributes', {})
        if not isinstance(attrs, dict) or len(attrs) > 128 or any(not isinstance(k, str) or not isinstance(v, str) or len(v) > 4096 for k, v in attrs.items()):
            raise ValueError(f'{alias}: 属性必须为原生属性名与字符串值')
        for name, value in attrs.items():
            ET.SubElement(part, 'set', name=name, value=value)
    try:
        result = workbench._native(artifact, request)
    except ValueError as error:
        raise _template_rejection(workbench, circuit, additions, error) from error
    templates = result.findall('template')
    if [part.get('id') for part in templates] != [item['id'] for item in additions]:
        raise ValueError('原生组件查询未完整返回请求部件')
    descriptors = {lib['name']: lib['desc'] for lib in libraries}
    prepared = []
    occupied = set(aliases.values())
    checked_pin_interface = False
    for item, template in zip(additions, templates):
        component = template.find('comp')
        if component is None or not template.get('factory') or component.get('name') != template.get('factory'):
            raise ValueError(f'{item["id"]}: 原生组件查询未返回有效部件')
        factory = template.get('factory')
        if descriptors.get(component.get('lib')) == '#Wiring':
            if factory == 'Tunnel':
                raise ValueError(f'{item["id"]}: 物理连线工具不新增 Tunnel；直接文件编辑仍可用')
            if factory == 'Pin' and not checked_pin_interface:
                pin_interface(workbench, artifact, circuit)
                checked_pin_interface = True
        location = item['location']
        key = factory, (location['x'], location['y'])
        if key in occupied:
            raise ValueError(f'{item["id"]}: 新增部件与已有部件位置重复')
        occupied.add(key)
        component = copy.deepcopy(component)
        component.set('loc', f'({location["x"]},{location["y"]})')
        # Strict native parsing already validated each override. Reload checks
        # compare its effective value, not its input spelling (e.g. 0 -> 0x0).
        effective = {a.get('name'): a.get('value') for a in template.findall('attribute')}
        expected = {}
        for name in item.get('attributes', {}):
            if effective.get(name) is None:
                raise ValueError(f'{item["id"]}: 原生模板未返回请求属性 {name}')
            expected[name] = effective[name]
        prepared.append((item['id'], key, component, expected))
    return prepared
