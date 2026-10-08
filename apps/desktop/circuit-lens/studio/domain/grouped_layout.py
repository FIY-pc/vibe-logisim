"""Explicit visual groups, laid out through an injected port-aware solver.

The caller supplies group membership and reading rows. They are input for one
snapshot, never inferred from component names here. A group is not a subcircuit.
The solver sees padded native bounds and fixed native ports; it cannot rotate,
resize or reconnect the actual components. Native routing is still responsible
for the emitted copper. This experimental strategy deliberately skips global
column compaction, which would destroy its group spacing.
"""
from __future__ import annotations

import math

from studio.domain.schematic_layout import _snap
from studio.domain.grouped_geometry import padding_for
from studio.domain.control_routing import repeated_control_networks
from studio.domain.layout_annotations import arrange_annotations


class GroupedPlacement:
    def __init__(self, intent, solve):
        self.intent, self.solve = intent, solve

    def __call__(self, layout):
        groups = self.intent.get("groups", [])
        if not groups:
            raise ValueError("分块布局需要至少一个显式分组")
        if not self.intent.get('stages') and any(g.get('attachTo') for g in groups):
            raise ValueError('attachTo 需要 stages，且应指向同阶段 mainPath 内的组。')
        assigned, group_ids, nodes, members, seen = {}, set(), [], {}, set()
        text_ids = {cid for cid in layout.body_ids if layout.by_id[cid]['factoryName'] == 'Text'}
        legacy_annotations = {}
        for index, group in enumerate(groups):
            gid = str(group["id"])
            if gid in group_ids:
                raise ValueError(f"重复分组: {gid}")
            group_ids.add(gid)
            members[gid] = []
            for original in group["componentIds"]:
                if original in seen:
                    raise ValueError(f"重复元件: {original}")
                seen.add(original)
                cid = layout.fused.get(original, original)
                if cid not in layout.body_ids:
                    raise ValueError(f"分组引用了不存在、固定或不支持的元件: {original}")
                if cid in text_ids:
                    legacy_annotations[cid] = gid
                    continue
                if cid in assigned:
                    if assigned[cid] == gid:
                        continue
                    raise ValueError(f"元件或接触组合重复/跨组: {original}")
                assigned[cid] = gid
                members[gid].append(cid)
            if not members[gid] and gid not in legacy_annotations.values():
                raise ValueError(f"空分组: {gid}")
            nodes.append({"id": gid, "label": str(group.get("label", gid)),
                          "row": int(group.get("row", 0)), "order": index,
                          "role": group.get("role", "main"),
                          "attachTo": group.get("attachTo"),
                          "bankOrder": group.get("bankOrder", "connected"),
                          "layout": group.get("layout", "flow"), "columns": group.get("columns", 1),
                          "children": [], "edges": []})

        # Localized constants disappear during emission. Everything else must
        # be accounted for: silently dropping an unassigned part is not a layout.
        localized = {next(cid for cid, _ in layout.nets[key] if cid in layout.constants)
                     for key, cls in layout.classes.items() if cls == "constant"}
        missing = layout.body_ids - assigned.keys() - localized - text_ids
        if missing:
            raise ValueError("分组遗漏元件: " + ", ".join(sorted(missing)))

        # Explicit representation decisions are tied to an observed port, not
        # guessed from a component name. Existing signal names stay intact.
        port_net = {p: key for key, ports in layout.nets.items() for p in ports}
        for link in self.intent.get("namedLinks", []):
            port = tuple(link["port"])
            port = getattr(layout, "piece_port", {}).get(port, port)
            if port not in port_net:
                raise ValueError(f"命名连接引用未知端口: {port}")
            key, label = port_net[port], str(link["label"]).strip()
            if not label or layout.classes[key] == "constant":
                raise ValueError(f"不能命名该连接: {port}")
            existing = layout.labels_of_net.get(key, set())
            if existing and label not in existing:
                raise ValueError(f"不能改写已有信号名称: {label}")
            if not existing:
                if label.lower() in layout.used_labels:
                    raise ValueError(f"信号名称已被其他网络使用: {label}")
                layout.used_labels.add(label.lower())
                layout.labels_of_net[key] = {label}
                layout.label_of_net[key] = label
            layout.classes[key] = "tunnel"

        by_group = {n["id"]: n for n in nodes}
        # Repeated one-bit inputs distribute control; they are poor evidence of
        # data-flow order even when explicitly named or requested as local wire.
        # Identity comes from native factory/port, never a CLK/RST name heuristic.
        distribution = repeated_control_networks(layout, assigned)
        self.distribution = distribution
        port_ids, padding = {}, {}
        for cid, gid in assigned.items():
            c, b = layout.by_id[cid], layout.by_id[cid]["bounds"]
            px, py, pr, pb = padding_for(layout, cid, assigned)
            padding[cid] = (px, py)
            node = {"id": cid, "width": math.ceil((b["width"] + px + pr)/10)*10,
                    "height": math.ceil((b["height"] + py + pb)/10)*10,
                    "ports": [], "layoutOptions": {"elk.portConstraints": "FIXED_POS"}}
            for e in c["ends"]:
                p = e["location"]
                distances = {"WEST": abs(p["x"]-b["x"]), "EAST": abs(p["x"]-b["x"]-b["width"]),
                             "NORTH": abs(p["y"]-b["y"]), "SOUTH": abs(p["y"]-b["y"]-b["height"])}
                side = min(distances, key=distances.get)
                pid = f"{cid}:p{e['index']}"; port_ids[(cid,e["index"])] = pid
                node["ports"].append({"id": pid, "x": p["x"]-b["x"]+px, "y": p["y"]-b["y"]+py,
                                      "direction": e.get("direction"), "bitWidth": e.get("width"),
                                      "width": 0, "height": 0, "layoutOptions": {"elk.port.side": side}})
            by_group[gid]["children"].append(node)

        def source(ports):
            # Both splitter directions are legal. A passive endpoint can supply
            # the layout edge toward a known input; this asserts no driver.
            return min(ports, key=lambda p: (
                {"output":0,"inout":1,"input":2}.get(layout.by_id[p[0]]["ends"][p[1]].get("direction"),1),
                p[1] == 0 if layout.by_id[p[0]]["factoryName"] == "Splitter" else False, p))
        links, attachments = [], []
        for number, (key, all_ports) in enumerate(layout.nets.items()):
            ports = [p for p in all_ports if p in port_ids]
            if len(ports)<2 or layout.classes[key]=="constant": continue
            width = len(layout.bits_of[key])
            # Do not let high-fanout clocks determine geometric hierarchy.
            if key in distribution or (layout.classes[key]=="global" and width==1): continue
            for gid in by_group:
                local = [p for p in ports if assigned[p[0]]==gid]
                if len(local)<2: continue
                src = source(local)
                for i, dst in enumerate(local):
                    if dst[0]==src[0]: continue
                    by_group[gid]["edges"].append({"id":f"n{number}-{i}","sources":[port_ids[src]],"targets":[port_ids[dst]]})
                    sc, dc = layout.by_id[src[0]], layout.by_id[dst[0]]
                    if (dc["factoryName"]=="Buffer" and dc["ends"][dst[1]].get("direction")=="input"
                            and sc["ends"][src[1]].get("direction")=="output" and len(local)==2):
                        attachments.append({"group":gid,"source":port_ids[src],"target":port_ids[dst]})
            src = source(ports)
            for dst in ports:
                if assigned[src[0]] != assigned[dst[0]]:
                    links.append({"source":port_ids[src],"target":port_ids[dst],
                                  "sourceGroup":assigned[src[0]],"targetGroup":assigned[dst[0]],
                                  "directed": layout.by_id[src[0]]["ends"][src[1]].get("direction") == "output" and layout.by_id[dst[0]]["ends"][dst[1]].get("direction") == "input",
                                  "weight": (3 if width>1 else 1) / max(1, len(ports)-1)})
        width_limit=self.intent.get('maxRowWidth',None if self.intent.get('stages') else 3600)
        result = self.solve({"groups":nodes,"links":links,"attachments":attachments,"stages":self.intent.get('stages',[]),"groupGap":100,"rowGap":120,"maxRowWidth":width_limit})
        annotation_plan, annotation_height = arrange_annotations(layout, self.intent, result['groups'], members, legacy_annotations)
        self.copper_pairs = result.get('copperPairs')
        panel_bottom = max((c["bounds"]["y"]+c["bounds"]["height"] for c in layout.components if layout._is_panel(c)),default=0)
        panel_bottom = max(panel_bottom, layout.panel_below_y or 0)
        ox, annotation_top = 100, _snap(panel_bottom+110)
        oy = annotation_top + annotation_height
        placement, rectangles = {}, []
        for group in result["groups"]:
            gid = group["id"]
            if gid not in by_group: raise ValueError(f"布局器返回未知分组: {gid}")
            by_group[gid]["row"] = group["row"]
            by_group[gid]["supportOf"] = group.get("supportOf")
            by_group[gid]["stage"] = group.get("stage")
            gx, gy = group["x"]+ox, group["y"]+oy
            rectangles.append({"id":gid,"label":by_group[gid]["label"],"heading":group.get('heading'),"sourceHeading":group.get('sourceHeading'),"stage":group.get('stage'),"row":group["row"],"readingRow":group.get("readingRow",group["row"]),"role":by_group[gid]["role"],"layout":by_group[gid]["layout"],"columns":by_group[gid]["columns"],"supportOf":group.get("supportOf"),
                               "x":_snap(gx),"y":_snap(gy),"width":group["width"],"height":group["height"],"componentIds":members[gid]})
            for node in group["children"]:
                cid=node["id"]
                if cid not in assigned or assigned[cid]!=gid or cid in placement: raise ValueError(f"布局器返回无效元件: {cid}")
                b=layout.by_id[cid]["bounds"];px,py=padding[cid]
                placement[cid]=(_snap(gx+node["x"]+px-b["x"]),_snap(gy+node["y"]+py-b["y"]))
        self.bank_columns = {n['id']: n.get('bankColumn', 0) for g in result['groups'] if by_group[g['id']]['layout'] == 'bank' for n in g['children']}
        self.bank_boxes = {n['id']: {'x':_snap(g['x']+ox+n['x']), 'y':_snap(g['y']+oy+n['y']),
                                   'width':n['width'], 'height':n['height']}
                           for g in result['groups'] if by_group[g['id']]['layout']=='bank' for n in g['children']}
        if placement.keys()!=assigned.keys(): raise ValueError("布局器遗漏已分组元件")
        for item in annotation_plan:
            cid = item['componentId']; b = layout.by_id[cid].get('visualBounds', layout.by_id[cid]['bounds'])
            x, y = ox+item['x'], (oy if item['role']=='heading' else annotation_top)+item['y']
            placement[cid] = (_snap(x-b['x']), _snap(y-b['y']))
            item.update(x=x,y=y)
        bottom=max(r["y"]+r["height"] for r in rectangles);right=max(r["x"]+r["width"] for r in rectangles)
        for i,cid in enumerate(sorted(localized-assigned.keys())):
            b=layout.by_id[cid]["bounds"];placement[cid]=(_snap(100+i*60-b["x"]),_snap(bottom+100-b["y"]))
        self.assigned = {**assigned, **{cid:assigned[host] for cid,host in layout.fused.items() if host in assigned}}
        self.groups = by_group
        layout.placement=placement
        layout.layer={cid:i for i,g in enumerate(nodes) for cid in members[g["id"]]}
        layout.layer.update({cid:-1 for cid in localized if cid not in layout.layer})
        layout.layer.update({cid:-1 for cid in text_ids})
        layout.fan_wires,layout.shelf,layout.captions={},[],{}
        layout.footer={"x":100,"y":_snap(bottom+160),"row":0,"right":right}
        layout.body_bottom=bottom;layout.sheet_gap=0
        layout.report.update({"placementMethod":"explicit-groups/elk-layered/connected-interfaces","layoutGroups":rectangles,
                              "layoutStages":[{**s,'x':_snap(s['x']+ox),'y':_snap(s['y']+oy)} for s in result.get('stageBoxes',[])],
                              "mainPathCopperPairs":self.copper_pairs or [],
                              "autoStageWidth":result.get('autoStageWidth'),
                              "readingTransitions":[{**t, **{key:{'x':_snap(t[key]['x']+ox),'y':_snap(t[key]['y']+oy)}
                                                            for key in ('fromTop','toTop')}}
                                                    for t in result.get('readingTransitions',[])],
                              "sourceAnnotations":annotation_plan,
                              "annotationOnlyGroups":[gid for gid,ids in members.items() if not ids],
                              "bankOrdering":result.get("bankOrdering",[]), "rowCuts":result.get("rowCuts",[]),
                              "wrappedConnections":result.get("wrappedConnections",0), "supportAttachments":result.get("supportAttachments",[]),
                              "groupLinks":len(links),"rowWraps":result.get("rowWraps",0),"maxRowWidth":width_limit,"attachedBuffers":result.get("attachedBuffers",0),
                              "moved":sum(bool(dx or dy) for dx,dy in placement.values())})
        return placement

    def prepare_routing(self, layout):
        """Partition geometry, never electricity: local trees share one name.

        Called after fused pieces have expanded back to native ports. Adjacent
        forward data-path groups may share copper; remote groups use one named
        bridge per local tree, rather than a Tunnel on every endpoint.
        """
        layout.wire_trees={}
        layout.control_trees={}
        control_reports=[]
        groups=self.groups;assigned=self.assigned
        # Repaired interface rails are remote connections, not a reason to
        # drag a local group's wire all the way across the sheet to its Pin.
        for rail in layout.report.get('interfaceOrderRepairs', []):
            gid = '__interface_' + rail['facing']
            groups[gid] = {'row': -1, 'order': -1}
            for cid in rail['movedComponentIds']:
                assigned[cid] = gid
        rows={gid:g["row"] for gid,g in groups.items()}
        orders={gid:g["order"] for gid,g in groups.items()}
        for key,cls in list(layout.classes.items()):
            if cls=="constant":continue
            if layout.labels_of_net.get(key,set()) & layout.keep_tunnels: continue
            ps=[p for p in layout.nets[key] if p[0] in assigned]
            if len(ps)<2:continue
            width=len(layout.bits_of[key])
            explicitly_local=bool(layout.labels_of_net.get(key,set()) & set(self.intent.get('localSignals',[])))
            if key in self.distribution and self.intent.get('sharedControls', True):
                buckets={}
                for cid,idx in ps:
                    c=layout.by_id[cid];gid=assigned[cid]
                    _point,facing,_step=layout._port_edge(c,idx)
                    eligible=(cid in self.bank_columns and c['ends'][idx].get('direction')=='input'
                              and c['ends'][idx].get('semanticRole') in
                              {'clock', 'clear', 'preset', 'enable', 'chipSelect'})
                    bucket=('bank',gid,self.bank_columns[cid],c['factoryName'],idx,facing) if eligible else (('requested',gid) if explicitly_local else ('single',cid,idx))
                    buckets.setdefault(bucket,[]).append((cid,idx))
                trees=[];controls=[]
                for bucket,ports in buckets.items():
                    ports.sort(key=lambda p:(layout.by_id[p[0]]['ends'][p[1]]['location']['y']+layout.placement[p[0]][1],p))
                    if bucket[0]=='requested': trees.append(ports)
                    elif bucket[0]=='bank' and len(ports)>=3:
                        controls.append((len(trees),bucket,ports));trees.append(ports)
                    else:trees.extend([[p] for p in ports])
                if controls:
                    layout._labels_for(key);layout.classes[key]='wire';layout.wire_trees[key]=trees
                    for index,bucket,ports in controls:
                        boxes=[self.bank_boxes[cid] for cid,_idx in ports]
                        layout.control_trees[('local',key,index)]={'ports':ports,
                            'groupId':bucket[1], 'column':bucket[2],
                            'left':min(b['x'] for b in boxes), 'right':max(b['x']+b['width'] for b in boxes)}
                        control_reports.append({'groupId':bucket[1],'column':bucket[2],
                                                'labels':sorted(layout.labels_of_net[key]),'ports':ports})
                    continue
            if (key in self.distribution or (cls=="global" and width==1)) and not explicitly_local:continue
            clusters={}
            for p in ps:clusters.setdefault(assigned[p[0]],[]).append(p)
            outputs=[p for p in ps if layout.by_id[p[0]]["ends"][p[1]].get("direction")=="output"]
            if self.copper_pairs is not None:
                # Merge only the geometry of endpoints already on this same
                # native net. A reading relationship never invents a wire.
                roots={gid:gid for gid in clusters}
                def root(gid):
                    while roots[gid]!=gid:gid=roots[gid]
                    return gid
                def point(p):
                    q=layout.by_id[p[0]]['ends'][p[1]]['location'];dx,dy=layout.placement[p[0]]
                    return q['x']+dx,q['y']+dy
                for a,b,role in self.copper_pairs:
                    if a not in roots or b not in roots:continue
                    # Semantic proximity alone is not permission for a sheet-
                    # spanning wire. Distant fields keep their named bridge.
                    pairs=[(point(p),point(q)) for p in clusters[a] for q in clusters[b]]
                    reach=1200 if role=='main' else 600
                    if any(abs(x-u)+abs(y-v)<=reach and abs(y-v)<=400 for (x,y),(u,v) in pairs):
                        roots[root(b)]=root(a)
                merged={}
                for gid,ports in clusters.items():merged.setdefault(root(gid),[]).extend(ports)
                clusters=merged
            elif outputs and width>1:
                sg=assigned[outputs[0][0]]
                for tg in list(clusters):
                    if tg!=sg and rows[tg]==rows[sg] and orders[tg]==orders[sg]+1:
                        clusters[sg].extend(clusters.pop(tg))
            trees=[]
            for ports in clusters.values():
                ports.sort(key=lambda p:(layout.by_id[p[0]]["ends"][p[1]].get("direction")!="output",
                                         layout.by_id[p[0]]["ends"][p[1]]["location"]["x"]+layout.placement[p[0]][0],p))
                trees.append(ports)
            if len(trees)==1 and len(trees[0])<2:continue
            # Unnamed remote branches get the existing native-derived name.
            if len(trees)>1:layout._labels_for(key)
            layout.classes[key]="wire";layout.wire_trees[key]=trees
        layout.report["hybridNetworks"]=sum(len(ts)>1 and any(len(t)>1 for t in ts) for ts in layout.wire_trees.values())
        layout.report['sharedControls']={'trees':control_reports,'plannedLabelReduction':sum(len(c['ports'])-1 for c in control_reports)}
        protected = [key for key in layout.nets if layout.labels_of_net.get(key,set()) & layout.keep_tunnels]
        layout.report['representationChoices'] = {
            'stages':len(self.intent.get('stages',[])),
            'namedOnlyNetworks':len(protected),
            'sharedControlsEnabled':self.intent.get('sharedControls',True),
            'controlNetworksExcludedByKeepTunnels':sum(key in self.distribution for key in protected),
            'annotationOnlyGroups':layout.report['annotationOnlyGroups'],
            'note':'Named-only protection suppresses local wire trees and bank rails on those nets. '
                   'Zero wire crossings can therefore mean more name-based tracing, not better readability. '
                   'Annotation-only groups contain no electrical path.'}
