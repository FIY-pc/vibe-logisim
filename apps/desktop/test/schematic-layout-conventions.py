"""Drawing conventions arrange_candidate encodes (measured on 233 hand-drawn
HUST CPUs, 2026-09-25):

  - Wire vs Tunnel is decided by driver->consumer distance in px (TUNNEL_SPAN
    by fan-out); a named backward net keeps its Tunnels; an unnamed net has
    no label to read and is wired up to twice the limit.
  - A Tunnel never stands on the port itself: one grid cell off it, on a lead
    wire (6 % of 22.7k corpus tunnels sit on the port; humans draw a lead).
    On ports 10 px apart every other lead is longer, so that no two flags
    lie on top of each other.
  - Pipeline-register subcircuits are recognised by name (IF/ID, 气泡EX/MEM,
    ◇MEM/WB, 流水IF ...) and belong to the stage they feed.
  - Every depth keeps a layer of its own (_compact renumbers only): a part
    merged into the layer before it stood under the parts that feed it.
  - A routing channel is sized by the wired nets that span it, once per net.
  - Without pipeline stages, a part moves right towards its consumers when
    that shortens its wires, so an extender or a constant chain stands beside
    the mux it feeds; input Pins stay at the left edge.
  - A chain of parts wired output to input across neighbouring columns is
    drawn straight, output Pins included (their order is the pinout).
  - A layer far taller than the column budget (many instances of one
    subcircuit on a test sheet) becomes several columns in the author's
    top-to-bottom order; a layer of ordered interface Pins stays one column.
  - A net that reaches several copies of one Splitter (Splitters on the
    same bus) is drawn as one tree per copy: every other port gets copper to
    the copy the author drew it beside only.
  - A wired net whose copper crosses more than two wires per consumer (and
    at least six) becomes Tunnels when it has a name a reader knows; a net
    known only by a made-up name stays a wire.
  - Parts drawn port to port on two or more ports (a Splitter set on a
    decoder's outputs) are placed as one rigid piece: every member moves
    with its host, so the shared ports need no wire.
  - A Splitter joined to a part by three or more two-port nets whose ports
    have the same spacing is drawn port to port (abutment), never onto a
    port of another net; a bit end on the corner of the part's box counts
    as on either edge, and a copy of a Splitter (a bus split again beside
    each part it feeds) docks on the part it serves. Two other parts dock
    only top to bottom (a driver under the display it feeds), never at a
    clocked part.
  - A Pin facing north (south) whose only wire runs to a port on the bottom
    (top) edge of a part stands right below (above) that port; several stand
    in a row in port order, moved sideways as little as their widths need.
  - Pins wired one to one to ports on the facing edge of the next column
    stand level with them: several abreast when a wire fits between two
    Pins, else (ports 10 px apart) in a staircase whose wires are laid
    straight before routing.
  - A CPU drawn with Tunnels only and its parts scattered is re-drawn
    with the same nets.

No model. Shapes are synthesised; the lead, chain and CPU tests observe natively.
"""
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.domain.schematic_layout import (SchematicLayout, PIPELINE_REGISTER_RE, TUNNEL_SPAN,  # noqa: E402
                                            UNNAMED_SPAN_FACTOR, COLUMN_GAP, CHANNEL_MIN, _attr)


def comp(cid, factory, x, y, ends, label=None, width=40, height=40):
    return {'componentId': cid, 'factoryName': factory, 'displayName': factory, 'location': {'x': x, 'y': y},
            'bounds': {'x': x, 'y': y, 'width': width, 'height': height},
            'ends': [{'index': i, 'location': {'x': x + dx, 'y': y + dy}, 'direction': d, 'netBits': [{'bit': 0, 'netId': n}]}
                     for i, (dx, dy, d, n) in enumerate(ends)],
            'attributes': [{'name': 'label', 'standard': label}] if label else []}


def bare(**attrs):
    layout = SchematicLayout.__new__(SchematicLayout)
    layout.column_gap, layout.channel_min, layout.max_layer_span, layout.tunnel_span_scale = COLUMN_GAP, CHANNEL_MIN, 8, 1.0
    layout.report = {'nets': {}}
    layout.copies, layout.fused, layout.relocated = {}, {}, {}
    for k, v in attrs.items():
        setattr(layout, k, v)
    return layout


class PipelineRegisterNames(unittest.TestCase):
    def test_student_names_for_pipeline_registers_match(self):
        for name in ('IF/ID', 'ID/EX', '气泡EX/MEM', '◇MEM/WB', 'ID-EX', 'ID_EX', 'EX→MEM', '流水IF', 'EX级流水寄存器', 'MEM寄存器', 'IF-ID锁存'):
            self.assertIsNotNone(PIPELINE_REGISTER_RE.search(name), name)

    def test_other_subcircuits_do_not(self):
        for name in ('IDEA', 'MEMORY', 'Register', 'ALU', 'IF_IDLE', 'EXTEND', 'WBUS', '◆单周期硬布线控制器', 'IDEX_forwarding_unit'):
            self.assertIsNone(PIPELINE_REGISTER_RE.search(name), name)

    def test_stage_prefix_is_the_stage_a_register_feeds(self):
        layout = bare(by_id={
            'a': comp('a', 'Register', 0, 0, [], label='EX.PC'),
            'b': comp('b', 'IF/ID', 0, 0, []),
            'c': comp('c', '气泡EX/MEM', 0, 0, []),
            'd': comp('d', 'Register', 0, 0, [], label='PC'),
            'e': comp('e', 'ROM', 0, 0, []),
        })
        self.assertEqual([layout._stage_prefix(c) for c in 'abcd'], ['EX', 'ID', 'MEM', None])
        self.assertEqual([layout._is_storage(c) for c in 'abcde'], [True, True, True, True, False])


class CompactRenumbers(unittest.TestCase):
    def test_every_depth_keeps_its_layer(self):
        out = SchematicLayout._compact({'r1': 0, 'g1': 2, 'r2': 5, 'g2': 7, 'g3': 7})
        self.assertEqual((out['r1'], out['g1'], out['r2'], out['g2'], out['g3']), (0, 1, 2, 3, 3))


