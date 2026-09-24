"""Routed copper must survive Logisim's load-time wire repair.

The router lets a fanout branch start anywhere on its own bus, so two branches
may leave a trunk from opposite sides at the same interior point, forming a
'+'. On load Logisim merges the two collinear branch wires (exactly two wires
meet there, no third end) and the trunk is never split, so the '+' is a plain
crossing and the net falls apart. SchematicLayout splits the trunk at that
point; this checks both the helper and the native behaviour it works around.
"""
import sys
import tempfile
import unittest
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace                      # noqa: E402
from studio.domain.schematic_layout import SchematicLayout, GRID, _attr  # noqa: E402


class SplitAtEndpoints(unittest.TestCase):
    def test_trunk_is_split_where_branches_leave_it(self):
        wires = [((100, 200), (300, 200)), ((200, 200), (200, 100)), ((200, 200), (200, 300))]
        out = set(SchematicLayout._split_at_endpoints(wires))
        self.assertEqual(out, {((100, 200), (200, 200)), ((200, 200), (300, 200)), ((200, 100), (200, 200)), ((200, 200), (200, 300))})

    def test_plain_crossing_is_untouched(self):
        wires = [((100, 200), (300, 200)), ((200, 100), (200, 300))]
        self.assertEqual(sorted(SchematicLayout._split_at_endpoints(wires)), sorted(wires))

    def test_endpoint_on_a_parallel_line_does_not_cut(self):
        # an end at y=100 must not cut a horizontal at y=200 just because x matches
        wires = [((100, 200), (300, 200)), ((200, 100), (250, 100))]
        self.assertEqual(sorted(SchematicLayout._split_at_endpoints(wires)), sorted(wires))


class NativeWireRepair(unittest.TestCase):
    """A '+' of three wires loads as two disconnected nets; the split trunk does not."""

    def nets(self, wires):
        pins = [('a', 100, 200, False, 'east'), ('b', 300, 200, True, 'west'), ('c', 200, 100, True, 'south'), ('d', 200, 300, True, 'north')]
        comps = ''.join(f'<comp lib="0" name="Pin" loc="({x},{y})"><a name="output" val="{str(out).lower()}"/><a name="facing" val="{f}"/><a name="label" val="{n}"/></comp>'
                        for n, x, y, out, f in pins)
        xml = ''.join(f'<wire from="({a[0]},{a[1]})" to="({b[0]},{b[1]})"/>' for a, b in wires)
        with tempfile.TemporaryDirectory(prefix='vibe-junction-') as tmp:
            root = Path(tmp)
            src = root / 'j.circ'
            src.write_text('<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/><circuit name="main">' + comps + xml + '</circuit></project>')
            w = Workspace(REPO, root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'junction')
            try:
                w.open_path(src)
                focus = w.observer.run_full(src, 'main')['focus']
            finally:
                w.close()
        groups = defaultdict(set)
        for c in focus['components']:
            label = _attr(c, 'label')
            bits = c['ends'][0].get('netBits') or []
            groups[tuple(sorted(b['netId'] for b in bits))].add(label)
        return sorted(sorted(g) for g in groups.values())

    def test_plus_of_three_wires_loses_the_junction_but_the_split_trunk_keeps_it(self):
        plus = [((100, 200), (300, 200)), ((200, 200), (200, 100)), ((200, 200), (200, 300))]
        self.assertEqual(self.nets(plus), [['a', 'b'], ['c', 'd']])
        self.assertEqual(self.nets(SchematicLayout._split_at_endpoints(plus)), [['a', 'b', 'c', 'd']])


class ConstantBody(unittest.TestCase):
    def test_body_width_follows_the_bit_width(self):
        # measured with the observer: 16 px up to 8 bits, +10 px per further hex digit
        body = lambda width: 16 + 10 * max(0, (width + 3) // 4 - 2)
        self.assertEqual([body(w) for w in (1, 8, 9, 12, 13, 16, 32)], [16, 16, 26, 26, 36, 36, 76])
        self.assertEqual(GRID, 10)


if __name__ == '__main__':
    unittest.main()
