"""Router: a target no route can reach is recognised from the few cells
around it (Router.boxed_in) instead of by flooding the whole sheet, and the
answer is the one A* gives; a dear corner (a re-layout's bend cost) buys a
route with fewer corners. Pure geometry, no model, no JVM."""
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.domain.routing import Router, Partition  # noqa: E402


def part(cid, x, y, w, h, ends):
    return {'componentId': cid, 'factoryName': 'NOT Gate', 'bounds': {'x': x, 'y': y, 'width': w, 'height': h},
            'ends': [{'location': {'x': px, 'y': py}, 'direction': d, 'netBits': [{'bit': 0, 'netId': net}]}
                     for px, py, d, net in ends]}


def router(walls):
    """A body with an input port at (100, 100) on its west edge, the driver
    of that net at (300, 100), and foreign ports on the given cells."""
    parts = [part('body', 100, 80, 40, 40, [(100, 100, 'input', 'n')]),
             part('driver', 260, 90, 40, 20, [(300, 100, 'output', 'n')])]
    parts += [part(f'w{i}', x - 5, y - 5, 10, 10, [(x, y, 'output', f'f{i}')]) for i, (x, y) in enumerate(walls)]
    r = Router({'focus': {'components': parts, 'wires': [], 'wireBundles': []}}, Partition())
    source = {'location': {'x': 300, 'y': 100}, 'netBits': [{'bit': 0, 'netId': 'n'}]}
    target = {'location': {'x': 100, 'y': 100}, 'netBits': [{'bit': 0, 'netId': 'n2'}]}
    return r, source, target


class Pockets(unittest.TestCase):
    def test_a_port_walled_in_by_foreign_ports_fails_at_once(self):
        r, source, target = router([(90, 100), (100, 90), (100, 110)])
        owner = r.owner(source['netBits'])
        self.assertTrue(r.boxed_in((100, 100), {(300, 100)}, owner))
        with self.assertRaises(ValueError):
            r.route(source, target)

    def test_one_opening_is_enough(self):
        r, source, target = router([(90, 100), (100, 90)])
        owner = r.owner(source['netBits'])
        self.assertFalse(r.boxed_in((100, 100), {(300, 100)}, owner))
        self.assertTrue(r.route(source, target))


class Corners(unittest.TestCase):
    def route(self, bend_cost):
        # a driver's output at (100, 100) and a consumer's input at (400, 300),
        # nothing between: two corners take the shortest way round the
        # consumer's edge, one corner runs along it
        parts = [part('driver', 60, 80, 40, 40, [(100, 100, 'output', 'n')]),
                 part('consumer', 400, 280, 40, 40, [(400, 300, 'input', 'n')])]
        r = Router({'focus': {'components': parts, 'wires': [], 'wireBundles': []}}, Partition(), bend_cost=bend_cost)
        source = {'location': {'x': 100, 'y': 100}, 'netBits': [{'bit': 0, 'netId': 'n'}]}
        target = {'location': {'x': 400, 'y': 300}, 'netBits': [{'bit': 0, 'netId': 'n2'}]}
        return r.route(source, target)

    def test_a_dear_corner_buys_a_route_with_fewer_corners(self):
        self.assertEqual(len(self.route(18)), 3)          # three segments, two corners
        self.assertEqual(len(self.route(400)), 2)         # two segments, one corner


if __name__ == '__main__':
    unittest.main()