class SpanDemotion(unittest.TestCase):
    """A named net is tunnelled when its consumer is further than TUNNEL_SPAN
    (by fan-out) from the driver in the planned columns; backward named nets
    always; unnamed nets only beyond UNNAMED_SPAN_FACTOR times that. Columns
    are 40 px parts with a 70 px channel (one wire through), so the pitch is
    110 px and a consumer in column k is 110k - 40 px from the driver's output."""

    def net(self, consumer_columns, *, named=True, backward=False, max_layer_span=64):
        by_id = {'d': comp('d', 'AND Gate', 0, 0, [(40, 20, 'output', 'n')])}
        column, depth, x_offset = {'d': 0}, {'d': 0}, {'d': 0}
        for col in range(1, max(consumer_columns) + 1):          # every column holds a part (as _pack_columns guarantees)
            by_id[f'f{col}'] = comp(f'f{col}', 'OR Gate', 0, 0, [])
            column[f'f{col}'], depth[f'f{col}'], x_offset[f'f{col}'] = col, col, 0
        ports = [('d', 0)]
        for i, col in enumerate(consumer_columns):
            cid = f'c{i}'
            by_id[cid] = comp(cid, 'NOT Gate', 0, 0, [(0, 20, 'input', 'n')])
            column[cid], depth[cid], x_offset[cid] = col, (-1 if backward else col), 0
            ports.append((cid, 0))
        if backward:
            column['d'] = depth['d'] = max(consumer_columns) + 1
            by_id['f0'] = comp('f0', 'OR Gate', 0, 0, []); column['f0'], depth['f0'], x_offset['f0'] = 0, 0, 0
        key = ((0, 'n'),)
        layout = bare(by_id=by_id, nets={key: ports}, classes={key: 'wire'}, labels_of_net={key: {'SIG'}} if named else {},
                      max_layer_span=max_layer_span)
        layout._demote(depth, column, x_offset)
        return layout.classes[key]

    def test_short_named_net_is_wired_and_long_one_tunnelled(self):
        self.assertEqual(TUNNEL_SPAN[1], 800)
        self.assertEqual(self.net([2]), 'wire')             # 180 px
        self.assertEqual(self.net([7]), 'wire')             # 730 px
        self.assertEqual(self.net([8]), 'tunnel')           # 840 px

    def test_fan_out_lowers_the_distance(self):
        self.assertLess(TUNNEL_SPAN[3], TUNNEL_SPAN[1])
        self.assertEqual(self.net([6]), 'wire')             # 620 px, one consumer
        self.assertEqual(self.net([6, 6, 6]), 'tunnel')     # three consumers at 620 px (> TUNNEL_SPAN[3] = 500)

    def test_named_backward_net_keeps_its_tunnels(self):
        self.assertEqual(self.net([1], backward=True), 'tunnel')

    def test_unnamed_net_is_wired_up_to_twice_the_limit(self):
        self.assertEqual(UNNAMED_SPAN_FACTOR, 2)
        self.assertEqual(self.net([8], named=False), 'wire')      # 840 px, no label to read: wired
        self.assertEqual(self.net([15], named=False), 'tunnel')   # 1610 px > 1600

    def test_column_cap_still_applies(self):
        self.assertEqual(self.net([3], max_layer_span=2), 'tunnel')
        self.assertEqual(self.net([3, 3], named=False, max_layer_span=2), 'tunnel')


class TallLayersSplit(unittest.TestCase):
    def pack(self, n, ranked=False):
        by_id, layer = {'src': comp('src', 'Pin', 0, 0, [])}, {'src': 0}
        for i in range(n):
            by_id[f'p{i}'] = comp(f'p{i}', 'AND Gate', 0, 100 * (n - i), [], height=60)   # authored bottom-up
            layer[f'p{i}'] = 1
        pin_rank = {f'p{i}': i for i in range(n)} if ranked else {}
        layout = bare(by_id=by_id, row_gap=20, column_height=200, stagger=10, pin_rank=pin_rank)
        column, _offset = layout._pack_columns(layer)
        return column

    def test_a_layer_of_many_becomes_columns_in_the_authors_order(self):
        column = self.pack(10)
        self.assertEqual(column['src'], 0)
        self.assertEqual([column[f'p{i}'] for i in range(9, -1, -1)], [1, 1, 2, 2, 3, 3, 4, 4, 5, 5])

    def test_a_short_layer_stays_one_column(self):
        column = self.pack(5)
        self.assertEqual({column[f'p{i}'] for i in range(5)}, {1})

    def test_the_pins_of_a_split_layer_stay_one_column(self):
        by_id, layer = {'src': comp('src', 'AND Gate', 0, 0, [])}, {'src': 0}
        for i in range(10):
            by_id[f'p{i}'] = comp(f'p{i}', 'AND Gate' if i < 4 else 'Pin', 0, 100 * i, [], height=60)
            layer[f'p{i}'] = 1
        layout = bare(by_id=by_id, row_gap=20, column_height=200, stagger=10, pin_rank={})
        column, _offset = layout._pack_columns(layer)
        self.assertEqual(len({column[f'p{i}'] for i in range(4, 10)}), 1)
        self.assertEqual([column[f'p{i}'] for i in range(4)], [2, 2, 3, 3])

    def test_ordered_pins_stay_one_column(self):
        column = self.pack(10, ranked=True)
        self.assertEqual({column[f'p{i}'] for i in range(10)}, {1})


