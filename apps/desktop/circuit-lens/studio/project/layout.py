"""An explicit selection moves once; local boundary connections stretch.

Read-only geometry, shared by drag preview and final native-checked editing.
No source, snapshot, selection state or simulation state is published here.
"""
from collections import defaultdict

from studio.project.movement import moved_components, plan_move
from studio.domain.routing import Router, Partition, point
from studio.domain.wire_geometry import on_segment, subtract_segments


def selection_ids(body, key):
    value = body.get(key, [])
    if not isinstance(value,list) or any(not isinstance(i,str) for i in value) or len(value)!=len(set(value)):
        raise ValueError('选择必须包含当前电路中不重复的对象')
    return set(value)


def layout_request(scene, body):
    selected=selection_ids(body,'componentIds')
    if not selected and body.get('componentId'): selected={body['componentId']}
    wires=selection_ids(body,'wireIds')
    targets=[c for c in scene['components'] if c['componentId'] in selected]
    if len(targets)!=len(selected) or not wires<={w['wireId'] for w in scene['wires']} or not (selected or wires):
        raise ValueError('请选择当前电路中的元件或导线')
    try:
        if 'delta' in body: dx,dy=(int(body['delta'][k]) for k in ('x','y'))
        else:
            anchor=next((c for c in targets if c['componentId']==body.get('anchorId')),targets[0])['location']
            dx,dy=int(body['x'])-anchor['x'],int(body['y'])-anchor['y']
    except (KeyError,TypeError,ValueError,IndexError) as error:
        raise ValueError('移动距离无效') from error
    if dx%10 or dy%10 or abs(dx)>6000 or abs(dy)>6000:
        raise ValueError('移动需要对齐十像素网格并留在画布范围内')
    return selected,wires,dx,dy


def position_request(scene, body):
    if any(key in body for key in ('componentIds', 'delta', 'wireIds')):
        raise ValueError('positions 不能与 componentIds、delta 或 wireIds 混用')
    positions = body.get('positions')
    if not isinstance(positions, list) or not 1 <= len(positions) <= 240:
        raise ValueError('positions 需要 1–240 个 {componentId,x,y} 目标位置')
    components = {c['componentId']: c for c in scene['components']}
    result = {}
    for index, target in enumerate(positions):
        if not isinstance(target, dict) or set(target) != {'componentId', 'x', 'y'}:
            raise ValueError(f'positions[{index}] 需要 componentId、x、y')
        identifier = target['componentId']
        if not isinstance(identifier, str) or identifier not in components or identifier in result:
            raise ValueError(f'positions[{index}].componentId 不存在或重复，请使用本次观察的对象 ID')
        x, y = target['x'], target['y']
        if any(type(value) is not int or value % 10 or not 0 <= value <= 6000 for value in (x, y)):
            raise ValueError(f'positions[{index}] 需要 0–6000 范围内的十像素网格坐标')
        result[identifier] = (x, y)
    if all(result[key] == (components[key]['location']['x'], components[key]['location']['y']) for key in result):
        raise ValueError('目标位置均未变化；如需观察原图，请使用 render_circuit')
    return result


