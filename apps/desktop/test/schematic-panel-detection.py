"""Panel detection for arrange_candidate must key on what the cluster is made
of, not on how large it is relative to the body.

The course observation panel is a fixed ~80-part block (Pins, Probes, displays,
the pause-clock control) above a body that grows from ~60 parts (关卡 2) to
~250 (关卡 5). A size ratio rejects the same panel once the body is big enough,
after which the clock control gets re-laid-out and the equivalence guard drops
the candidate. No model, no personal circuit: the shapes are synthesised.
"""
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.domain.schematic_layout import SchematicLayout  # noqa: E402


def part(i, factory, x, y):
    return {'componentId': f'c{i}', 'factoryName': factory, 'location': {'x': x, 'y': y},
            'bounds': {'x': x, 'y': y, 'width': 30, 'height': 20}, 'ends': [], 'attributes': []}


def circuit(panel, body, gap=280):
    """panel/body: lists of factory names; rows of 10 parts, 40 px apart."""
    parts, i = [], 0
    for k, f in enumerate(panel):
        parts.append(part(i, f, 100 + (k % 10) * 100, 100 + (k // 10) * 40)); i += 1
    top = 100 + ((len(panel) - 1) // 10) * 40 + gap
    for k, f in enumerate(body):
        parts.append(part(i, f, 100 + (k % 10) * 100, top + (k // 10) * 40)); i += 1
    return parts


def detect(parts):
    layout = SchematicLayout.__new__(SchematicLayout)
    layout.components = parts
    return layout._detect_panel()


COURSE_PANEL = ['Pin'] * 24 + ['Probe'] * 20 + ['Hex Digit Display'] * 8 + ['Text'] * 12 + ['LED'] * 4 + \
               ['Button'] * 4 + ['Clock', 'Counter', 'Comparator', 'Controlled Buffer', 'NAND Gate', 'D Flip-Flop', 'Pull Resistor', 'Constant']
LOGIC = ['Register', 'Multiplexer', 'AND Gate', 'Adder', 'Splitter']


class PanelDetection(unittest.TestCase):
    def test_course_panel_is_found_over_a_small_body(self):
        y = detect(circuit(COURSE_PANEL, LOGIC * 12))
        self.assertIsNotNone(y)
        self.assertGreater(y, 100 + 7 * 40)

    def test_course_panel_is_still_found_over_a_large_body(self):
        # 80 panel parts over 250 body parts: 24 % of the circuit, below the old
        # one-quarter rule. The cluster is 90 % I/O and annotation, so it is a panel.
        parts = circuit(COURSE_PANEL, LOGIC * 50)
        self.assertLess(len(COURSE_PANEL), len(parts) // 4)
        self.assertIsNotNone(detect(parts))

    def test_a_logic_slice_above_a_gap_is_not_a_panel(self):
        # A sparse first stage of pure logic separated by whitespace is body.
        parts = circuit(LOGIC * 4, LOGIC * 50)
        self.assertIsNone(detect(parts))

    def test_small_circuits_have_no_panel(self):
        self.assertIsNone(detect(circuit(['Pin'] * 6, LOGIC * 4)))


if __name__ == '__main__':
    unittest.main()
