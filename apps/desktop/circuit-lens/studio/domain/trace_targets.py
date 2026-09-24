"""Validate trace references against one native observation, without guessing IDs."""
from __future__ import annotations

from studio.domain.tool_errors import CircuitToolError


def validate_trace_targets(components, watches, *, circuit, artifact_sha, program=None, reset=None):
    issues, names = [], {}

    def component_at(reference, path, factory=None, hint_label=None):
        component = components.get(reference) if isinstance(reference, str) else None
        if component is None:
            issue = {'path': path, 'code': 'UNKNOWN_COMPONENT', 'requested': reference}
            candidates = candidates_for(reference, hint_label, factory)
            if candidates:
                issue['candidates'] = candidates
            issues.append(issue)
            return None
        if factory is not None and component['factoryName'] != factory:
            issues.append({'path': path, 'code': 'WRONG_FACTORY', 'requested': reference,
                           'expectedFactory': factory, 'actualComponent': describe(component)})
        return component

    def describe(component):
        ends = component.get('ends') or []
        return {'componentId': component['componentId'], 'factory': component['factoryName'],
                'label': (component.get('selector') or {}).get('label'), 'location': component.get('location'),
                'ports': [{key: end.get(key) for key in ('index', 'width', 'direction', 'runtimeTooltip')}
                          for end in ends[:32]],
                'portCount': len(ends), 'portsTruncated': len(ends) > 32}

    def candidates_for(reference, hint_label, factory):
        """Parts the caller probably meant: same label as the watch name, or the
        part now anchored nearest to where a stale location-derived ID pointed."""
        found = []
        if isinstance(hint_label, str):
            found += [c for c in components.values()
                      if (c.get('selector') or {}).get('label') == hint_label and c['factoryName'] != 'Tunnel'
                      and (factory is None or c['factoryName'] == factory)]
        if isinstance(reference, str) and reference.startswith('c') and not found:
            try:
                x, y = (int(t.replace('m', '-')) for t in reference[1:].split('_')[:2])
            except ValueError:
                x = y = None
            if x is not None:
                near = sorted((c for c in components.values() if factory is None or c['factoryName'] == factory),
                              key=lambda c: abs(c['location']['x'] - x) + abs(c['location']['y'] - y))
                found += [c for c in near[:3] if abs(c['location']['x'] - x) + abs(c['location']['y'] - y) <= 60]
        return [{'componentId': c['componentId'], 'factory': c['factoryName'],
                 'label': (c.get('selector') or {}).get('label'), 'location': c.get('location'),
                 'portCount': len(c.get('ends') or [])} for c in found[:6]]

    for index, watch in enumerate(watches):
        path = f'watches[{index}]'
        if not isinstance(watch, dict):
            issues.append({'path': path, 'code': 'INVALID_WATCH'})
            continue
        name, port = watch.get('name'), watch.get('port')
        if not isinstance(name, str) or not 1 <= len(name) <= 80:
            issues.append({'path': path + '.name', 'code': 'INVALID_NAME', 'requested': name})
        elif name in names:
            issues.append({'path': path + '.name', 'code': 'DUPLICATE_NAME',
                           'requested': name, 'firstPath': f'watches[{names[name]}].name'})
        else:
            names[name] = index
        component = component_at(watch.get('component'), path + '.component', hint_label=name if isinstance(name, str) else None)
        if component is not None and (type(port) is not int or not any(
                end['index'] == port for end in component.get('ends') or [])):
            issues.append({'path': path + '.port', 'code': 'UNKNOWN_PORT', 'requested': port,
                           'actualComponent': describe(component)})
    if reset is not None:
        component_at(reset, 'resetButton', 'Button')
    if isinstance(program, dict):
        component_at(program.get('component'), 'program.component', 'ROM')
    if issues:
        paths = '、'.join(issue['path'] for issue in issues)
        raise CircuitToolError('INVALID_TRACE_TARGETS', f'时序观察目标无效：{paths}',
            hint='按 context.issues 修正目标；actualComponent 给出该 ID 的实际元件和可用端口，candidates 列出同名或最近的元件。'
                 'componentId 由锚点坐标构成（c<x>_<y>）：元件被移动或删除后旧 ID 失效；不猜测替代元件。',
            context={'circuit': circuit, 'artifactSha256': artifact_sha, 'issues': issues})
