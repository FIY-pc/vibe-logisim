"""Lossless module boundaries and incremental/full parse equivalence."""
from pathlib import Path
import sys
import unittest
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
sys.path.insert(0, str(REPO / 'apps/desktop/test'))
from support.samples import skip_unless_samples
from studio.project.document import CircuitDocument
from studio.runtime.geometry import parse_raw_project


class Document(unittest.TestCase):
    def test_repeated_edits_preserve_unrelated_bytes_and_old_documents(self):
        # Empty elements adjacent to closing tags, > inside names, fake markup
        # in comments/CDATA, non-ASCII byte offsets, and CRLF source formatting.
        header = '<?xml version="1.0" encoding="UTF-8"?>\r\n<project source="2.15.0.2.exe"><lib name="0" desc="#Wiring"/>\r\n'
        sections = ['<circuit name="甲 > 乙"><!-- <circuit/> --><a name="note"><![CDATA[</circuit>]]></a><?note keep?><comp name="Text" loc="(10,10)"/></circuit>',
                    '<circuit name="middle"/>', '<circuit name="last"/>']
        before = (header + '\r\n'.join(sections) + '</project>').encode()
        document = CircuitDocument.parse(before, 'test.circ')
        for name in ('last', '甲 > 乙', 'middle', 'last', 'middle'):
            previous, previous_data = document, document.data
            old = document.circuit(name)
            untouched = [ET.tostring(document.circuit(n)) for n in ('last', '甲 > 乙', 'middle') if n != name]
            ET.SubElement(old, 'comp', name='Pin', lib='0', loc='(100,200)')
            document = document.replace_circuit(old)
            self.assertEqual(document.projection, parse_raw_project(document.data, 'test.circ'))
            self.assertEqual(previous.data, previous_data)
            self.assertEqual(previous.projection, parse_raw_project(previous.data, 'test.circ'))
            self.assertEqual(untouched, [ET.tostring(document.circuit(n)) for n in ('last', '甲 > 乙', 'middle') if n != name])
            # Prefix/suffix are independently delimited by known source strings.
            marker = ('<circuit name="' + name.replace('>', '&gt;') + '"').encode()
            old_marker = marker if marker in previous_data else ('<circuit name="'+name+'"').encode()
            start = previous_data.index(old_marker)
            self.assertEqual(document.data[:start], previous_data[:start])
            self.assertTrue(document.data.startswith(header.encode()))
            self.assertTrue(document.data.endswith(b'</project>'))
            self.assertIn(b'<!-- <circuit/> -->', document.data)
            self.assertIn(b'<?note keep?>', document.data)
            old.clear()  # Caller retaining its mutable tree cannot alter either revision.
            self.assertEqual(document.projection, parse_raw_project(document.data, 'test.circ'))

    def test_unusual_xml_uses_safe_full_serialization(self):
        documents = ['<?xml version="1.0" encoding="UTF-16"?><project><circuit name="电路"/></project>'.encode('utf-16'),
                     b'<!DOCTYPE project [<!ENTITY title "main">]><project><circuit name="&title;"/></project>',
                     b'<project><n:circuit xmlns:n="urn:test" name="main"/></project>']
        for data in documents:
            before = CircuitDocument.parse(data, 'fallback.circ')
            name = before.projection['mainCircuit']
            circuit = before.circuit(name)
            ET.SubElement(circuit, 'wire', {'from':'(0,0)', 'to':'(100,0)'})
            after = before.replace_circuit(circuit)
            self.assertEqual(after.projection, parse_raw_project(after.data, 'fallback.circ'))
            self.assertEqual(after.projection['circuits'][0]['wireCount'], 1)
            self.assertEqual(before.data, data)

    @skip_unless_samples(REPO, 'exports/interface-editing/stage6-if-id.circ')
    def test_course_edits_do_not_rewrite_other_modules(self):
        source = (REPO / 'exports/interface-editing/stage6-if-id.circ').read_bytes()
        document = CircuitDocument.parse(source, 'course.circ')
        circuit = document.circuit('IF_ID')
        ET.SubElement(circuit, 'comp', name='Text', lib='6', loc='(900,900)')
        after = document.replace_circuit(circuit)
        start = source.index(b'<circuit name="IF_ID"')
        end = source.index(b'</circuit>', start) + len(b'</circuit>')
        self.assertTrue(after.data.startswith(source[:start]))
        self.assertTrue(after.data.endswith(source[end:]))
        self.assertEqual(after.projection, parse_raw_project(after.data, 'course.circ'))
        self.assertEqual(after.palette_identity([]), document.palette_identity([]))
        ET.SubElement(circuit, 'comp', name='Pin', lib='0', loc='(400,400)')
        pins = document.replace_circuit(circuit)
        self.assertNotEqual(pins.palette_identity([]), document.palette_identity([]))
        self.assertEqual(document.data, source)


if __name__ == '__main__':
    unittest.main()