class SplitterCopies(unittest.TestCase):
    def layout(self):
        # bus b -> Splitters s1 (beside part p) and s2 (beside part q); bit 0 of
        # both copies is net n, which p and q consume
        by_id = {
            's1': comp('s1', 'Splitter', 100, 100, [(0, 0, 'inout', 'b'), (10, 10, 'inout', 'n')]),
            's2': comp('s2', 'Splitter', 100, 500, [(0, 0, 'inout', 'b'), (10, 10, 'inout', 'n')]),
            'p': comp('p', 'AND Gate', 200, 100, [(0, 10, 'input', 'n')]),
            'q': comp('q', 'AND Gate', 200, 500, [(0, 10, 'input', 'n')]),
            'r': comp('r', 'Pin', 0, 300, [(0, 0, 'output', 'b')]),
        }
        nets = {((0, 'b'),): [('s1', 0), ('s2', 0), ('r', 0)], ((0, 'n'),): [('s1', 1), ('s2', 1), ('p', 0), ('q', 0)]}
        return bare(by_id=by_id, nets=nets, classes={k: 'wire' for k in nets}, tunnels={}, body_ids=set(by_id))

    def test_each_port_is_served_by_the_copy_beside_it(self):
        copies = self.layout()._splitter_copies()
        self.assertEqual(copies, {((0, 'n'),): [(('s1', 1), [('p', 0)]), (('s2', 1), [('q', 0)])]})

    def test_every_bit_of_a_bus_comes_from_the_same_copy(self):
        # two bits; the author drew s1 by q and s2 by p, so each part is fed
        # all its bits by the copy beside it
        by_id = {
            's1': comp('s1', 'Splitter', 100, 480, [(0, 0, 'inout', 'b'), (10, 10, 'inout', 'n'), (10, 20, 'inout', 'm')]),
            's2': comp('s2', 'Splitter', 100, 120, [(0, 0, 'inout', 'b'), (10, 10, 'inout', 'n'), (10, 20, 'inout', 'm')]),
            'p': comp('p', 'AND Gate', 200, 100, [(0, 10, 'input', 'n'), (0, 30, 'input', 'm')]),
            'q': comp('q', 'AND Gate', 200, 500, [(0, 10, 'input', 'n'), (0, 30, 'input', 'm')]),
            'r': comp('r', 'Pin', 0, 300, [(0, 0, 'output', 'b')]),
        }
        nets = {((0, 'b'),): [('s1', 0), ('s2', 0), ('r', 0)],
                ((0, 'n'),): [('s1', 1), ('s2', 1), ('p', 0), ('q', 0)],
                ((0, 'm'),): [('s1', 2), ('s2', 2), ('p', 1), ('q', 1)]}
        layout = bare(by_id=by_id, nets=nets, classes={k: 'wire' for k in nets}, tunnels={}, body_ids=set(by_id))
        copies = layout._splitter_copies()
        self.assertEqual(copies[((0, 'n'),)], [(('s1', 1), [('q', 0)]), (('s2', 1), [('p', 0)])])
        self.assertEqual(copies[((0, 'm'),)], [(('s1', 2), [('q', 1)]), (('s2', 2), [('p', 1)])])

    def test_a_constant_bus_does_not_connect_its_copies(self):
        layout = self.layout()
        layout.classes[((0, 'b'),)] = 'constant'
        self.assertEqual(layout._splitter_copies(), {})


class CrossingHeavyNets(unittest.TestCase):
    """A driver d feeding c1 and c2 along one row, crossed by seven vertical
    wires of another net: 7 crossings for 2 consumers."""

    def layout(self, label=None, crossers=7):
        by_id = {'d': comp('d', 'AND Gate', 0, 0, [(40, 20, 'output', 'n')], label=label),
                 'c1': comp('c1', 'OR Gate', 500, 0, [(0, 20, 'input', 'n')]),
                 'c2': comp('c2', 'OR Gate', 900, 0, [(0, 20, 'input', 'n')]),
                 'v': comp('v', 'NOT Gate', 0, 0, [(0, 0, 'output', 'm')]),
                 'w': comp('w', 'NOT Gate', 0, 0, [(0, 0, 'input', 'm')])}
        n, m = ((0, 'n'),), ((0, 'm'),)
        routed = [(((40, 20), (500, 20)), n), (((500, 20), (900, 20)), n)]
        routed += [(((100 + 100 * i, -100), (100 + 100 * i, 100)), m) for i in range(crossers)]
        return bare(by_id=by_id, nets={n: [('d', 0), ('c1', 0), ('c2', 0)], m: [('v', 0), ('w', 0)]},
                    classes={n: 'wire', m: 'wire'}, tunnels={}, body_ids=set(by_id), labels_of_net={}, routed=routed), n

    def test_a_named_net_that_crosses_much_becomes_tunnels(self):
        layout, n = self.layout(label='ALU')
        self.assertEqual(layout._crossing_heavy(), {n})

    def test_a_net_without_a_name_stays_wired(self):
        layout, _n = self.layout()
        self.assertEqual(layout._crossing_heavy(), set())

    def test_a_few_crossings_per_consumer_are_fine(self):
        layout, _n = self.layout(label='ALU', crossers=4)
        self.assertEqual(layout._crossing_heavy(), set())


class ContactGroups(unittest.TestCase):
    def layout(self):
        # a decoder's three outputs sit on a Splitter's three inputs; a gate
        # touches the decoder on one port only
        dec = comp('dec', 'Decoder', 100, 0, [(0, 20, 'input', 'a'), (10, 40, 'output', 'o1'), (20, 40, 'output', 'o2'), (30, 40, 'output', 'o3')],
                   width=40, height=40)
        spl = comp('spl', 'Splitter', 110, 40, [(30, 10, 'inout', 'b'), (0, 0, 'inout', 'o1'), (10, 0, 'inout', 'o2'), (20, 0, 'inout', 'o3')],
                   width=30, height=10)
        gate = comp('gate', 'NOT Gate', 60, 0, [(0, 20, 'input', 'x'), (40, 20, 'output', 'a')])
        body = [dec, spl, gate]
        return bare(by_id={c['componentId']: c for c in body}, body=body)

    def test_parts_sharing_ports_move_with_the_largest(self):
        self.assertEqual(self.layout()._contact_groups(), {'spl': 'dec'})


