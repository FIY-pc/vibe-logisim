"""Resolve revision-local wire selection to source geometry before mutation."""
import xml.etree.ElementTree as ET
from studio.domain.wire_geometry import subtract_segments


def remove_wires(circuit, scene, selected):
    nodes=list(circuit.findall('wire'))
    native={w['wireId']:w for w in scene['wires']}
    xml={f'xml:w{i:04d}':node for i,node in enumerate(nodes)}
    if not selected<=native.keys()|xml.keys():raise ValueError('导线不属于当前电路')
    segments=[]
    for wire_id in sorted(selected):
        if wire_id in native:
            segments.append(tuple((native[wire_id][k]['x'],native[wire_id][k]['y']) for k in ('from','to')))
        else:segments.append(tuple(tuple(int(v) for v in xml[wire_id].get(k).strip('()').split(',')) for k in ('from','to')))
    for node in nodes:
        a,b=[tuple(int(v) for v in node.get(k).strip('()').split(',')) for k in ('from','to')]
        remaining=subtract_segments(a,b,segments)
        if remaining==[(a,b)]:continue
        circuit.remove(node)
        for start,end in remaining:
            ET.SubElement(circuit,'wire',{'from':f'({start[0]},{start[1]})','to':f'({end[0]},{end[1]})'})
