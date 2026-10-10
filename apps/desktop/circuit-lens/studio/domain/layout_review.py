"""Bounded, read-only geometry feedback for any native-loaded artifact.

Use the runtime's measured rectangles, not the arranger's planned positions.
Intersections are candidates for visual review, not a readability verdict.
"""
from collections import Counter
import math
import re

from studio.domain.tool_errors import CircuitToolError
from studio.domain.reading_paths import reading_paths


def review_options(args):
    if 'layoutReview' not in args:
        return None
    options = args['layoutReview']
    if (not isinstance(options, dict) or set(options) - {'issueOffset', 'artifactSha256'}
            or type(options.get('issueOffset', 0)) is not int
            or options.get('issueOffset', 0) < 0):
        raise CircuitToolError('INVALID_ARGUMENT',
                               'layoutReview 必须是对象；可选 issueOffset 为非负整数。',
                               hint='首次查看使用 layoutReview:{}；不要填写占位摘要。')
    if not args.get('circuit'):
        raise CircuitToolError('INVALID_ARGUMENT', 'layoutReview 需要指定 circuit。')
    conflicts = [k for k in ('layoutContext', 'componentDirectory', 'portConnections',
                            'componentIds', 'includeNets', 'netFormat', 'includeWires',
                            'wireOffset', 'wireLimit') if k in args]
    if conflicts:
        raise CircuitToolError('INVALID_ARGUMENT',
                               'layoutReview 与以下参数冲突：' + ', '.join(conflicts) + '。',
                               hint='每次只选一种观察方式。查看布局时只保留 circuit、layoutReview 和可选 candidateId；'
                                    '查看元件或连接时删除 layoutReview。不需要的字段直接省略，不要填空对象、空数组或 false。',
                               context={'conflictingParameters': conflicts})
    digest = options.get('artifactSha256')
    if ((digest is not None and (not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest)))
            or (options.get('issueOffset', 0) > 0 and digest is None)):
        raise CircuitToolError('INVALID_ARGUMENT', '布局问题续页需要上一页的 artifactSha256（64 位小写十六进制）。')
    return options


def _box(bounds):
    if not isinstance(bounds, dict):
        return None
    values = [bounds.get(k) for k in ('x', 'y', 'width', 'height')]
    if any(type(v) not in (int, float) or not math.isfinite(v) for v in values):
        return None
    x, y, w, h = values
    return (x, y, x+w, y+h) if w > 0 and h > 0 else None


def _intersection(a, b):
    if not a or not b:
        return None
    x, y = max(a[0], b[0]), max(a[1], b[1])
    w, h = min(a[2], b[2])-x, min(a[3], b[3])-y
    # Ignore boundary contacts and tiny protrusions at connected ports.
    return {'x': x, 'y': y, 'width': w, 'height': h} if w >= 3 and h >= 3 else None


def _identity(component):
    attrs = {a['name']: a.get('standard', a.get('value'))
             for a in component.get('attributes', []) if isinstance(a, dict) and 'name' in a}
    label = str(attrs.get('label') or attrs.get('text') or '')
    return {'componentId': component['componentId'], 'factory': component['factoryName'],
            'label': label[:160], 'labelTruncated': len(label) > 160,
            'location': component.get('location')}


def layout_review(focus, *, issue_offset=0):
    components = focus.get('components', [])
    counts = Counter(c['factoryName'] for c in components)
    entries, missing, fallback = [], 0, 0
    for c in components:
        visual, body = _box(c.get('visualBounds')), _box(c.get('bounds'))
        if visual is None:
            fallback += 1
        if not (visual or body):
            missing += 1
            continue
        entries.append((visual or body, body, c))
    entries.sort(key=lambda entry: (entry[0][0], entry[0][1], entry[2]['componentId']))
    active, examples, kinds = [], [], Counter()
    total = 0
    for box, body, c in entries:
        active = [item for item in active if item[0][2] >= box[0]+3]
        for other_box, other_body, other in active:
            overlap = _intersection(box, other_box)
            if not overlap:
                continue
            factories = {c['factoryName'], other['factoryName']}
            if factories <= {'Tunnel', 'Text'}:
                kind = 'label-label'
            elif factories & {'Tunnel', 'Text'}:
                kind = 'label-component'
            elif _intersection(body, other_body):
                kind = 'component-body'
            else:
                kind = 'visual-bounds'
            kinds[kind] += 1
            if issue_offset <= total < issue_offset+24:
                x0, y0 = min(box[0], other_box[0])-24, min(box[1], other_box[1])-24
                x1, y1 = max(box[2], other_box[2])+24, max(box[3], other_box[3])+24
                # A huge symbol should not shrink a local warning into an unreadable overview.
                width, height = max(320, min(640, x1-x0)), max(180, min(480, y1-y0))
                x0, y0 = (x0+x1-width)/2, (y0+y1-height)/2
                if max(box[2], other_box[2])-min(box[0], other_box[0])+48 > 640:
                    x0 = overlap['x']+overlap['width']/2-width/2
                if max(box[3], other_box[3])-min(box[1], other_box[1])+48 > 480:
                    y0 = overlap['y']+overlap['height']/2-height/2
                examples.append({'kind': kind, 'objects': [_identity(other), _identity(c)],
                                 'intersection': overlap,
                                 'viewport': {'x': math.floor(x0), 'y': math.floor(y0),
                                              'width': math.ceil(width), 'height': math.ceil(height), 'scale': 1.5}})
            total += 1
        active.append((box, body, c))
    return {
        'schema': 'vibe-logisim.layout-review/v1', 'status': 'observed',
        'scope': 'One definition; does not review child definitions, template preservation or behavior.',
        'method': 'Native visual/body bounding-box intersections of at least 3 units on both axes; wires excluded.',
        'counts': {'components': len(components), 'tunnels': counts['Tunnel'],
                   'wireSegments': len(focus.get('wires', []))},
        'countsScope': 'native-loaded; wire segments may be split or merged relative to serialized XML',
        'bounds': focus.get('bounds'),
        'coverage': {'measuredComponents': len(entries), 'missingBounds': missing,
                     'withoutNativeVisualBounds': fallback},
        'overlapPairs': total, 'byKind': dict(sorted(kinds.items())),
        'readingPaths': reading_paths(focus),
        'issueOffset': issue_offset, 'examples': examples,
        'nextIssueOffset': issue_offset+len(examples) if issue_offset+len(examples) < total else None,
        'note': '疑似遮挡，需看原生局部图确认；外包矩形相交不一定是可见笔画相交。'
                '包括原有/固定区域，不代表允许移动它们。0 对相交不证明组织清楚，线段/隧道数量不是评分。'
                'examples 已限制为 24 对；viewport 可传给 render_circuit。',
    }
