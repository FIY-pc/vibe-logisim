"""Reattach changed terminals to retained branches, then compare real bit nets.

Port correspondence comes from the runtime's Pin mapping, not labels or the
order of ports. This planner does not publish a document or invent components.
"""
from collections import defaultdict
from studio.domain.routing import Router, Partition, point
from studio.domain.wire_geometry import on_segment, subtract_segments


def geometry(components, wires, bundles):
    return {'focus':{'components':[{**c,'factoryName':c['factory']} for c in components],
                     'wires':wires,'wireBundles':bundles}}


def reconnect(scene, components, changes):
    terminals=defaultdict(list)
    for c in scene['components']:
        for e in c['ends']:
            p=point(e['location'])
            terminals[p].append(changes.get((c['componentId'],e['index']),p))
    vertices=set(terminals)
    for w in scene['wires']:vertices.update((point(w['from']),point(w['to'])))
    edges=[];adjacent=defaultdict(list)
    for w in scene['wires']:
        a,b=point(w['from']),point(w['to'])
        cuts=sorted(p for p in vertices if on_segment(p,a,b))
        for a,b in zip(cuts,cuts[1:]):
            i=len(edges);edges.append((a,b,w['bundleId']));adjacent[a].append(i);adjacent[b].append(i)
    moved={};extra=[]
    bundles={b['bundleId']:b for b in scene['bundles']}
    for p,targets in terminals.items():
        unique=set(targets)
        if len(unique)==1 and len(adjacent[p])<=1:moved[p]=next(iter(unique))
        else:
            moved[p]=p
            for q in unique-{p,None}:
                bundle=edges[adjacent[p][0]][2] if adjacent[p] else None
                if bundle:extra.append((p,q,bundle))
    anchors=set(terminals)|{p for p in adjacent if len(adjacent[p])!=2}
    paths=[];used=set()
    for start in sorted(anchors):
        for i in adjacent[start]:
            if i in used:continue
            path=[start];p=start;bundle=edges[i][2]
            while True:
                used.add(i);a,b,_=edges[i];p=b if a==p else a;path.append(p)
                if p in anchors:break
                i=next(j for j in adjacent[p] if j!=i)
            paths.append((path,bundle))
    paths.extend(([a,b],bundle) for i,(a,b,bundle) in enumerate(edges) if i not in used)
    kept=[];routes=list(extra)
    for path,bundle in paths:
        a,b=path[0],path[-1];p,q=moved.get(a,a),moved.get(b,b)
        if p is None or q is None:continue
        if (p,q)==(a,b):kept.extend((a,b,bundle) for a,b in zip(path,path[1:]))
        elif p!=q:routes.append((p,q,bundle))
    wire=lambda a,b,bundle:{'from':dict(zip(('x','y'),a)),'to':dict(zip(('x','y'),b)),'bundleId':bundle}
    router=Router(geometry(components,[wire(*s) for s in kept],list(bundles.values())),Partition())
    old_router=Router(geometry(scene['components'],scene['wires'],scene['bundles']),Partition())
    newly_blocked=router.blocked-old_router.blocked
    if any(p in newly_blocked for a,b,_ in kept for p in router.grid(a,b)):
        raise ValueError('封装会遮住父图中的其他连线，请缩小外形或先整理父图')
    for a,b,bundle in routes:
        owner=router.owner(bundles[bundle].get('bitNets',[])) or ('floating',bundle)
        for p,q in router.path({a},b,owner,avoid_retrace=True):
            for x,y in subtract_segments(p,q,[(x,y) for x,y,bid in kept if bid==bundle]):
                kept.append((x,y,bundle));router.add(x,y,owner,owner)
    return sorted({tuple(sorted((a,b))) for a,b,_ in kept if a!=b})


def assert_connections(pairs):
    forward={};backward={};checked=0
    for before,after in pairs:
        width=min(before.get('width') or 0,after.get('width') or 0)
        if width<1:continue
        a={b['bit']:b['netId'] for b in before['netBits']}
        b={b['bit']:b['netId'] for b in after['netBits']}
        for bit in range(width):
            if bit not in a or bit not in b:raise ValueError('端口连接尚不明确，无法保持现有接线')
            x,y=a[bit],b[bit]
            if forward.setdefault(x,y)!=y:raise ValueError('接口调整会断开其他信号，请调整端口位置')
            if backward.setdefault(y,x)!=x:raise ValueError('接口调整会接错其他信号，请调整端口位置')
            checked+=1
    return checked


def assert_isolated(scene, terminals):
    """An explicitly detached/new terminal cannot inherit a retained junction."""
    ends=[((c['componentId'],e['index']),e) for c in scene['components'] for e in c['ends']]
    owners=defaultdict(set)
    for key,end in ends:
        for bit in end['netBits']:owners[bit['netId']].add(key)
    for key,end in ends:
        if key not in terminals:continue
        attached=any(owners[b['netId']]-{key} for b in end['netBits'])
        p=point(end['location'])
        on_wire=any(on_segment(p,point(w['from']),point(w['to'])) for w in scene['wires'])
        if attached or on_wire:
            raise ValueError('新增或断开的端口仍处在共享接点上；请先移动端口或整理该处连线')
