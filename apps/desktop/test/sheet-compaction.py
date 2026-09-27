"""Routed-sheet compaction (studio/domain/compaction.py): parts, labels and
vertical runs move left only, things at overlapping heights keep their order
and at least a grid step apart, so crossings and connectivity stay as routed;
parts that shared a left edge still do.
Pure geometry, no model, no JVM."""
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.domain.compaction import compact_x  # noqa: E402


def part(x, y, w=40, h=40, ports=(), **kw):
    """A part with its box at (x, y) and ports given relative to that corner."""
    return dict({'boxes': [(x, y, x + w, y + h)], 'ports': [(x + dx, y + dy) for dx, dy in ports]}, **kw)


def crossings(wires):
    h = [(min(a[0], b[0]), max(a[0], b[0]), a[1]) for a, b in wires if a[1] == b[1]]
    v = [(min(a[1], b[1]), max(a[1], b[1]), a[0]) for a, b in wires if a[0] == b[0]]
    return sum(1 for x0, x1, y in h for y0, y1, x in v if x0 < x < x1 and y0 < y < y1)


class Compaction(unittest.TestCase):
    def test_air_between_wired_parts_goes(self):
        a, b = part(100, 100, ports=[(40, 20)]), part(600, 100, ports=[(0, 20)])
        dx, wires = compact_x([a, b], [((140, 120), (600, 120), False)], part_gap=60)
        self.assertEqual(dx[0], 0)                                  # the leftmost part stays
        self.assertEqual(600 + dx[1], 140 + 60)                     # b comes up to the gap
        self.assertEqual(wires, [((140, 120), (200, 120))])        # the wire shrinks with it

    def test_a_crossing_stays_a_crossing(self):
        # a horizontal wire a -> b, and a vertical run from c (above) to d (below) crossing it
        a, b = part(100, 200, ports=[(40, 20)]), part(700, 200, ports=[(0, 20)])
        c, d = part(380, 0, ports=[(20, 40)]), part(380, 400, ports=[(20, 0)])
        wires = [((140, 220), (700, 220), False), ((400, 40), (400, 400), False)]
        dx, moved = compact_x([a, b, c, d], wires, part_gap=60)
        self.assertEqual(crossings(moved), 1)
        run_x = moved[1][0][0]
        self.assertTrue(moved[0][0][0] < run_x < moved[0][1][0])

    def test_nets_at_one_height_never_touch(self):
        # two wires of different nets on one line, nothing else between them:
        # they close up to a grid step apart, never onto each other (Logisim
        # would join them into one net)
        ends = [{'boxes': [], 'ports': [(x, 20)]} for x in (100, 200, 500, 600)]
        wires = [((100, 20), (200, 20), False), ((500, 20), (600, 20), False)]
        dx, moved = compact_x(ends, wires, part_gap=60)
        (_a, first_end), (second_start, _b) = moved
        self.assertLess(600 + dx[3], 600)                           # it did compact
        self.assertEqual(second_start[0] - first_end[0], 10)

    def test_parts_at_other_heights_slide_past_but_not_through(self):
        a = part(100, 100)                       # a at the top left
        b = part(500, 300)                       # b lower down, nothing at its height to the left
        c = part(500, 100)                       # c at a's height
        dx, _ = compact_x([a, b, c], [], part_gap=60)
        self.assertEqual(500 + dx[1], 100)       # b slides all the way to the left edge
        self.assertEqual(500 + dx[2], 200)       # c stops at a + gap

    def test_fixed_parts_and_ordered_pairs_hold(self):
        a = part(100, 100, fixed=True)
        b = part(500, 300, ports=[(20, 0)])
        c = part(900, 500, ports=[(20, 0)])
        dx, _ = compact_x([a, b, c], [], part_gap=60, keep_order=[((1, 520), (2, 920))])
        self.assertEqual(dx[0], 0)
        self.assertGreaterEqual((920 + dx[2]) - (520 + dx[1]), 10)

    def test_a_label_on_a_lead_moves_with_its_port(self):
        a = part(100, 100, ports=[(40, 20)])
        b = part(600, 100, ports=[(40, 20)])
        label = part(650, 110, w=50, h=20, ports=[(0, 10)], cling=True)   # Tunnel one cell off b's output
        dx, moved = compact_x([a, b, label], [((640, 120), (650, 120), False)], part_gap=60)
        self.assertEqual(dx[1], dx[2])
        self.assertEqual(moved[0][1][0] - moved[0][0][0], 10)

    def test_a_column_moves_as_one(self):
        # b and c share a left edge; only c has a neighbour (a) at its height,
        # so alone b would slide to the sheet's edge and c would stop at a
        a = part(100, 100)
        b = part(500, 300)
        c = part(500, 100)
        dx, _ = compact_x([a, b, c], [], part_gap=60, together=[[1, 2]])
        self.assertEqual(dx[1], dx[2])
        self.assertEqual(500 + dx[2], 200)

    def test_no_denser_than_min_width(self):
        parts = [part(100 + 400 * i, 100 * (i % 2)) for i in range(4)]
        dx, _ = compact_x(parts, [], part_gap=60, min_width=900)
        right = max(100 + 400 * i + 40 + d for i, d in enumerate(dx))
        self.assertGreaterEqual(right - 100, 900)
        self.assertLess(right - 100, 100 + 400 * 3 + 40 - 100)    # but still narrower than before


if __name__ == '__main__':
    unittest.main()
