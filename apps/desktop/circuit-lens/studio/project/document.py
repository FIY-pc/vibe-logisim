"""Immutable source document for edits confined to one circuit definition.

Only circuit() returns a mutable tree, and it returns a copy. Replacing that
tree creates a new document. Unchanged definitions share their parsed display
projections; bytes outside the edited definition remain exactly as supplied.
Arbitrary file edits and revision restoration always enter through parse().
"""
from __future__ import annotations

import copy
import hashlib
import json
from http import HTTPStatus
import xml.etree.ElementTree as ET
from xml.parsers import expat

from studio.domain.errors import LensError
from studio.runtime.geometry import local_name, parse_raw_root, parse_raw_circuit


def _spans(data):
    """Index XML element boundaries, never search for literal circuit markup.

    Byte splicing is limited to ordinary UTF-8 documents without DTDs/namespaces.
    Other XML accepted by the existing parser uses a full serialization on edit.
    """
    if b'\0' in data[:100]:
        return None  # UTF-16/32 without an explicit encoding declaration.
    parser = expat.ParserCreate()
    depth, start, opening_end, empty, spans, eligible = 0, None, None, False, [], True

    def declaration(version, encoding, standalone):
        nonlocal eligible
        eligible = eligible and (encoding or 'utf-8').lower() in {'utf-8', 'utf8'}

    def doctype(*args):
        nonlocal eligible
        eligible = False

    def begin(tag, attrs):
        nonlocal depth, start, opening_end, empty, eligible
        depth += 1
        if any(k.startswith('xmlns') for k in attrs):
            eligible = False
        if depth == 1:
            eligible = eligible and tag == 'project'
        if eligible and depth == 2 and tag == 'circuit':
            start = parser.CurrentByteIndex
            quote = None
            for i in range(start, len(data)):
                char = data[i]
                if quote is not None:
                    if char == quote:
                        quote = None
                elif char in (34, 39):
                    quote = char
                elif char == 62:
                    opening_end, empty = i + 1, data[i-1] == 47
                    break

    def end(tag):
        nonlocal depth
        if eligible and depth == 2 and tag == 'circuit':
            offset = parser.CurrentByteIndex
            # For an empty element Expat points after />, otherwise at </tag>.
            stop = opening_end if empty else data.index(b'>', offset) + 1
            spans.append((start, stop))
        depth -= 1

    parser.XmlDeclHandler = declaration
    parser.StartDoctypeDeclHandler = doctype
    parser.StartElementHandler = begin
    parser.EndElementHandler = end
    parser.Parse(data, True)
    return tuple(spans) if eligible else None


def _palette_part(circuit):
    group = ET.Element('circuit', name=circuit.get('name', ''))
    children = set()
    for node in circuit:
        if node.tag in {'a', 'appear'} or node.tag == 'comp' and node.get('name') == 'Pin':
            group.append(copy.deepcopy(node))
        elif node.tag == 'comp' and node.get('lib') is None:
            children.add(node.get('name', ''))
    for child in sorted(children):
        ET.SubElement(group, 'uses', name=child)
    return hashlib.sha256(ET.tostring(group)).hexdigest()


class CircuitDocument:
    def __init__(self, data, root, filename, spans, projection, palette_parts):
        self.data = data
        self._root = root
        self._filename = filename
        self._spans = spans
        self.projection = projection
        self._circuits = [c for c in root if local_name(c.tag) == 'circuit']
        self._palette_parts = palette_parts

    @classmethod
    def parse(cls, data, filename):
        # Keep comments and processing instructions inside an edited definition.
        parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True, insert_pis=True))
        try:
            root = ET.fromstring(data, parser=parser)
        except (ET.ParseError, ValueError) as error:
            raise LensError(HTTPStatus.UNPROCESSABLE_ENTITY, 'INVALID_CIRC_XML', str(error)) from error
        projection = parse_raw_root(root, filename)
        circuits = [c for c in root if local_name(c.tag) == 'circuit']
        spans = _spans(data)
        if spans is not None and len(spans) != len(circuits):
            spans = None
        return cls(data, root, filename, spans, projection, tuple(map(_palette_part, circuits)))

    def _index(self, name):
        indices = [i for i, c in enumerate(self._circuits) if c.get('name') == name]
        if len(indices) != 1:
            raise ValueError('电路定义不存在或名称不唯一')
        return indices[0]

    def circuit(self, name):
        return copy.deepcopy(self._circuits[self._index(name)])

    def replace_circuit(self, circuit):
        index = self._index(circuit.get('name'))
        original = self._circuits[index]
        if circuit.tag != original.tag:
            raise ValueError('局部编辑不能更改电路定义类型')
        changed = copy.deepcopy(circuit)
        changed.tail = original.tail
        root = copy.copy(self._root)
        root[list(root).index(original)] = changed
        if self._spans is None:
            return self.parse(ET.tostring(root, encoding='utf-8', xml_declaration=True), self._filename)

        fragment = copy.deepcopy(changed)
        fragment.tail = None  # Whitespace after </circuit> belongs to the source.
        payload = ET.tostring(fragment, encoding='utf-8')
        start, stop = self._spans[index]
        data = self.data[:start] + payload + self.data[stop:]
        delta = len(payload) - (stop - start)
        spans = self._spans[:index] + ((start, start + len(payload)),) + tuple(
            (a + delta, b + delta) for a, b in self._spans[index+1:])
        circuits = list(self.projection['circuits'])
        circuits[index] = parse_raw_circuit(changed, {c.get('name') for c in self._circuits})
        parts = list(self._palette_parts)
        parts[index] = _palette_part(changed)
        return CircuitDocument(data, root, self._filename, spans,
                               {**self.projection, 'circuits': circuits}, tuple(parts))

    def palette_identity(self, dependencies):
        libraries = [ET.tostring(c).decode() for c in self._root if c.tag == 'lib']
        definition = [self._root.get('source', ''), libraries, self._palette_parts, dependencies]
        return hashlib.sha256(json.dumps(definition, sort_keys=True).encode()).hexdigest()
