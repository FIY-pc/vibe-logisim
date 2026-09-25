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

No model. Shapes are synthesised; only the lead test observes natively.
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


if __name__ == '__main__':
    unittest.main()
