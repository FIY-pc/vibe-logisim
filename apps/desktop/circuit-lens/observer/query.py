#!/usr/bin/env python3
"""Mechanically query an Experiment 001 compact observation from stdin."""

from __future__ import annotations

from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import sys
from typing import Any, Iterable


QUERY_SCHEMA = "vibe-logisim.experiment-001.task-query/v0"
QUERY_VERSION = "spike-1"


class QueryError(Exception):
    pass


def emit(value: Any) -> None:
    json.dump(value, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")


def label_of(component: dict[str, Any]) -> str | None:
    selector = component.get("selector") or {}
    return selector.get("label")


def at_of(component: dict[str, Any]) -> dict[str, int]:
    return component["location"]


def net_ids_of(component: dict[str, Any]) -> list[str]:
    result: list[str] = []
    for end in component.get("ends", []):
        for bit in end.get("relevantNetBits", []):
            net_id = bit["netId"]
            if net_id not in result:
                result.append(net_id)
    return result


def stable_ids(values: Iterable[str]) -> list[str]:
    return sorted(set(values))


class Surface:
    def __init__(self, document: dict[str, Any]) -> None:
        if document.get("mode") != "compact-public":
            raise QueryError("stdin must be an ExactRuntimeObserver --compact document")
        self.document = document
        self.projection = document["projection"]
        self.components = {
            component["componentId"]: component
            for component in self.projection["components"]
        }
        self.nets = {net["netId"]: net for net in self.projection["bitNets"]}
        self.bundles = {
            bundle["bundleId"]: bundle
            for bundle in self.projection["wireBundles"]
        }
        self.wires = {wire["wireId"]: wire for wire in self.projection["wires"]}
        self.tunnels = {
            tunnel["componentId"]: tunnel
            for tunnel in self.projection["tunnels"]
        }
        self.states = {
            state["componentId"]: state
            for state in self.projection["stateElements"]
        }
        self.region_ids = set(self.projection["componentSets"]["region"])

    def envelope(self, kind: str, arguments: list[str]) -> dict[str, Any]:
        observer = self.document["observer"]
        return {
            "schema": QUERY_SCHEMA,
            "query": {"kind": kind, "arguments": arguments},
            "querySurface": {
                "version": QUERY_VERSION,
                "programSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                "inputMode": "compact-public",
            },
            "revision": self.document["revision"],
            "runtime": {
                "reportedVersion": self.document["runtime"]["reportedVersion"],
                "jarSha256": self.document["runtime"]["jarSha256"],
            },
            "observer": {
                "version": observer["version"],
                "bundleSha256": observer["bundleSha256"],
                "connectivityAuthority": observer["connectivityAuthority"],
            },
            "circuit": self.projection["circuit"],
            "region": self.projection["region"],
        }

    def net_brief(self, net_id: str) -> dict[str, Any]:
        net = self.nets[net_id]
        directions = Counter(contact.get("direction") for contact in net["contacts"])
        region_contacts = [
            {
                "componentId": contact["componentId"],
                "endIndex": contact["endIndex"],
                "bit": contact["bit"],
                "role": contact.get("semanticRole"),
                "direction": contact.get("direction"),
                **{key: contact[key] for key in ("nativeDirection", "directionSource") if key in contact},
                "at": contact["location"],
            }
            for contact in net["contacts"]
            if contact["componentId"] in self.region_ids
        ]
        return {
            "netId": net_id,
            "kind": net["kind"],
            "contactCount": net["contactCount"],
            "directionCounts": dict(sorted(directions.items())),
            "singleton": net["contactCount"] == 1,
            "regionContacts": region_contacts,
        }

    def component_brief(self, component: dict[str, Any], with_ends: bool) -> dict[str, Any]:
        result: dict[str, Any] = {
            "componentId": component["componentId"],
            "factory": component["factoryName"],
            "label": label_of(component),
            "at": at_of(component),
            "bounds": component["bounds"],
            "inRegion": component["inRegion"],
            "inclusionReasons": component["inclusionReasons"],
        }
        if component.get("attributes"):
            result["attributes"] = component["attributes"]
        if with_ends:
            ends = []
            for end in component["ends"]:
                bits = []
                for bit in end["relevantNetBits"]:
                    net = self.nets[bit["netId"]]
                    bits.append(
                        {
                            "bit": bit["bit"],
                            "netId": bit["netId"],
                            "contactCount": net["contactCount"],
                            "netKind": net["kind"],
                        }
                    )
                ends.append(
                    {
                        "index": end["index"],
                        "role": end.get("semanticRole"),
                        "direction": end["direction"],
                        **{key: end[key] for key in ("nativeDirection", "directionSource") if key in end},
                        "width": end["width"],
                        "at": end["location"],
                        "nets": bits,
                        "omittedNetBitCount": end["omittedNetBitCount"],
                    }
                )
            result["ends"] = ends
        else:
            result["relevantNets"] = net_ids_of(component)
        return result

    def overview(self) -> dict[str, Any]:
        result = self.envelope("overview", [])
        region_components = []
        for component_id in sorted(self.region_ids):
            component = self.components[component_id]
            ends = []
            for end in component["ends"]:
                bits = [
                    [
                        bit["bit"],
                        bit["netId"],
                        self.nets[bit["netId"]]["contactCount"],
                    ]
                    for bit in end["relevantNetBits"]
                ]
                ends.append(
                    [
                        end["index"],
                        end.get("semanticRole"),
                        end["direction"],
                        end["width"],
                        end["location"]["x"],
                        end["location"]["y"],
                        bits,
                    ]
                )
            region_components.append(
                [
                    component_id,
                    component["factoryName"],
                    label_of(component),
                    component["location"]["x"],
                    component["location"]["y"],
                    component.get("attributes") or {},
                    ends,
                ]
            )
        adjacent_components = [
            [
                component_id,
                component["factoryName"],
                label_of(component),
                component["location"]["x"],
                component["location"]["y"],
                [
                    {"shared-region-bit-net": "net", "spatial-neighbor": "space"}.get(
                        reason, reason
                    )
                    for reason in component["inclusionReasons"]
                    if reason != "region-intersection"
                ],
                net_ids_of(component),
            ]
            for component_id, component in sorted(self.components.items())
            if component_id not in self.region_ids
        ]
        tunnel_groups: dict[str, dict[str, set[str]]] = defaultdict(
            lambda: {"componentIds": set(), "netIds": set()}
        )
        for tunnel in self.tunnels.values():
            label = tunnel.get("label") or ""
            tunnel_groups[label]["componentIds"].add(tunnel["componentId"])
            tunnel_groups[label]["netIds"].update(
                bit["netId"] for bit in tunnel["netBits"]
            )
        tunnels = [
            [label or None, sorted(group["componentIds"]), sorted(group["netIds"])]
            for label, group in sorted(tunnel_groups.items())
        ]
        states = [
            [
                state["componentId"],
                state["kind"],
                state.get("label"),
                state["componentId"] in self.region_ids,
                [
                    [
                        port["role"],
                        [
                            bit["netId"]
                            for bit in port["netBits"]
                            if bit["netId"] in self.nets
                        ],
                    ]
                    for port in state["ports"]
                    if any(bit["netId"] in self.nets for bit in port["netBits"])
                ],
            ]
            for _, state in sorted(self.states.items())
        ]
        nets = []
        for net_id in sorted(self.nets):
            net = self.nets[net_id]
            directions = Counter(contact.get("direction") for contact in net["contacts"])
            region_contacts = [
                [
                    contact["componentId"],
                    contact["endIndex"],
                    contact["bit"],
                    contact.get("semanticRole"),
                ]
                for contact in net["contacts"]
                if contact["componentId"] in self.region_ids
            ]
            nets.append(
                [
                    net_id,
                    net["kind"],
                    net["contactCount"],
                    directions.get("input", 0),
                    directions.get("output", 0),
                    directions.get("inout", 0),
                    net["contactCount"] == 1,
                    region_contacts,
                ]
            )
        paths = [
            [
                path["root"],
                [
                    [
                        step["parentCircuit"],
                        step["instanceId"],
                        step["location"]["x"],
                        step["location"]["y"],
                        step["targetCircuit"],
                    ]
                    for step in path["steps"]
                ],
            ]
            for path in self.projection["instancePaths"]
        ]
        source_coverage = self.document["coverage"]["sourceLedger"]
        result["overview"] = {
            "selection": {
                "rule": "region + same-net contacts + nearest spatial neighbors",
                "spatialNeighborsPerRegionComponent": self.document["coverage"][
                    "projection"
                ]["spatialNeighborLimitPerRegionComponent"],
                "adjacentNetExpansion": "none",
            },
            "columns": {
                "regionComponents": ["id", "factory", "label", "x", "y", "attrs", "ends"],
                "ends": ["index", "role", "direction", "width", "x", "y", "bits"],
                "bits": ["bit", "netId", "contactCount"],
                "adjacentComponents": ["id", "factory", "label", "x", "y", "why", "relevantNets"],
                "nets": ["id", "kind", "contacts", "inputs", "outputs", "inouts", "singleton", "regionContacts"],
                "regionContacts": ["componentId", "endIndex", "bit", "role"],
                "tunnels": ["label", "componentIds", "netIds"],
                "states": ["componentId", "kind", "label", "inRegion", "ports"],
                "statePorts": ["role", "netIds"],
                "instancePaths": ["root", "steps"],
                "instanceSteps": ["parentCircuit", "instanceId", "x", "y", "targetCircuit"],
            },
            "instancePaths": paths,
            "regionComponents": region_components,
            "adjacentComponents": adjacent_components,
            "netIndex": nets,
            "tunnelIndex": tunnels,
            "stateIndex": states,
            "coverage": {
                "sourceHealth": {
                    "components": source_coverage["components"],
                    "ends": source_coverage["ends"],
                    "endBits": source_coverage["endBits"],
                    "mappedEndBits": source_coverage["mappedEndBits"],
                    "unknownWidthEnds": source_coverage["unknownWidthEnds"],
                    "invalidBundleEnds": source_coverage["invalidBundleEnds"],
                    "widthIncompatibilities": source_coverage["widthIncompatibilities"],
                },
                "projection": self.document["coverage"]["projection"],
            },
            "unknownCodes": [item["code"] for item in self.document["unknowns"]],
            "nextQueries": {
                "component": "component COMPONENT_ID [COMPONENT_ID ...]",
                "net": "net NET_ID [NET_ID ...]",
            },
        }
        corrections = [
            {"componentId": component_id, "endIndex": end["index"],
             "direction": end["direction"], "nativeDirection": end["nativeDirection"],
             "directionSource": end["directionSource"]}
            for component_id, component in self.components.items()
            for end in component["ends"] if "directionSource" in end
        ]
        if corrections:
            result["overview"]["directionCorrections"] = corrections
        return result

    def component_query(self, requested: list[str]) -> dict[str, Any]:
        if not requested:
            raise QueryError("component requires at least one component ID")
        missing = [component_id for component_id in requested if component_id not in self.components]
        if missing:
            raise QueryError(
                f"unknown component ID(s): {', '.join(missing)}; run overview for available IDs"
            )
        component_ids = stable_ids(requested)
        net_ids = stable_ids(
            net_id
            for component_id in component_ids
            for net_id in net_ids_of(self.components[component_id])
        )
        result = self.detail_envelope("component", component_ids, net_ids)
        result["requestedComponents"] = [self.components[item] for item in component_ids]
        result["detailCoverage"]["requestedComponents"] = len(component_ids)
        omitted = sum(
            end["omittedNetBitCount"]
            for component_id in component_ids
            for end in self.components[component_id]["ends"]
        )
        result["detailCoverage"]["requestedComponentsOmittedNetBits"] = omitted
        if omitted:
            result["unknowns"].append(
                {
                    "code": "REQUESTED_ADJACENT_NETS_OMITTED",
                    "claim": (
                        "At least one requested adjacent component has nets outside the "
                        "one-hop public projection; only its region-relevant nets are shown."
                    ),
                    "omittedNetBits": omitted,
                }
            )
        return result

    def net_query(self, requested: list[str]) -> dict[str, Any]:
        if not requested:
            raise QueryError("net requires at least one net ID")
        missing = [net_id for net_id in requested if net_id not in self.nets]
        if missing:
            raise QueryError(
                f"unknown net ID(s): {', '.join(missing)}; run overview for available IDs"
            )
        net_ids = stable_ids(requested)
        return self.detail_envelope("net", net_ids, net_ids)

    def detail_envelope(
        self, kind: str, arguments: list[str], net_ids: list[str]
    ) -> dict[str, Any]:
        result = self.envelope(kind, arguments)
        selected_nets = [self.nets[net_id] for net_id in net_ids]
        contact_ids = stable_ids(
            contact["componentId"]
            for net in selected_nets
            for contact in net["contacts"]
        )
        bundle_ids = stable_ids(
            slice_["bundleId"]
            for net in selected_nets
            for slice_ in net["slices"]
        )
        wire_ids = stable_ids(
            wire_id
            for bundle_id in bundle_ids
            for wire_id in self.bundles[bundle_id]["wireIds"]
        )
        closed_bundles = []
        for bundle_id in bundle_ids:
            bundle = self.bundles[bundle_id]
            kept_bits = [
                bit for bit in bundle["bitNets"] if bit.get("netId") in net_ids
            ]
            closed_bundles.append(
                {
                    "bundleId": bundle_id,
                    "valid": bundle["valid"],
                    "width": bundle["width"],
                    "widthDeterminant": bundle["widthDeterminant"],
                    "points": bundle["points"],
                    "wireIds": bundle["wireIds"],
                    "selectedBitNets": kept_bits,
                    "omittedBitNetCount": len(bundle["bitNets"]) - len(kept_bits),
                }
            )
        result.update(
            {
                "nets": selected_nets,
                "columns": {
                    "contactComponents": ["id", "factory", "label", "x", "y", "inRegion"],
                    "relatedTunnels": ["componentId", "label", "x", "y", "selectedNetIds"],
                    "relatedStateElements": ["componentId", "kind", "label", "selectedPorts"],
                    "selectedStatePorts": ["role", "netIds"],
                },
                "contactComponents": [
                    [
                        component_id,
                        self.components[component_id]["factoryName"],
                        label_of(self.components[component_id]),
                        self.components[component_id]["location"]["x"],
                        self.components[component_id]["location"]["y"],
                        self.components[component_id]["inRegion"],
                    ]
                    for component_id in contact_ids
                ],
                "wireBundles": closed_bundles,
                "wires": [self.wires[wire_id] for wire_id in wire_ids],
                "relatedTunnels": [
                    [
                        component_id,
                        self.tunnels[component_id].get("label"),
                        self.tunnels[component_id]["location"]["x"],
                        self.tunnels[component_id]["location"]["y"],
                        [
                            bit["netId"]
                            for bit in self.tunnels[component_id]["netBits"]
                            if bit["netId"] in net_ids
                        ],
                    ]
                    for component_id in contact_ids
                    if component_id in self.tunnels
                ],
                "relatedStateElements": [
                    [
                        component_id,
                        self.states[component_id]["kind"],
                        self.states[component_id].get("label"),
                        [
                            [
                                port["role"],
                                [
                                    bit["netId"]
                                    for bit in port["netBits"]
                                    if bit["netId"] in net_ids
                                ],
                            ]
                            for port in self.states[component_id]["ports"]
                            if any(bit["netId"] in net_ids for bit in port["netBits"])
                        ],
                    ]
                    for component_id in contact_ids
                    if component_id in self.states
                ],
                "detailCoverage": {
                    "selectedNets": len(selected_nets),
                    "contacts": sum(net["contactCount"] for net in selected_nets),
                    "contactComponents": len(contact_ids),
                    "wireBundles": len(closed_bundles),
                    "wires": len(wire_ids),
                },
                "unknowns": [],
            }
        )
        return result


def main(argv: list[str]) -> int:
    kind = argv[0] if argv else "overview"
    arguments = argv[1:] if argv else []
    try:
        document = json.load(sys.stdin)
        surface = Surface(document)
        if kind == "overview":
            if arguments:
                raise QueryError("overview takes no IDs")
            output = surface.overview()
        elif kind == "component":
            output = surface.component_query(arguments)
        elif kind == "net":
            output = surface.net_query(arguments)
        else:
            raise QueryError(f"unknown query: {kind}; expected overview, component, or net")
        emit(output)
        return 0
    except (QueryError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        emit({"schema": QUERY_SCHEMA, "error": str(error)})
        return 65


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
