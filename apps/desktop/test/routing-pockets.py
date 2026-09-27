"""Router: a target no route can reach is recognised from the few cells
around it (Router.boxed_in) instead of by flooding the whole sheet, and the
answer is the one A* gives. Pure geometry, no model, no JVM."""
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


if __name__ == '__main__':
    unittest.main()
