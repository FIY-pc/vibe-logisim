"""Adapt frozen Logisim definitions and native observations into review rows."""
from collections import Counter, defaultdict
from studio.project.changes import component_pairs, definition_diff, point, signature
from studio.domain.connection_diff import compare_connections

PRESENTATION = {'位置', 'facing', 'labelloc', 'labelfont', 'labelcolor', 'font', 'color', 'halign', 'valign'}
INTERFACE = {'label', 'width', 'output', 'tristate', 'pull'}


def appearance_details(before, after):
    """Show external port geometry and its source Pin binding separately."""
    appearances = [c.find('appear') if c is not None else None for c in (before, after)]
    ports = [{(p.get('x'), p.get('y')):p for p in a.findall('circ-port')} if a is not None else {} for a in appearances]
    details = []
    for key in sorted(ports[0].keys() | ports[1].keys()):
        a,b = ports[0].get(key),ports[1].get(key)
        if signature(a)==signature(b): continue
        def describe(p):
            if p is None: return '不存在'
            return f"引脚 ({p.get('pin')}) · {p.get('width')} × {p.get('height')}"
        details.append({'name':f'封装端口 ({key[0]}, {key[1]})', 'before':describe(a), 'after':describe(b)})
    shapes = [tuple(sorted((signature(p) for p in a if p.tag!='circ-port'),key=repr)) if a is not None else () for a in appearances]
    if shapes[0]!=shapes[1]:
        details.append({'name':'封装图形', 'before':'原图形与锚点', 'after':'图形或锚点已更新'})
    binding_only = bool(details) and shapes[0]==shapes[1] and ports[0].keys()==ports[1].keys() and all(
        signature(ports[0][key],('pin',))==signature(ports[1][key],('pin',)) for key in ports[0])
    return details, binding_only


def describe_changes(before, after, old_view, new_view, *, native_comparable=True):
    structure = definition_diff(before, after, old_view, new_view)
    views = [old_view or {'components':[]}, new_view or {'components':[]}]
    lookup = []
    for view in views:
        grouped = defaultdict(list)
        for c in view['components']: grouped[(c['factory'], c['location']['x'], c['location']['y'])].append(c)
        lookup.append({key:group[0] for key,group in grouped.items() if len(group)==1})
    def find(c, side):
        p = point(c.get('loc')) if hasattr(c, 'get') and not isinstance(c, dict) else c['location']
        factory = c.get('name') if not isinstance(c, dict) else c['factory']
        return lookup[side].get((factory, p['x'], p['y']))
    pairs, _, _ = component_pairs(before, after)
    matches = [(find(a,0)['componentId'],find(b,1)['componentId']) for a,b in pairs if find(a,0) and find(b,1)]
    connection = compare_connections(views[0]['components'], views[1]['components'], matches) if native_comparable else {
        'status':'unavailable', 'rows':[], 'unknownPorts':0}
    issues = {key:sum(v.get('coverage',{}).get(key,0) for v in views)
              for key in ('invalidBundleEnds','widthIncompatibilities')}
    if native_comparable and any(issues.values()):
        connection['status']='partial';connection['issues']=issues
    rows = []
    for item in structure['items']:
        if item['kind'] == 'wire': continue
        obj = item.get('after') or item['before']
        fields = item.get('fields', [])
        interface = obj['factory']=='Pin' and (item['change']!='modified' or bool(set(fields)&INTERFACE))
        category = 'interfaces' if interface else 'layout' if fields and set(fields)<=PRESENTATION else 'components'
        row = {**item, 'category':category, 'title':obj['label'] or obj['factory']}
        for side, name in enumerate(('before','after')):
            value = item.get(name)
            row[name] = {'components':[find(value,side) or value] if value else [], 'wires':[], 'attributes':value.get('attributes',{}) if value else {}}
        rows.append(row)
    rows.extend(connection['rows'])
    wires = [i for i in structure['items'] if i['kind']=='wire']
    if wires:
        rows.append({'kind':'routing', 'category':'layout', 'change':'modified', 'title':'布线路径',
            'before':{'components':[], 'wires':[i['before'] for i in wires if 'before' in i]},
            'after':{'components':[], 'wires':[i['after'] for i in wires if 'after' in i]},
            'segmentsBefore':sum('before' in i for i in wires), 'segmentsAfter':sum('after' in i for i in wires)})
    if structure['definitionChanged']:
        attrs = lambda c: {n.get('name'):n.get('val',n.text or '') for n in c.findall('a')} if c is not None else {}
        a,b = attrs(before), attrs(after)
        changed = [k for k in sorted(a.keys()|b.keys()) if a.get(k)!=b.get(k)]
        appearance = signature(before.find('appear') if before is not None else None) != signature(after.find('appear') if after is not None else None)
        details, binding_only = appearance_details(before, after) if appearance else ([], False)
        rows.append({'kind':'definition', 'category':'interfaces', 'change':'modified',
            'title':'封装引脚绑定更新' if binding_only else '封装外观与引脚映射' if appearance else '电路定义属性', 'fields':changed, 'details':details,
            'before':{'components':[], 'wires':[], 'attributes':a}, 'after':{'components':[], 'wires':[], 'attributes':b}})
    order = {'interfaces':0, 'components':1, 'connections':2, 'layout':3}
    rows.sort(key=lambda r:order[r['category']])
    for i,row in enumerate(rows):
        row['id']=str(i)
        for side in ('before','after'):
            row[side]['components'] = [{k:c.get(k) for k in ('componentId','factory','label','location','bounds')} for c in row[side]['components']]
    return {'rows':rows, 'counts':dict(Counter(r['category'] for r in rows)),
            'connectivity':{k:v for k,v in connection.items() if k!='rows'},
            'matching':'unique source type/location, label or unchanged attributes; comparison-local correspondence only'}