class Abutment(unittest.TestCase):
    def layout(self, clash=False):
        # a decoder's outputs 10 px apart on its bottom edge; a Splitter
        # elsewhere whose bit ends have the same spacing
        dec = comp('dec', 'Decoder', 100, 0, [(10, 40, 'output', 'o1'), (20, 40, 'output', 'o2'), (30, 40, 'output', 'o3'),
                                              (40, 40, 'output', 'x' if clash else 'o4')], width=60, height=40)
        spl = comp('spl', 'Splitter', 400, 300, [(0, 10, 'inout', 'b'), (10, 0, 'inout', 'o1'), (20, 0, 'inout', 'o2'),
                                                 (30, 0, 'inout', 'o3'), (40, 0, 'inout', 'o4')], width=50, height=10)
        body = [dec, spl]
        nets = {}
        for c in body:
            for e in c['ends']:
                nets.setdefault(((0, e['netBits'][0]['netId']),), []).append((c['componentId'], e['index']))
        return bare(by_id={c['componentId']: c for c in body}, body=body, body_ids={'dec', 'spl'}, tunnels={}, fused={},
                    nets=nets, classes={k: 'wire' for k in nets})

    def test_the_splitter_moves_onto_the_ports_it_is_wired_to(self):
        self.assertEqual(self.layout()._abutments(), {'spl': ('dec', (100 + 10 - 410, 40 - 300))})

    def test_never_onto_a_port_of_another_net(self):
        self.assertEqual(self.layout(clash=True)._abutments(), {})

    def test_each_copy_of_a_split_bus_docks_on_the_part_it_serves(self):
        # a bus split again beside each of two parts: every bit net joins both
        # Splitters and both parts, and each copy serves the part by it
        body, nets, copies = [], {}, {}
        for n, x in ((1, 100), (2, 600)):
            body.append(comp(f'p{n}', 'Decoder', x, 0, [(10 * k, 40, 'input', f'b{k}') for k in range(1, 5)], width=60, height=40))
            body.append(comp(f's{n}', 'Splitter', x + 300, 300, [(0, 10, 'inout', 'bus')] + [(10 * k, 0, 'inout', f'b{k}') for k in range(1, 5)],
                             width=50, height=10))
        for c in body:
            for e in c['ends']:
                nets.setdefault(((0, e['netBits'][0]['netId']),), []).append((c['componentId'], e['index']))
        for k in range(1, 5):
            key = ((0, f'b{k}'),)
            copies[key] = [(('s1', k), [('p1', k - 1)]), (('s2', k), [('p2', k - 1)])]
        layout = bare(by_id={c['componentId']: c for c in body}, body=body, body_ids={c['componentId'] for c in body}, tunnels={}, fused={},
                      nets=nets, classes={k: 'wire' for k in nets}, copies=copies)
        self.assertEqual(layout._abutments(), {'s1': ('p1', (110 - 410, 40 - 300)), 's2': ('p2', (610 - 910, 40 - 300))})

    def two_parts(self, host_edge, part_edge):
        # a display with four inputs 10 px apart on one edge, and the driver
        # that feeds them elsewhere, its four outputs 10 px apart
        at = {'south': lambda k: (10 * k, 60), 'west': lambda k: (0, 10 * k), 'north': lambda k: (10 * k, 0), 'east': lambda k: (40, 10 * k)}
        disp = comp('disp', 'DotMatrix', 100, 0, [(*at[host_edge](k), 'input', f'd{k}') for k in range(1, 5)], width=80, height=60)
        drv = comp('drv', 'Driver', 400, 300, [(*at[part_edge](k), 'output', f'd{k}') for k in range(1, 5)], width=40, height=50)
        nets = {}
        for c in (disp, drv):
            for e in c['ends']:
                nets.setdefault(((0, e['netBits'][0]['netId']),), []).append((c['componentId'], e['index']))
        return bare(by_id={'disp': disp, 'drv': drv}, body=[disp, drv], body_ids={'disp', 'drv'}, tunnels={}, fused={},
                    nets=nets, classes={k: 'wire' for k in nets})

    def test_a_driver_docks_under_the_display_it_feeds(self):
        self.assertEqual(self.two_parts('south', 'north')._abutments(), {'drv': ('disp', (110 - 410, 60 - 300))})

    def test_two_parts_side_by_side_stay_apart(self):
        # the flow lines up east-west connections with straight wires anyway
        self.assertEqual(self.two_parts('west', 'east')._abutments(), {})

    def test_a_bit_end_on_the_corner_is_on_the_edge_too(self):
        # two Splitters face to face (a bus split and joined again); the
        # larger one's last bit end is the bottom-right corner of its box
        big = comp('big', 'Splitter', 100, 0, [(0, 10, 'inout', 'B'), (30, 20, 'inout', 'o1'), (40, 20, 'inout', 'o2'),
                                               (50, 20, 'inout', 'o3'), (60, 20, 'inout', 'o4')], width=60, height=20)
        small = comp('small', 'Splitter', 400, 300, [(0, 10, 'inout', 'b'), (10, 0, 'inout', 'o1'), (20, 0, 'inout', 'o2'),
                                                     (30, 0, 'inout', 'o3'), (40, 0, 'inout', 'o4')], width=50, height=10)
        nets = {}
        for c in (big, small):
            for e in c['ends']:
                nets.setdefault(((0, e['netBits'][0]['netId']),), []).append((c['componentId'], e['index']))
        layout = bare(by_id={'big': big, 'small': small}, body=[big, small], body_ids={'big', 'small'}, tunnels={}, fused={},
                      nets=nets, classes={k: 'wire' for k in nets})
        self.assertEqual(layout._abutments(), {'small': ('big', (130 - 410, 20 - 300))})


class Satellites(unittest.TestCase):
    def test_pins_facing_north_stand_below_their_ports_in_a_row(self):
        rf = comp('rf', 'RegisterFile', 100, 0, [(20, 100, 'input', 'a'), (40, 100, 'input', 'b'), (60, 100, 'input', 'c')], width=100, height=100)
        pins = [comp(n, 'Pin', x, 500, [(10, 0, 'output', n)], width=20, height=20) for n, x in (('a', 0), ('b', 300), ('c', 600))]
        for p in pins:
            p['attributes'].append({'name': 'facing', 'standard': 'north'})
        body = [rf] + pins
        nets = {((0, n),): [('rf', i), (n, 0)] for i, n in enumerate('abc')}
        layout = bare(by_id={c['componentId']: c for c in body}, body=body, body_ids={c['componentId'] for c in body}, tunnels={},
                      fused={}, nets=nets, classes={k: 'wire' for k in nets})
        out = layout._satellites()
        ports = {n: (p['location']['x'] + p['ends'][0]['location']['x'] - p['location']['x'] + out[n][1][0],
                     p['ends'][0]['location']['y'] + out[n][1][1]) for n, p in zip('abc', pins)}
        self.assertEqual({n: host for n, (host, _off) in out.items()}, {'a': 'rf', 'b': 'rf', 'c': 'rf'})
        self.assertEqual(ports['a'], (120, 130))                     # right below its port, SATELLITE_GAP down
        self.assertTrue(ports['a'][0] < ports['b'][0] < ports['c'][0])
        self.assertTrue(all(y == 130 for _x, y in ports.values()))
        self.assertGreaterEqual(ports['b'][0] - ports['a'][0], 20 + 10)   # a Pin's width plus a grid step apart


class FooterWraps(unittest.TestCase):
    def test_the_footer_wraps_at_the_body_edge(self):
        layout = bare(footer={'x': 100, 'y': 1000, 'row': 0, 'right': 400})
        slots = [layout._footer_slot(100, 20) for _ in range(4)]
        self.assertEqual(slots[:2], [(100, 1000), (240, 1000)])
        self.assertEqual(slots[2], (100, 1040))                  # 380 + 100 > 400: next row
        self.assertTrue(all(x + 100 <= 400 or x == 100 for x, y in slots))


