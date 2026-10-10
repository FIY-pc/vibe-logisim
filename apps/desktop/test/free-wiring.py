"""Native free-wire editing, persistence, and layout preservation on synthetic circuits."""
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace
from studio.project.arrangement import copper_preserved
from studio.project.organization import organization_context
from studio.domain.loose_wires import loose_wire_geometry, assert_floating_isolation
from studio.domain.schematic_layout import resolve_unknown_widths


def pin(x, y, label, output=False, width=1):
    return (f'<comp lib="0" name="Pin" loc="({x},{y})"><a name="label" val="{label}"/>'
            f'<a name="output" val="{str(output).lower()}"/><a name="width" val="{width}"/>'
            f'<a name="facing" val="{"west" if output else "east"}"/><a name="tristate" val="false"/></comp>')


def xml(body):
    return '<project source="2.7.1" version="1.0"><lib name="0" desc="#Wiring"/><main name="main"/><circuit name="main">' + body + '</circuit></project>'


def wires(points):
    return ''.join(f'<wire from="({a[0]},{a[1]})" to="({b[0]},{b[1]})"/>' for a, b in zip(points, points[1:]))


class FreeWiring(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='vibe-free-wires-')
        self.root = Path(self.tmp.name)
        self.source = self.root / 'example.circ'
        self.w = Workspace(REPO, self.root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'free-wires')

    def tearDown(self):
        self.w.close()
        self.tmp.cleanup()

    def open(self, body):
        self.source.write_text(xml(body))
        self.original = self.source.read_bytes()
        self.w.application.open_path(self.source)

    def action(self, name, **values):
        return self.w.application.project_action(name, dict(projectId=self.w.history.record['id'],
            revisionId=self.w.revision_id, circuit='main', **values))

    def wire(self, *points):
        return self.action('wire', points=[{'x': x, 'y': y} for x, y in points])

    def scene(self):
        return self.w.circuit_view('main')['circuit']

    def test_half_wire_survives_save_reopen_and_can_be_completed(self):
        self.open(pin(100,100,'A') + pin(400,100,'Q',True))
        self.wire((100,100),(200,100))
        half = self.w.revision_id
        self.assertEqual(self.source.read_bytes(), self.original)
        self.action('save')
        saved = self.source.read_bytes()
        self.w.close()
        self.w = Workspace(REPO, self.root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'free-wires')
        self.w.application.open_path(self.source)
        self.assertEqual(self.w.revision_id, half)
        self.wire((200,100),(400,100))
        components = self.scene()['components']
        self.assertEqual(components[0]['ends'][0]['netBits'], components[1]['ends'][0]['netBits'])
        self.action('undo')
        self.assertEqual(self.w.revision_id, half)
        self.assertEqual(self.source.read_bytes(), saved)

    def test_unknown_wire_acquires_width_from_either_end(self):
        self.open(pin(100,100,'A',width=4) + pin(400,100,'Q',True,width=4))
        self.wire((200,100),(300,100))
        self.wire((400,100),(300,100))
        self.wire((100,100),(200,100))
        components = self.scene()['components']
        self.assertEqual(len(components[0]['ends'][0]['netBits']), 4)
        self.assertEqual(components[0]['ends'][0]['netBits'], components[1]['ends'][0]['netBits'])
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_drawing_on_empty_canvas_closed_loop_and_undo(self):
        self.open('')
        self.wire((100,100),(200,100),(200,200),(100,200),(100,100))
        self.assertEqual(len(self.scene()['wires']), 4)
        before = self.w.revision_id
        self.wire((300,100),(300,150))
        self.action('undo')
        self.assertEqual(self.w.revision_id, before)
        self.assertEqual(len(self.scene()['wires']), 4)
        self.assertEqual(self.source.read_bytes(), self.original)
        before = self.w.observer.run_full(self.w.frozen_path, 'main')['focus']
        result = self.w.workbench.call(self.w.revision_id, 'arrange_candidate', {'circuit':'main'})
        artifact = self.w.state_root / 'candidates' / result['id'] / 'artifact.circ'
        after = self.w.observer.run_full(artifact, 'main')['focus']
        self.assertTrue(copper_preserved(before['wires'], after['wires']))

    def test_native_width_conflict_still_rejects_without_mutating_revision(self):
        self.open(pin(100,100,'A') + pin(400,100,'Q',True,width=4))
        self.wire((100,100),(200,100))
        before = self.w.revision_id
        with self.assertRaisesRegex(ValueError, '位宽'):
            self.wire((200,100),(400,100))
        self.assertEqual(self.w.revision_id, before)
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_probe_lead_can_be_drawn_before_its_width_is_known(self):
        self.open(pin(100,100,'A',width=8) + '<comp lib="0" name="Probe" loc="(300,100)"/>')
        self.wire((300,100),(200,100))
        self.wire((100,100),(200,100))
        focus = self.w.observer.run_full(self.w.frozen_path, 'main')['focus']
        resolve_unknown_widths(focus)
        probe = next(c for c in focus['components'] if c['factoryName'] == 'Probe')
        driver = next(c for c in focus['components'] if c['factoryName'] == 'Pin')
        self.assertEqual(probe['ends'][0]['netBits'], driver['ends'][0]['netBits'])
        self.assertEqual(len(probe['ends'][0]['netBits']), 8)

    def test_layout_isolation_uses_native_junctions_not_visual_crossings(self):
        self.open(wires([(100,100),(300,100)]))
        before = self.w.observer.run_full(self.w.frozen_path, 'main')['focus']
        candidate = self.root / 'candidate.circ'
        candidate.write_text(xml(wires([(100,100),(300,100)]) +
                                 pin(200,50,'A') + pin(200,150,'Q',True) + wires([(200,50),(200,150)])))
        crossing = self.w.observer.run_full(candidate, 'main')['focus']
        assert_floating_isolation(before, crossing)
        candidate.write_text(xml(wires([(100,100),(300,100)]) + pin(100,100,'A')))
        attached = self.w.observer.run_full(candidate, 'main')['focus']
        with self.assertRaisesRegex(ValueError, '独立导线'):
            assert_floating_isolation(before, attached)

    def test_manual_move_carries_attached_stub_and_leaves_drawing(self):
        self.open(pin(100,100,'A'))
        self.wire((100,100),(200,100),(200,150))
        self.wire((500,100),(600,100))
        component = self.scene()['components'][0]
        self.action('move', componentId=component['componentId'], x=100, y=200)
        required = [{'from':{'x':100,'y':200},'to':{'x':200,'y':200}},
                    {'from':{'x':200,'y':200},'to':{'x':200,'y':250}},
                    {'from':{'x':500,'y':100},'to':{'x':600,'y':100}}]
        self.assertTrue(copper_preserved(required, self.scene()['wires']))

    def test_arrange_keeps_stubs_and_floating_geometry_while_moving_other_parts(self):
        frame = [(700,100),(900,100),(900,250),(700,250),(700,100)]
        self.open(pin(100,100,'A') + pin(400,100,'Q',True) +
                  pin(100,350,'B') + pin(500,450,'R',True) +
                  wires([(100,100),(200,100),(400,100)]) + wires([(200,100),(200,180)]) +
                  wires([(100,350),(500,350),(500,450)]) + wires(frame) + wires([(800,400),(900,400)]))
        before = self.w.observer.run_full(self.w.frozen_path, 'main')['focus']
        required, anchors = loose_wire_geometry(before)
        self.assertEqual(len(anchors), 2)
        context = organization_context(self.w.frozen_path.read_text(), 'main', before, {})
        self.assertEqual(set(context['pinnedForLooseWires']), anchors)
        self.assertFalse(anchors & {c['componentId'] for c in context['components']})
        result = self.w.workbench.call(self.w.revision_id, 'arrange_candidate', {'circuit':'main'})
        artifact = self.w.state_root / 'candidates' / result['id'] / 'artifact.circ'
        after = self.w.observer.run_full(artifact, 'main')['focus']
        self.assertTrue(copper_preserved(required, after['wires']))
        assert_floating_isolation(before, after)
        self.assertTrue(result['arrangement']['moved'] > 0, result['arrangement'])
        self.assertEqual(result['arrangement']['preservedLooseWireSegments'], len(required))
        self.assertEqual(set(result['arrangement']['pinnedForLooseWires']), anchors)
        self.assertEqual(self.source.read_bytes(), self.original)


if __name__ == '__main__':
    unittest.main()
