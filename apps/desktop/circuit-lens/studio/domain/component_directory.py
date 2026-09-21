"""Optional, version-bound discovery pages. No circuit mutation or net inference."""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import re

from studio.domain.tool_errors import CircuitToolError


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def directory_options(args):
    if 'componentDirectory' not in args:
        return None
    options = args['componentDirectory']
    if (not isinstance(options, dict) or set(options) - {'maxBytes', 'cursor'}
            or not isinstance(args.get('circuit'), str) or not args['circuit']
            or any(key in args for key in ('portConnections', 'componentIds', 'includeNets', 'netFormat', 'includeWires', 'wireOffset', 'wireLimit'))):
        raise CircuitToolError('INVALID_ARGUMENT', '组件目录需要 circuit，且不能与端口连接、详情或导线选项混用。',
                               hint='使用 componentDirectory: {maxBytes?, cursor?}；详情另用 componentIds。')
    budget = options.get('maxBytes', 24000)
    cursor = options.get('cursor')
    if type(budget) is not int or not 1024 <= budget <= 32000:
        raise CircuitToolError('INVALID_ARGUMENT', 'componentDirectory.maxBytes 必须为 1024–32000 的整数。')
    if 'cursor' in options and (not isinstance(cursor, str) or not re.fullmatch(r'd1:[0-9a-f]{64}:[1-9][0-9]{0,11}', cursor)):
        raise CircuitToolError('INVALID_COMPONENT_CURSOR', '组件目录游标格式无效。',
                               hint='使用返回的 nextCursor，或省略 cursor 从第一页开始。')
    return budget, cursor


def component_directory(view, *, identity, options, response_metadata=None):
    """Budget the complete compact JSON, including the actual invocation.

    Hash the actual static observation as well as the artifact: an unchanged
    file alone cannot establish stable native IDs, library or runtime facts.
    No simulation state participates in discovery or continuation.
    """
    budget, cursor = options
    circuit = view['circuit']
    exact = bool(view.get('capabilities', {}).get('exactConnectivity')) and not view.get('observerError')
    # CircuitQueries carries the full observationProfile (id, runtime JAR and
    # observer digests) in capabilities, plus the observed runtime separately.
    # Include both even without render metadata; no second profile ID source.
    observation = {key: view.get(key) for key in ('circuit', 'capabilities', 'unknowns', 'observerError', 'runtime')}
    digest = hashlib.sha256(_json([identity, observation]).encode('utf-8')).hexdigest()
    components = circuit['components']
    offset = 0
    if cursor:
        _, bound, position = cursor.split(':')
        offset = int(position)
        if bound != digest:
            raise CircuitToolError('STALE_COMPONENT_CURSOR', '电路版本或实际观察已变化，不能续接旧目录页。',
                                   hint='省略 cursor 重新发现；不要把旧页 ID 与新页混用。')
        if not 0 < offset < len(components):
            raise CircuitToolError('INVALID_COMPONENT_CURSOR', '组件目录游标位置无效。',
                                   hint='使用本次目录返回的 nextCursor，或省略 cursor。')
    result = {
        'schema': 'vibe-logisim.component-directory/v1', **identity,
        'authority': 'exact-runtime' if exact else 'geometry-only',
        'error': deepcopy(view.get('observerError')),
        'unknowns': deepcopy(view.get('unknowns', [])),
        'scope': 'Static components with circuit-coordinate locations, bounds and indexed port geometry. '
                 'ends=null means ports unavailable; [] means observed zero ports. Null fields remain unknown. '
                 'Directions and semanticRole describe verified runtime ports, not a behavior verdict. '
                 'Corrected directions retain nativeDirection and directionSource. '
                 'Attributes and bit nets remain available with componentIds or full inspect; no simulation values.',
        **(response_metadata or {}),
        'components': [],
    }
    entries_bytes = 0

    def page_size(returned, payload_bytes):
        next_offset = offset + returned
        page = {'offset': offset, 'total': len(components), 'returned': returned,
                'nextCursor': f'd1:{digest}:{next_offset}' if next_offset < len(components) else None,
                'maxBytes': budget, 'bytes': 0}
        # Components stay [] here. Add the measured complete entry encodings
        # and commas; serialize metadata only as the page grows, not its prefix.
        size = len(_json({**result, 'components': [], 'page': page}).encode('utf-8')) + payload_bytes
        while page['bytes'] != size:
            page['bytes'] = size
            size = len(_json({**result, 'components': [], 'page': page}).encode('utf-8')) + payload_bytes
        return page

    page = page_size(0, 0)
    for component in components[offset:]:
        entry = {key: deepcopy(component.get(key)) for key in
                 ('componentId', 'factory', 'label', 'location', 'bounds', 'subcircuit')}
        ends = component.get('ends')
        entry['ends'] = [{**{key: deepcopy(end.get(key)) for key in
                          ('index', 'location', 'width', 'direction', 'exclusive', 'semanticRole', 'runtimeTooltip')},
                         **{key: deepcopy(end[key]) for key in ('nativeDirection', 'directionSource') if key in end}}
                         for end in ends] if exact and isinstance(ends, list) else None
        size = entries_bytes + bool(result['components']) + len(_json(entry).encode('utf-8'))
        proposed = page_size(len(result['components']) + 1, size)
        if proposed['bytes'] > budget:
            if result['components']:
                break
            raise CircuitToolError('COMPONENT_DIRECTORY_BUDGET', '完整组件条目及必要页信息超过字节预算；未跳过或截断条目。',
                                   hint='提高 maxBytes（上限 32000），或用 componentIds/完整 inspect 在脚本内读取。',
                                   context={'componentId': component.get('componentId'), 'offset': offset,
                                            'maxBytes': budget, 'requiredBytes': proposed['bytes']})
        result['components'].append(entry)
        entries_bytes, page = size, proposed
    if page['bytes'] > budget:
        raise CircuitToolError('COMPONENT_DIRECTORY_BUDGET', '必要目录元数据超过字节预算。',
                               hint='提高 maxBytes（上限 32000），或使用完整 inspect 在脚本内读取。',
                               context={'maxBytes': budget, 'requiredBytes': page['bytes']})
    result['page'] = page
    return result