class Channels(unittest.TestCase):
    def test_every_net_spanning_a_channel_widens_it_once(self):
        channel = bare()._channels({'d': 0, 'f1': 1, 'c': 2, 'e': 2}, [[('d', 0), ('c', 0), ('e', 0)]])
        self.assertEqual([channel(l) for l in range(2)], [70, 70])      # 60 + 8, on the grid; two consumers count once
        self.assertEqual(channel(2), CHANNEL_MIN)
        wide = bare()._channels({f'd{i}': 0 for i in range(30)} | {'c': 1}, [[(f'd{i}', 0), ('c', i)] for i in range(30)])
        self.assertEqual(wide(0), COLUMN_GAP)                # never wider than the column gap


class Balance(unittest.TestCase):
    """Right to left, a part moves up to just before its nearest consumer when
    that shortens its wires; the "even" rule also moves parts whose wires only
    stay as long (_arrange draws both and keeps the cheaper drawing)."""

    def run_balance(self, factories, forward, depth, balance='chains'):
        layout = bare(by_id={cid: comp(cid, f, 0, 0, []) for cid, f in factories.items()}, balance=balance, even_moves=0)
        depth = dict(depth)
        layout._balance(depth, {u: set(vs) for u, vs in forward.items()})
        return depth

    CHAIN = {'a': {'b'}, 'b': {'c'}, 'c': {'d'}, 'd': {'e'}}
    DEPTH = {'a': 0, 'b': 1, 'c': 2, 'd': 3, 'e': 4}

    def test_a_source_moves_next_to_its_consumer(self):
        parts = {c: 'AND Gate' for c in 'abcdes'}
        depth = self.run_balance(parts, {**self.CHAIN, 's': {'e'}}, {**self.DEPTH, 's': 0})
        self.assertEqual(depth['s'], 3)
        self.assertEqual([depth[c] for c in 'abcde'], [0, 1, 2, 3, 4])

    def test_a_chain_follows_its_last_part(self):
        parts = {c: 'AND Gate' for c in 'abcdetu'}
        depth = self.run_balance(parts, {**self.CHAIN, 't': {'u'}, 'u': {'e'}}, {**self.DEPTH, 't': 0, 'u': 1})
        self.assertEqual((depth['t'], depth['u']), (2, 3))

    def test_a_link_whose_producer_cannot_follow_moves_only_when_even(self):
        parts = {c: 'AND Gate' for c in 'abcdem'}
        forward = {**self.CHAIN, 'a': {'b', 'm'}, 'm': {'e'}}      # a also feeds b: it cannot follow m
        depth = {**self.DEPTH, 'm': 1}
        self.assertEqual(self.run_balance(parts, forward, depth)['m'], 1)
        self.assertEqual(self.run_balance(parts, forward, depth, 'even')['m'], 3)

    def test_input_pins_and_parts_with_more_producers_stay(self):
        parts = {**{c: 'AND Gate' for c in 'abcdex'}, 'p': 'Pin', 'q': 'Pin'}
        depth = self.run_balance(parts, {**self.CHAIN, 'p': {'e'}, 'q': {'x'}, 'a': {'b', 'x'}, 'x': {'e'}},
                                 {**self.DEPTH, 'p': 0, 'q': 0, 'x': 1})
        self.assertEqual(depth['p'], 0)
        self.assertEqual(depth['x'], 1)                      # two producers (a, q), one consumer


class StaggeredLeads(unittest.TestCase):
    """Tunnels on inputs 10 px apart: every other lead grows until its flag
    clears the flags beside it, so no two flags lie on top of each other."""

    class Router:
        blocked, port_owners = set(), {}

        @staticmethod
        def owner(bits):
            return tuple(b['netId'] for b in bits)

    def test_every_other_flag_stands_a_label_further_out(self):
        part = comp('m', 'Multiplexer', 100, 0, [(0, 10 * k, 'input', f'n{k}') for k in range(1, 5)], width=40, height=60)
        layout = bare(by_id={'m': part}, layer={'m': 0}, anchors={('m', k): ['abc'] for k in range(4)})
        steps = layout._lead_steps({'m': part}, self.Router())
        # a flag 'abc' is 31 px long: the second one's tip stands 40 px out
        self.assertEqual([steps[('m', k)] for k in range(4)], [1, 4, 1, 4])