def plan_layout(scene, selected, wire_ids, dx, dy):
    if not wire_ids: return plan_move(scene,selected,dx,dy)
    components, attached = moved_components(scene,selected,dx,dy)
    bundles={b['bundleId']:b for b in scene['bundles']}
    vertices=set(attached)
    for wire in scene['wires']: vertices.update((point(wire['from']),point(wire['to'])))
    edges,adjacent=[],defaultdict(list)
    for wire in scene['wires']:
        a,b=point(wire['from']),point(wire['to'])
        cuts=sorted(p for p in vertices if on_segment(p,a,b))
        for p,q in zip(cuts,cuts[1:]):
            i=len(edges);edges.append((p,q,wire['bundleId'],wire['wireId'] in wire_ids))
            adjacent[p].append(i);adjacent[q].append(i)

    # Internal wiring moves with a group whose every attached component moves.
    auto=set();visited=set()
    for start in adjacent:
        if start in visited:continue
        cluster,stack=set(),[start]
        while stack:
            p=stack.pop()
            if p in cluster:continue
            cluster.add(p)
            for i in adjacent[p]:
                a,b,_,_=edges[i];stack.append(b if a==p else a)
        visited.update(cluster)
        terminals=[flag for p in cluster for flag,_ in attached[p]]
        if terminals and all(terminals):auto.update(i for p in cluster for i in adjacent[p])
    moving={i for i,e in enumerate(edges) if e[3]}|auto
    touched={p for i in moving for p in edges[i][:2]}|{p for p,ends in attached.items() if any(flag for flag,_ in ends)}
    fixed={p for p,ends in attached.items() if any(not flag for flag,_ in ends)}
    # A simple bend follows its moved segment. Shared branches stay in place.
    follows={p for p in touched if p not in fixed and len(adjacent[p])<=2}
    follows.update(p for p in touched if p not in fixed and all(i in moving for i in adjacent[p]))
    def shifted(p):return p[0]+dx,p[1]+dy
    kept,reroute=[],[]
    positions=defaultdict(set)
    for i,(a,b,bundle,_) in enumerate(edges):
        p=shifted(a) if i in moving or a in follows else a
        q=shifted(b) if i in moving or b in follows else b
        positions[a].add(p);positions[b].add(q)
        if p==q:continue
        if i in moving or p[0]==q[0] or p[1]==q[1]:kept.append((p,q,bundle,i in moving or (p,q)!=(a,b)))
        else:reroute.append((p,q,bundle))
    for p,ends in attached.items():
        for flag,_ in ends:positions[p].add(shifted(p) if flag else p)
    for p,places in positions.items():
        if len(places)<2:continue
        bundle=next((edges[i][2] for i in adjacent[p]),None)
        if bundle is None:
            bundle=f'layout-port-{len(bundles)}';bundles[bundle]={'bundleId':bundle,'bitNets':attached[p][0][1]['netBits']}
        reroute.append((p,shifted(p),bundle))

    geometry={'focus':{'components':[{**c,'factoryName':c['factory']} for c in components],
                      'wireBundles':list(bundles.values()),'wires':[
                          {'from':dict(zip(('x','y'),a)),'to':dict(zip(('x','y'),b)),'bundleId':bundle}
                          for a,b,bundle,changed in kept if not changed]}}
    router=Router(geometry,Partition())
    # The requested line position is authoritative. Reject obstructions instead
    # of silently moving it elsewhere to get an easy connectivity pass.
    for a,b,bundle,changed in kept:
        if not changed:continue
        if any(v<0 or v>6000 for p in (a,b) for v in p):raise ValueError('导线需要留在画布范围内')
        owner=router.owner(bundles[bundle].get('bitNets',[])) or ('floating',bundle)
        axis=0 if a[1]==b[1] else 1
        for p in router.grid(a,b):
            if p in router.blocked:raise ValueError('目标导线穿过元件，请换一个位置')
            if any(o!=owner for o in router.port_owners[p]):raise ValueError('目标导线碰到其他信号的端口')
            if any(o!=owner and (d==axis or endpoint or p in (a,b)) for o,d,endpoint in router.at[p]):
                raise ValueError('目标导线会连接到其他信号，请换一个位置')
        router.add(a,b,owner,owner)
    points=router.all_points+[p for a,b,_ in reroute for p in (a,b)]
    router.extent=(max(0,min(p[0] for p in points)-100),max(0,min(p[1] for p in points)-100),
                   min(6000,max(p[0] for p in points)+240),min(6000,max(p[1] for p in points)+240))
    for a,b,bundle in sorted(set(reroute)):
        owner=router.owner(bundles[bundle].get('bitNets',[])) or ('floating',bundle)
        for p,q in router.path({a},b,owner,avoid_retrace=True):
            # The connector may run back along the requested segment. Reuse
            # that copper rather than writing overlapping duplicate wires.
            uncovered=subtract_segments(p,q,[(x,y) for x,y,bid,_ in kept if bid==bundle])
            for x,y in uncovered:
                router.add(x,y,owner,owner);kept.append((x,y,bundle,True))
    return sorted({tuple(sorted((a,b))) for a,b,_,_ in kept if a!=b})


def preview(scene, body):
    selected,wires,dx,dy=layout_request(scene,body)
    segments=plan_layout(scene,selected,wires,dx,dy)
    return {'circuit':body['circuit'],'delta':{'x':dx,'y':dy},'componentIds':sorted(selected),
            'segments':[{'from':dict(zip(('x','y'),a)),'to':dict(zip(('x','y'),b))} for a,b in segments]}
