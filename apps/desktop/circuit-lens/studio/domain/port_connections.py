"""Bounded, endpoint-to-endpoint connectivity for a few selected ports.

This view exposes native shared bit nets only.  It never follows a component's
logic or infers that a port drives another port; that distinction is why the
result is useful for wiring work without pretending to be a signal analysis.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import re

from studio.domain.tool_errors import CircuitToolError


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def connection_options(args):
    """Return normalized options or None when the optional view was omitted."""
    if "portConnections" not in args:
        return None
    if not isinstance(args.get("circuit"), str) or not args["circuit"]:
        raise CircuitToolError("INVALID_ARGUMENT", "端口连接视图需要指定 circuit。",
                               hint="先 inspect_circuit({circuit}) 获取当前定义，再提供 portConnections。")
    if any(key in args for key in (
            "componentDirectory", "componentIds", "includeNets", "netFormat",
            "includeWires", "wireOffset", "wireLimit")):
        raise CircuitToolError(
            "INVALID_ARGUMENT",
            "端口连接视图不能与组件目录、组件详情、位网或导线选项混用。",
            hint="单独使用 portConnections；需要其他视图时另发一次 inspect_circuit。",
        )
    options = args["portConnections"]
    if not isinstance(options, dict) or set(options) - {"ports", "maxBytes", "cursor"}:
        raise CircuitToolError(
            "INVALID_ARGUMENT",
            "portConnections 需要 ports、maxBytes 和 cursor。",
            hint="使用 portConnections: {ports: [{componentId, port}], maxBytes?, cursor?}。",
        )
    ports = options.get("ports")
    if not isinstance(ports, list) or not 1 <= len(ports) <= 24:
        raise CircuitToolError("INVALID_ARGUMENT", "portConnections.ports 需要 1–24 个端口。")
    normalized = []
    for index, item in enumerate(ports):
        if (not isinstance(item, dict) or set(item) != {"componentId", "port"}
                or not isinstance(item["componentId"], str) or not item["componentId"]
                or type(item["port"]) is not int or item["port"] < 0):
            raise CircuitToolError(
                "INVALID_ARGUMENT",
                f"portConnections.ports[{index}] 需要 componentId 和非负整数 port。",
            )
        normalized.append({"componentId": item["componentId"], "port": item["port"]})
    max_bytes = options.get("maxBytes", 24000)
    if type(max_bytes) is not int or not 1024 <= max_bytes <= 32000:
        raise CircuitToolError("INVALID_ARGUMENT", "portConnections.maxBytes 必须为 1024–32000 的整数。")
    cursor = options.get("cursor")
    if cursor is not None and (not isinstance(cursor, str)
                               or not re.fullmatch(r"pc1:[0-9a-f]{64}:[1-9][0-9]{0,11}", cursor)):
        raise CircuitToolError("INVALID_PORT_CONNECTION_CURSOR", "端口连接视图游标格式无效。",
                               hint="使用本次返回的 nextCursor，或省略 cursor 从第一页开始。")
    return {"ports": normalized, "maxBytes": max_bytes, "cursor": cursor}


def _endpoint(component, end):
    result = {
        "componentId": component.get("componentId"),
        "factory": component.get("factory"),
        "label": component.get("label"),
        "port": end.get("index"),
        "location": deepcopy(end.get("location")),
        "componentLocation": deepcopy(component.get("location")),
        "width": end.get("width"),
        "direction": end.get("direction"),
        "semanticRole": end.get("semanticRole"),
        "runtimeTooltip": end.get("runtimeTooltip"),
    }
    for key in ("nativeDirection", "directionSource"):
        if key in end:
            result[key] = end[key]
    return result


def _contact(item):
    component = item.get("componentId")
    port = item.get("endIndex", item.get("port"))
    bit = item.get("bit")
    if not isinstance(component, str) or type(port) is not int or type(bit) is not int:
        return None
    return component, port, bit


def _bound_text(value, limit=256):
    if isinstance(value, str) and len(value) > limit:
        return value[:limit], True
    return value, False


def _peer(component, end):
    value = _endpoint(component, end)
    truncated = []
    for key in ("factory", "label", "semanticRole", "runtimeTooltip"):
        value[key], was = _bound_text(value.get(key))
        if was:
            truncated.append(key)
    if truncated:
        value["truncatedFields"] = truncated
    return value


def port_connections(view, *, identity, options, response_metadata=None):
    """Create a bounded view of native bit-net peers for selected endpoints."""
    circuit = view.get("circuit") or {}
    components = circuit.get("components") or []
    by_id = {c.get("componentId"): c for c in components}
    exact = bool(view.get("capabilities", {}).get("exactConnectivity")) and not view.get("observerError")
    selected = options["ports"]
    selected_endpoints = []
    port_summaries = []
    for index, request in enumerate(selected):
        component = by_id.get(request["componentId"])
        if component is None:
            raise CircuitToolError(
                "UNKNOWN_COMPONENT",
                f"portConnections.ports[{index}] 指向当前观察中不存在的元件 {request['componentId']}。",
                hint="用当前 inspect_circuit 的 componentId；不能沿用其他电路或修订的 ID。",
                context={"path": f"portConnections.ports[{index}].componentId",
                         "requested": request["componentId"], "circuit": circuit.get("name")},
            )
        end = next((item for item in component.get("ends") or [] if item.get("index") == request["port"]), None)
        if end is None:
            raise CircuitToolError(
                "UNKNOWN_PORT",
                f"元件 {request['componentId']} 没有端口 {request['port']}。",
                hint="先用 inspect_circuit 或 componentDirectory 读取当前元件的端口索引。",
                context={"path": f"portConnections.ports[{index}].port", "requested": request,
                         "actualComponent": {"componentId": request["componentId"],
                                              "factory": component.get("factory"),
                                              "label": component.get("label"),
                                              "ports": [e.get("index") for e in component.get("ends") or []]}},
            )
        selected_endpoints.append((request["componentId"], request["port"], component, end))
        port_summaries.append({"source": _endpoint(component, end), "unknownBits": [],
                               "unconnectedBits": [], "connectedBits": []})

    nets = {item.get("netId"): item for item in circuit.get("nets") or [] if isinstance(item, dict)}
    contact_index = {}
    for net_id, net in nets.items():
        members = {}
        for item in net.get("contacts") or []:
            value = _contact(item)
            if value:
                members.setdefault(value[:2], set()).add(value[2])
        contact_index[net_id] = members

    endpoint_index = {
        (component.get("componentId"), end.get("index")): (component, end)
        for component in components for end in component.get("ends") or []
    }
    connection_map = {}
    for summary, (component_id, port, component, end) in zip(port_summaries, selected_endpoints):
        width = end.get("width")
        mappings = {item.get("bit"): item.get("netId") for item in end.get("netBits") or []
                    if type(item.get("bit")) is int}
        if not exact or type(width) is not int or width < 0:
            summary["unknownBits"] = list(range(width)) if type(width) is int and width > 0 else None
            continue
        for bit in range(width):
            net_id = mappings.get(bit)
            net = nets.get(net_id)
            if not net_id or net is None or bit not in contact_index.get(net_id, {}).get((component_id, port), set()):
                summary["unknownBits"].append(bit)
                continue
            peers = [(key, bits) for key, bits in contact_index[net_id].items() if key != (component_id, port)]
            if not peers:
                summary["unconnectedBits"].append(bit)
                continue
            for (peer_id, peer_port), peer_bits in peers:
                peer_value = endpoint_index.get((peer_id, peer_port))
                if peer_value is None:
                    summary["unknownBits"].append(bit)
                    continue
                key = ((component_id, port), (peer_id, peer_port))
                item = connection_map.setdefault(key, {"source": _endpoint(component, end),
                                                        "peer": _peer(*peer_value), "lanes": []})
                lane = next((lane for lane in item["lanes"] if lane["netId"] == net_id), None)
                if lane is None:
                    lane = {"netId": net_id, "sourceBits": [], "peerBits": [], "bitPairs": []}
                    item["lanes"].append(lane)
                lane["sourceBits"].append(bit)
                lane["peerBits"].extend(sorted(peer_bits))
                lane["bitPairs"].append({"sourceBit": bit, "peerBits": sorted(peer_bits)})
            summary["connectedBits"].append(bit)

    entries = list(connection_map.values())
    entries.sort(key=lambda item: (item["source"]["componentId"], item["source"]["port"],
                                   item["peer"]["componentId"], item["peer"]["port"]))
    for item in entries:
        for lane in item["lanes"]:
            lane["sourceBits"] = sorted(set(lane["sourceBits"]))
            lane["peerBits"] = sorted(set(lane["peerBits"]))
            lane["bitPairs"] = sorted(lane["bitPairs"], key=lambda pair: pair["sourceBit"])

    digest = hashlib.sha256(_json([identity, view.get("revision"), view.get("capabilities"),
                                   view.get("unknowns"), selected]).encode()).hexdigest()
    offset = 0
    if options["cursor"]:
        _, bound, raw_offset = options["cursor"].split(":")
        if bound != digest:
            raise CircuitToolError("STALE_PORT_CONNECTION_CURSOR", "电路版本或实际观察已变化，不能续接旧连接页。",
                                   hint="省略 cursor 重新查询当前端口连接。")
        offset = int(raw_offset)
        if not 0 < offset < len(entries):
            raise CircuitToolError("INVALID_PORT_CONNECTION_CURSOR", "端口连接游标位置无效。")
    result = {
        "schema": "vibe-logisim.port-connections/v1",
        **identity,
        "authority": "exact-runtime" if exact else "geometry-only",
        "status": "observed" if exact else "unavailable",
        "scope": "同一电路定义内的原生共享位网；connections 只表示端点共网，不推断逻辑传播、驱动关系或功能正确性。unknownBits 不等于断开。",
        **(response_metadata or {}),
        "ports": port_summaries,
        "connections": [],
    }
    for item in entries[offset:]:
        candidate = {**result, "connections": [*result["connections"], item]}
        next_offset = offset + len(result["connections"]) + 1
        page = {"offset": offset, "total": len(entries), "returned": len(result["connections"]) + 1,
                "nextCursor": f"pc1:{digest}:{next_offset}" if next_offset < len(entries) else None,
                "maxBytes": options["maxBytes"], "bytes": 0}
        candidate["page"] = page
        size = len(_json(candidate).encode("utf-8"))
        if size > options["maxBytes"]:
            if result["connections"]:
                break
            raise CircuitToolError("PORT_CONNECTION_BUDGET", "完整端点连接记录超过字节预算；未截断记录。",
                                   hint="提高 portConnections.maxBytes，或减少请求端口。",
                                   context={"maxBytes": options["maxBytes"], "requiredBytes": size})
        result["connections"].append(item)
    page = {"offset": offset, "total": len(entries), "returned": len(result["connections"]),
            "nextCursor": f"pc1:{digest}:{offset + len(result['connections'])}" if offset + len(result["connections"]) < len(entries) else None,
            "maxBytes": options["maxBytes"], "bytes": 0}
    while True:
        result["page"] = page
        size = len(_json(result).encode("utf-8"))
        if page["bytes"] == size:
            break
        page["bytes"] = size
    if page["bytes"] > options["maxBytes"]:
        raise CircuitToolError("PORT_CONNECTION_BUDGET", "端口连接视图的必要元数据超过字节预算。",
                               hint="提高 portConnections.maxBytes，或减少请求端口。",
                               context={"maxBytes": options["maxBytes"], "requiredBytes": page["bytes"]})
    return result