class TunnelLeads(unittest.TestCase):
    """emit() puts every Tunnel one grid cell off its port on a lead wire; the
    net is unchanged (checked by native re-observation)."""

    SRC = ('<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><lib desc="#Gates" name="1"/><main name="main"/>'
           '<circuit name="main">'
           '<comp lib="0" name="Pin" loc="(100,50)"><a name="facing" val="east"/><a name="label" val="A"/></comp>'
           '<comp lib="0" name="Tunnel" loc="(140,50)"><a name="facing" val="west"/><a name="label" val="A"/></comp>'
           '<wire from="(100,50)" to="(140,50)"/>'
           '<comp lib="0" name="Pin" loc="(100,80)"><a name="facing" val="east"/><a name="label" val="C"/></comp>'
           '<comp lib="0" name="Tunnel" loc="(140,80)"><a name="facing" val="west"/><a name="label" val="C"/></comp>'
           '<wire from="(100,80)" to="(140,80)"/>'
           '<comp lib="1" name="AND Gate" loc="(400,300)"><a name="size" val="30"/><a name="inputs" val="2"/></comp>'
           '<comp lib="0" name="Tunnel" loc="(370,290)"><a name="facing" val="east"/><a name="label" val="A"/></comp>'
           '<comp lib="0" name="Tunnel" loc="(370,310)"><a name="facing" val="east"/><a name="label" val="C"/></comp>'
           '<comp lib="0" name="Tunnel" loc="(400,300)"><a name="facing" val="west"/><a name="label" val="B"/></comp>'
           '<comp lib="1" name="NOT Gate" loc="(600,300)"><a name="size" val="30"/></comp>'
           '<comp lib="0" name="Tunnel" loc="(570,300)"><a name="facing" val="east"/><a name="label" val="B"/></comp>'
           '<comp lib="0" name="Pin" loc="(700,300)"><a name="facing" val="west"/><a name="output" val="true"/><a name="label" val="Y"/></comp>'
           '<wire from="(600,300)" to="(700,300)"/>'
           '</circuit></project>')

    @staticmethod
    def observe(w, path):
        return w.observer.run_full(path, 'main')['focus']

    def test_tunnels_sit_on_leads_and_nets_are_unchanged(self):
        from studio.application.workspace import Workspace
        with tempfile.TemporaryDirectory(prefix='vibe-leads-') as tmp:
            root = Path(tmp)
            src = root / 'leads.circ'
            src.write_text(self.SRC, encoding='utf-8')
            w = Workspace(REPO, root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'leads')
            try:
                w.open_path(src)
                before = self.observe(w, src)
                # Pins above y=100 are the fixed panel; the gates are the body
                after_xml = SchematicLayout(self.SRC, 'main', before, panel_below_y=100).emit()
                out = root / 'after.circ'
                out.write_text(after_xml, encoding='utf-8')
                after = self.observe(w, out)
            finally:
                w.close()
        ports = {(e['location']['x'], e['location']['y']) for c in after['components'] if c['factoryName'] != 'Tunnel' for e in c['ends']}
        tunnels = [c for c in after['components'] if c['factoryName'] == 'Tunnel']
        body_tunnels = [t for t in tunnels if t['location']['y'] >= 100]
        self.assertTrue(body_tunnels)
        for t in body_tunnels:
            self.assertNotIn((t['location']['x'], t['location']['y']), ports, 'a Tunnel stands on a port')
        # every tunnel-linked input still carries the same label's net
        def net(end):
            return tuple(sorted(b['netId'] for b in end.get('netBits') or []))
        and_gate = next(c for c in after['components'] if c['factoryName'] == 'AND Gate')
        nets_of_inputs = {net(e) for e in and_gate['ends'] if e['direction'] == 'input'}
        nets_of_tunnels = {net(t['ends'][0]) for t in body_tunnels}
        self.assertEqual(nets_of_inputs, nets_of_tunnels)
        pins = {_attr(c, 'label'): net(c['ends'][0]) for c in after['components'] if c['factoryName'] == 'Pin'}
        self.assertEqual(nets_of_inputs, {pins['A'], pins['C']})
        not_gate = next(c for c in after['components'] if c['factoryName'] == 'NOT Gate')
        self.assertEqual(pins['Y'], net(next(e for e in not_gate['ends'] if e['direction'] == 'output')))


def xml_pin(x, y, label, out=False):
    extra = '<a name="output" val="true"/>' if out else ''
    return (f'<comp lib="0" name="Pin" loc="({x},{y})"><a name="facing" val="{"west" if out else "east"}"/>{extra}'
            f'<a name="label" val="{label}"/></comp>' + xml_tunnel(x, y, label.lower(), 'east' if out else 'west'))


def xml_tunnel(x, y, label, facing):
    return f'<comp lib="0" name="Tunnel" loc="({x},{y})"><a name="facing" val="{facing}"/><a name="label" val="{label}"/></comp>'


def xml_gate(kind, x, y, inputs, output):
    two = len(inputs) == 2
    body = f'<comp lib="1" name="{kind}" loc="({x},{y})"><a name="size" val="30"/>' + ('<a name="inputs" val="2"/>' if two else '') + '</comp>'
    ys = (y - 10, y + 10) if two else (y,)
    return body + ''.join(xml_tunnel(x - 30, yy, label, 'east') for yy, label in zip(ys, inputs)) + xml_tunnel(x, y, output, 'west')


class StraightChains(unittest.TestCase):
    """Two chains AND -> NOT -> OR -> output Pin, drawn with Tunnels only and
    the parts scattered: after the layout every wire of a chain is one
    horizontal segment (output port level with the input it feeds, the
    output Pins included and still in their order), every part is on the
    grid, and the nets are unchanged (native re-observation)."""

    SRC = ('<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><lib desc="#Gates" name="1"/><main name="main"/>'
           '<circuit name="main">'
           + xml_pin(100, 100, 'A') + xml_pin(100, 200, 'B') + xml_pin(100, 300, 'S')
           + xml_gate('AND Gate', 400, 900, ['a', 'b'], 'p1') + xml_gate('NOT Gate', 600, 700, ['p1'], 'q1') + xml_gate('OR Gate', 800, 500, ['q1', 's'], 'y1')
           + xml_gate('AND Gate', 400, 500, ['b', 's'], 'p2') + xml_gate('NOT Gate', 600, 1100, ['p2'], 'q2') + xml_gate('OR Gate', 800, 1300, ['q2', 'a'], 'y2')
           + xml_pin(1000, 100, 'Y1', out=True) + xml_pin(1000, 200, 'Y2', out=True)
           + '</circuit></project>')
    CHAINS = [('AND Gate', 400, 900), ('NOT Gate', 600, 700), ('OR Gate', 800, 500), ('Pin', 1000, 100)], \
             [('AND Gate', 400, 500), ('NOT Gate', 600, 1100), ('OR Gate', 800, 1300), ('Pin', 1000, 200)]

    def test_chains_are_straight_on_the_grid_and_equivalent(self):
        from studio.application.workspace import Workspace
        with tempfile.TemporaryDirectory(prefix='vibe-chains-') as tmp:
            root = Path(tmp)
            src = root / 'chains.circ'
            src.write_text(self.SRC, encoding='utf-8')
            w = Workspace(REPO, root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'chains')
            try:
                w.open_path(src)
                before = w.observer.run_full(src, 'main')['focus']
                layout = SchematicLayout(self.SRC, 'main', before)
                out = root / 'after.circ'
                out.write_text(layout.emit(), encoding='utf-8')
                after = w.observer.run_full(out, 'main')['focus']
            finally:
                w.close()

        def moved(factory, x, y):
            return next(c for c in layout.moved.values() if c['factoryName'] == factory
                        and (c['location']['x'] - layout.placement[c['componentId']][0], c['location']['y'] - layout.placement[c['componentId']][1]) == (x, y))

        for chain in self.CHAINS:
            parts = [moved(*p) for p in chain]
            for a, b in zip(parts, parts[1:]):
                out_y = next(e['location']['y'] for e in a['ends'] if e['direction'] == 'output')
                in_ys = [e['location']['y'] for e in b['ends'] if e['direction'] == 'input']
                self.assertIn(out_y, in_ys, f"{a['factoryName']} -> {b['factoryName']} is not a straight wire")
        for c in layout.moved.values():
            if c['componentId'] in layout.layer:
                self.assertEqual((c['location']['x'] % 10, c['location']['y'] % 10), (0, 0), c['factoryName'])
        pins = {_attr(c, 'label'): c for c in after['components'] if c['factoryName'] == 'Pin'}
        self.assertLess(pins['Y1']['location']['y'], pins['Y2']['location']['y'], 'the output Pins changed order')

        def net(c, direction):
            return tuple(sorted(b['netId'] for e in c['ends'] if e['direction'] == direction for b in e.get('netBits') or []))
        ors = sorted((c for c in after['components'] if c['factoryName'] == 'OR Gate'), key=lambda c: c['location']['y'])
        self.assertEqual(net(ors[0], 'output'), net(pins['Y1'], 'input'))
        self.assertEqual(net(ors[1], 'output'), net(pins['Y2'], 'input'))


