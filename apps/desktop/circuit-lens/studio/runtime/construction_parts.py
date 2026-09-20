"""Prepare model-requested parts using the same native tools as the palette.

Only the running library knows a component's defaults, attributes and ports.
The returned XML is a native serialization, not a second component catalog.
"""
import copy
import re
import xml.etree.ElementTree as ET


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
    result = workbench._native(artifact, request)
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
        prepared.append((item['id'], key, component, item.get('attributes', {})))
    return prepared
