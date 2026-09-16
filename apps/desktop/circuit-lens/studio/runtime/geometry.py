from __future__ import annotations

from pathlib import Path
import re
from http import HTTPStatus
import xml.etree.ElementTree as ET
from studio.domain.errors import LensError

POINT_RE = re.compile(r"^\((-?\d+),(-?\d+)\)$")


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def parse_point(value: str | None) -> dict[str, int] | None:
    if value is None:
        return None
    match = POINT_RE.match(value)
    if not match:
        return None
    return {"x": int(match.group(1)), "y": int(match.group(2))}


def attrs_from_xml(element: ET.Element) -> dict[str, str]:
    result: dict[str, str] = {}
    for child in element:
        if local_name(child.tag) != "a":
            continue
        name = child.attrib.get("name")
        if name:
            result[name] = child.attrib.get("val", child.text or "")
    return result


def bounds_for_points(points: list[dict[str, int]], padding: int = 0) -> dict[str, int]:
    if not points:
        return {"x": 0, "y": 0, "width": 1, "height": 1}
    left = min(point["x"] for point in points) - padding
    top = min(point["y"] for point in points) - padding
    right = max(point["x"] for point in points) + padding
    bottom = max(point["y"] for point in points) + padding
    return {
        "x": left,
        "y": top,
        "width": max(1, right - left),
        "height": max(1, bottom - top),
    }


def rect_intersects(a: dict[str, int], b: dict[str, int]) -> bool:
    return not (
        a["x"] + a["width"] < b["x"]
        or b["x"] + b["width"] < a["x"]
        or a["y"] + a["height"] < b["y"]
        or b["y"] + b["height"] < a["y"]
    )


def parse_raw_project(data: bytes, filename: str) -> dict[str, Any]:
    """Parse display geometry only; no connectivity is created here."""
    try:
        root = ET.fromstring(data)
    except (ET.ParseError, ValueError) as error:
        raise LensError(HTTPStatus.UNPROCESSABLE_ENTITY, "INVALID_CIRC_XML", str(error))
    return parse_raw_root(root, filename)


def parse_raw_root(root: ET.Element, filename: str) -> dict[str, Any]:
    if local_name(root.tag) != "project":
        raise LensError(
            HTTPStatus.UNPROCESSABLE_ENTITY,
            "NOT_LOGISIM_PROJECT",
            "The uploaded document has no Logisim <project> root.",
        )

    main_circuit: str | None = None
    libraries: list[dict[str, str]] = []
    circuit_elements: list[ET.Element] = []
    for child in root:
        kind = local_name(child.tag)
        if kind == "main":
            main_circuit = child.attrib.get("name")
        elif kind == "lib":
            libraries.append(dict(child.attrib))
        elif kind == "circuit":
            circuit_elements.append(child)

    circuit_names = {
        item.attrib.get("name", "") for item in circuit_elements if item.attrib.get("name")
    }
    circuits = [parse_raw_circuit(element, circuit_names) for element in circuit_elements]

    if not circuits:
        raise LensError(
            HTTPStatus.UNPROCESSABLE_ENTITY,
            "NO_CIRCUITS",
            "The project contains no circuit definitions.",
        )
    if main_circuit not in {item["name"] for item in circuits}:
        main_circuit = circuits[0]["name"]
    return {
        "name": Path(filename).stem,
        "mainCircuit": main_circuit,
        "sourceVersion": root.attrib.get("source"),
        "libraries": libraries,
        "circuits": circuits,
    }


def parse_raw_circuit(circuit_element: ET.Element, circuit_names: set[str]) -> dict[str, Any]:
    """Display projection of one definition; native runtime owns connectivity."""
    name = circuit_element.attrib.get("name") or "(unnamed)"
    components: list[dict[str, Any]] = []
    wires: list[dict[str, Any]] = []
    points: list[dict[str, int]] = []
    component_index = 0
    wire_index = 0
    for child in circuit_element:
        kind = local_name(child.tag)
        if kind == "comp":
            location = parse_point(child.attrib.get("loc"))
            if location is None:
                continue
            attributes = attrs_from_xml(child)
            factory = child.attrib.get("name", "Unknown")
            component = {
                "componentId": f"xml:c{component_index:04d}",
                "factory": factory,
                "label": attributes.get("label") or None,
                "location": location,
                "bounds": {
                    "x": location["x"] - 10,
                    "y": location["y"] - 10,
                    "width": 20,
                    "height": 20,
                },
                "boundsAuthority": "approximate XML point marker",
                "attributes": attributes,
                "library": child.attrib.get("lib"),
                "subcircuit": factory if factory in circuit_names else None,
                "ends": [],
            }
            components.append(component)
            points.append(location)
            component_index += 1
        elif kind == "wire":
            start = parse_point(child.attrib.get("from"))
            end = parse_point(child.attrib.get("to"))
            if start is None or end is None:
                continue
            wires.append(
                {
                    "wireId": f"xml:w{wire_index:04d}",
                    "from": start,
                    "to": end,
                    "netId": None,
                }
            )
            points.extend((start, end))
            wire_index += 1
    instances = [
        {
            "instanceId": component["componentId"],
            "target": component["subcircuit"],
            "location": component["location"],
            "bounds": component["bounds"],
            "label": component["label"],
        }
        for component in components
        if component["subcircuit"]
    ]
    return {
        "name": name,
        "bounds": bounds_for_points(points, 20),
        "componentCount": len(components),
        "wireCount": len(wires),
        "instances": instances,
        "components": components,
        "wires": wires,
    }


def circuit_summary(project: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": project["name"],
        "mainCircuit": project["mainCircuit"],
        "sourceVersion": project.get("sourceVersion"),
        "libraries": project.get("libraries", []),
        "circuits": [
            {
                "name": circuit["name"],
                "bounds": circuit["bounds"],
                "componentCount": circuit["componentCount"],
                "wireCount": circuit["wireCount"],
                "instances": circuit["instances"],
            }
            for circuit in project["circuits"]
        ],
    }


def relative_external_libraries(project: dict[str, Any]) -> list[str]:
    result: list[str] = []
    for library in project.get("libraries", []):
        descriptor = library.get("desc", "")
        if descriptor.startswith("file#"):
            path = descriptor[5:]
        elif descriptor.startswith("jar#"):
            path = descriptor[4:].split("#", 1)[0]
        else:
            continue
        if path and not Path(path).is_absolute():
            result.append(descriptor)
    return result


def external_library_descriptors(project: dict[str, Any]) -> list[str]:
    return [
        library.get("desc", "")
        for library in project.get("libraries", [])
        if library.get("desc", "").startswith(("file#", "jar#"))
    ]