CPU_HEADER = ('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<project source="2.7.1" version="1.0">\n'
              '  <lib desc="#Wiring" name="0"/>\n  <lib desc="#Gates" name="1"/>\n  <lib desc="#Plexers" name="2"/>\n'
              '  <lib desc="#Arithmetic" name="3"/>\n  <lib desc="#Memory" name="4"/>\n  <main name="cpu"/>\n')


def cpu_subcircuit(name, ins, outs):
    body = ''.join(f'<comp lib="0" loc="(100,{100 + 40 * i})" name="Pin"><a name="width" val="{w}"/><a name="label" val="{n}"/></comp>'
                   for i, (n, w) in enumerate(ins))
    body += ''.join(f'<comp lib="0" loc="(400,{100 + 40 * i})" name="Pin"><a name="facing" val="west"/><a name="output" val="true"/>'
                    f'<a name="width" val="{w}"/><a name="label" val="{n}"/></comp>' for i, (n, w) in enumerate(outs))
    return f'  <circuit name="{name}">{body}</circuit>\n'


class ScatteredCpu(unittest.TestCase):
    """A single-cycle CPU drawn with Tunnels only and its parts scattered (the
    way a first draft comes out): after the layout the nets are unchanged
    (the production arrange_candidate proves it)."""

    # part -> (xml, {port: offset from loc}) ; offsets measured with the observer
    PARTS = {
        'PC': ('<comp lib="4" loc="({x},{y})" name="Register"><a name="width" val="8"/><a name="label" val="PC"/></comp>',
               {'Q': (0, 0), 'D': (-30, 0), 'clk': (-20, 20)}),
        'ROM': ('<comp lib="4" loc="({x},{y})" name="ROM"><a name="addrWidth" val="8"/><a name="dataWidth" val="8"/>'
                '<a name="contents">addr/data: 8 8\n0\n</a></comp>', {'D': (0, 0), 'A': (-140, 0)}),
        'ADD': ('<comp lib="3" loc="({x},{y})" name="Adder"><a name="width" val="8"/></comp>', {'A': (-40, -10), 'B': (-40, 10), 'S': (0, 0)}),
        'ONE': ('<comp lib="0" loc="({x},{y})" name="Constant"><a name="width" val="8"/></comp>', {'out': (0, 0)}),
        'NPC': ('<comp lib="2" loc="({x},{y})" name="Multiplexer"><a name="width" val="8"/></comp>',
                {'in0': (-30, -10), 'in1': (-30, 10), 'sel': (-20, 20), 'out': (0, 0)}),
        'RF': ('<comp loc="({x},{y})" name="RegFile"/>',
               {'RA': (-30, -20), 'RB': (-30, -10), 'RW': (-30, 0), 'D': (-30, 10), 'WE': (-30, 20), 'CLK': (-30, 30), 'A': (0, 0), 'B': (0, 10)}),
        'CU': ('<comp loc="({x},{y})" name="Controller"/>',
               {'INS': (-30, 20), 'WE': (0, 0), 'BSEL': (0, 10), 'JMP': (0, 20), 'OP': (0, 30), 'MSEL': (0, 40), 'STR': (0, 50)}),
        'BMUX': ('<comp lib="2" loc="({x},{y})" name="Multiplexer"><a name="width" val="8"/></comp>',
                 {'in0': (-30, -10), 'in1': (-30, 10), 'sel': (-20, 20), 'out': (0, 0)}),
        'ALU': ('<comp loc="({x},{y})" name="ALU"/>', {'X': (-30, -10), 'Y': (-30, 0), 'OP': (-30, 10), 'R': (0, 0)}),
        'RAM': ('<comp lib="4" loc="({x},{y})" name="RAM"><a name="addrWidth" val="8"/><a name="dataWidth" val="8"/><a name="bus" val="separate"/></comp>',
                {'Q': (0, 0), 'A': (-140, 0), 'Din': (-140, 20), 'str': (-110, 40), 'clk': (-70, 40)}),
        'WB': ('<comp lib="2" loc="({x},{y})" name="Multiplexer"><a name="width" val="8"/></comp>',
               {'in0': (-30, -10), 'in1': (-30, 10), 'sel': (-20, 20), 'out': (0, 0)}),
        'CLK': ('<comp lib="0" loc="({x},{y})" name="Clock"/>', {'out': (0, 0)}),
    }
    # scattered, the way a first draft places them
    AT = {'CLK': (100, 100), 'CU': (330, 150), 'RAM': (760, 300), 'WB': (800, 700), 'ALU': (1030, 200), 'BMUX': (1200, 500),
          'RF': (1430, 300), 'ROM': (560, 820), 'PC': (1600, 600), 'ADD': (240, 500), 'ONE': (120, 520), 'NPC': (900, 900)}
    NETS = {'pc': ['PC.Q', 'ROM.A', 'ADD.A'], 'one': ['ONE.out', 'ADD.B'], 'pc1': ['ADD.S', 'NPC.in0'], 'npc': ['NPC.out', 'PC.D'],
            'ins': ['ROM.D', 'CU.INS', 'RF.RA', 'RF.RB', 'RF.RW', 'BMUX.in1'], 'a': ['RF.A', 'ALU.X'], 'b': ['RF.B', 'BMUX.in0', 'RAM.Din'],
            'y': ['BMUX.out', 'ALU.Y'], 'r': ['ALU.R', 'RAM.A', 'WB.in0', 'NPC.in1'], 'm': ['RAM.Q', 'WB.in1'], 'wb': ['WB.out', 'RF.D'],
            'we': ['CU.WE', 'RF.WE'], 'bsel': ['CU.BSEL', 'BMUX.sel'], 'jmp': ['CU.JMP', 'NPC.sel'], 'op': ['CU.OP', 'ALU.OP'],
            'msel': ['CU.MSEL', 'WB.sel'], 'str': ['CU.STR', 'RAM.str'], 'clk': ['CLK.out', 'PC.clk', 'RF.CLK', 'RAM.clk']}
    WIDTH = {'jmp': 1, 'we': 1, 'bsel': 1, 'msel': 1, 'str': 1, 'clk': 1, 'op': 2}

    def source(self):
        body = ''
        for part, (xml, ports) in self.PARTS.items():
            x, y = self.AT[part]
            body += xml.format(x=x, y=y)
        for net, ends in self.NETS.items():
            for end in ends:
                part, port = end.split('.')
                x, y = self.AT[part]
                dx, dy = self.PARTS[part][1][port]
                facing = 'north' if dy >= 20 and part in ('NPC', 'BMUX', 'WB', 'RAM', 'PC') else ('west' if dx == 0 else 'east')
                body += (f'<comp lib="0" loc="({x + dx},{y + dy})" name="Tunnel"><a name="facing" val="{facing}"/>'
                         f'<a name="width" val="{self.WIDTH.get(net, 8)}"/><a name="label" val="{net}"/></comp>')
        subs = (cpu_subcircuit('RegFile', [('RA', 8), ('RB', 8), ('RW', 8), ('D', 8), ('WE', 1), ('CLK', 1)], [('A', 8), ('B', 8)])
                + cpu_subcircuit('ALU', [('X', 8), ('Y', 8), ('OP', 2)], [('R', 8)])
                + cpu_subcircuit('Controller', [('INS', 8)], [('WE', 1), ('BSEL', 1), ('JMP', 1), ('OP', 2), ('MSEL', 1), ('STR', 1)]))
        return CPU_HEADER + f'  <circuit name="cpu">{body}</circuit>\n' + subs + '</project>\n'

    def test_the_nets_are_unchanged(self):
        from studio.application.workspace import Workspace
        with tempfile.TemporaryDirectory(prefix='vibe-cpu-') as tmp:
            src = Path(tmp) / 'cpu.circ'
            src.write_text(self.source(), encoding='utf-8')
            w = Workspace(REPO, Path(tmp) / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'cpu')
            try:
                revision = w.open_path(src)['revision']['id']
                result = w.workbench.call(revision, 'arrange_candidate', {'circuit': 'cpu'})
                artifact = w.state_root / 'candidates' / result['id'] / 'artifact.circ'
                after = w.observer.run_full(artifact, 'cpu')['focus']
            finally:
                w.close()
        self.assertTrue(result['netlist']['equivalent'])
        parts = sorted(xml.split(' name="', 1)[1].split('"', 1)[0] for xml, _ports in self.PARTS.values())
        self.assertEqual(sorted(c['factoryName'] for c in after['components'] if c['factoryName'] != 'Tunnel'), parts)


