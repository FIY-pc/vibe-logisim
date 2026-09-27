"""Drawing conventions arrange_candidate encodes (measured on 233 hand-drawn
HUST CPUs, 2026-09-25):

  - Wire vs Tunnel is decided by driver->consumer distance in px (TUNNEL_SPAN
    by fan-out); a named backward net keeps its Tunnels; an unnamed net has
    no label to read and is wired up to twice the limit.
  - A Tunnel never stands on the port itself: one grid cell off it, on a lead
    wire (6 % of 22.7k corpus tunnels sit on the port; humans draw a lead).
  - Pipeline-register subcircuits are recognised by name (IF/ID, 气泡EX/MEM,
    ◇MEM/WB, 流水IF ...) and belong to the stage they feed.
  - _compact merges single-part layers leftwards except into or out of a
    register layer, so a stage boundary keeps its own column.
  - A routing channel is sized by the wired nets that span it, once per net.
  - Without pipeline stages, a part moves right towards its consumers when
    that shortens its wires, so an extender or a constant chain stands beside
    the mux it feeds; input Pins stay at the left edge.
  - A chain of parts wired output to input across neighbouring columns is
    drawn straight, output Pins included (their order is the pinout).

No model. Shapes are synthesised; the lead and chain tests observe natively.
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


class CompactKeepsRegisterColumns(unittest.TestCase):
    LAYER = {'r1': 0, 'g1': 1, 'r2': 2, 'g2': 3, 'g3': 3}

    def test_single_part_layers_merge_leftwards_by_default(self):
        out = SchematicLayout._compact(dict(self.LAYER))
        self.assertEqual(out['r1'], out['g1'])
        self.assertEqual(out['g1'], out['r2'])

    def test_register_layers_stay_columns_of_their_own(self):
        out = SchematicLayout._compact(dict(self.LAYER), keep={0, 2})
        self.assertEqual((out['r1'], out['g1'], out['r2'], out['g2']), (0, 1, 2, 3))


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


if __name__ == '__main__':
    unittest.main()