class PinsLevelWithTheirPorts(unittest.TestCase):
    """Output Pins wired one to one to the outputs of a subcircuit (10 px
    apart on the instance) stand level with those ports, one step further
    out each, so every such wire is straight; the pinout keeps its order and
    the nets are unchanged (the production arrange_candidate proves it)."""

    def test_the_outputs_of_a_subcircuit_fan_out_level(self):
        from studio.application.workspace import Workspace
        sub = cpu_subcircuit('Dec', [('I', 1)], [(f'O{i}', 1) for i in range(5)])
        header = CPU_HEADER.replace('<main name="cpu"/>', '<main name="main"/>')
        with tempfile.TemporaryDirectory(prefix='vibe-fan-') as tmp:
            probe = Path(tmp) / 'probe.circ'
            probe.write_text(header + '  <circuit name="main"><comp loc="(300,300)" name="Dec"/></circuit>\n' + sub + '</project>\n', encoding='utf-8')
            w = Workspace(REPO, Path(tmp) / 'probe-state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'fan-probe')
            try:
                w.open_path(probe)
                inst = next(c for c in w.observer.run_full(probe, 'main')['focus']['components'] if c['factoryName'] == 'Dec')
            finally:
                w.close()
            ports = [(e['location']['x'], e['location']['y'], e['direction']) for e in inst['ends']]
            outs = sorted((y, x) for x, y, d in ports if d == 'output')
            (ix, iy), = [(x, y) for x, y, d in ports if d == 'input']
            body = '<comp loc="(300,300)" name="Dec"/>' + xml_tunnel(ix, iy, 'i', 'east') + xml_pin(100, 600, 'I')
            for k, (y, x) in enumerate(outs):
                body += xml_tunnel(x, y, f'y{k}', 'west') + xml_pin(900, 100 + 60 * k, f'Y{k}', out=True)
            src = Path(tmp) / 'fan.circ'
            src.write_text(header + f'  <circuit name="main">{body}</circuit>\n' + sub + '</project>\n', encoding='utf-8')
            w = Workspace(REPO, Path(tmp) / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'fan')
            try:
                revision = w.open_path(src)['revision']['id']
                result = w.workbench.call(revision, 'arrange_candidate', {'circuit': 'main'})
                after = w.observer.run_full(w.state_root / 'candidates' / result['id'] / 'artifact.circ', 'main')['focus']
            finally:
                w.close()
        self.assertTrue(result['netlist']['equivalent'])
        inst = next(c for c in after['components'] if c['factoryName'] == 'Dec')
        port_of_net = {tuple(b['netId'] for b in e['netBits']): e['location'] for e in inst['ends'] if e['direction'] == 'output'}
        pins = sorted((c for c in after['components'] if c['factoryName'] == 'Pin' and _attr(c, 'label') != 'I'), key=lambda c: _attr(c, 'label'))
        for pin in pins:
            port = port_of_net[tuple(b['netId'] for b in pin['ends'][0]['netBits'])]
            self.assertEqual(pin['ends'][0]['location']['y'], port['y'], f"{_attr(pin, 'label')} is not level with its port")
        ys = [pin['location']['y'] for pin in pins]
        self.assertEqual(ys, sorted(ys), 'the output Pins changed order')


if __name__ == '__main__':
    unittest.main()
