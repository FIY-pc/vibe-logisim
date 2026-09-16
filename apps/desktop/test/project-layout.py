"""Exercise native topology at drag boundaries; Electron covers the gestures."""
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO/'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace


class Layout(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='vibe-native-layout-')
        self.root = Path(self.tmp.name)
        self.w = Workspace(REPO, self.root/'state', REPO/'apps/desktop/circuit-lens/lensctl.py', 'layout')
        self.circuit = 'main'

    def tearDown(self):
        self.w.close()
        self.tmp.cleanup()

    def scene(self):
        return self.w.circuit_view(self.circuit)['circuit']

    def body(self, **extra):
        return {'projectId':self.w.history.record['id'], 'revisionId':self.w.revision_id, 'circuit':self.circuit, **extra}

    def action(self, name, **extra):
        return self.w.application.project_action(name, self.body(**extra))

    def fixture(self, branch=False):
        source = self.root/('branch.circ' if branch else 'bus.circ')
        branch_xml = '<comp lib="0" name="Pin" loc="(250,200)"><a name="output" val="true"/><a name="label" val="branch"/><a name="width" val="32"/></comp><wire from="(250,100)" to="(250,200)"/>' if branch else ''
        source.write_text('''<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/><circuit name="main">
        <comp lib="0" name="Pin" loc="(100,100)"><a name="width" val="32"/><a name="label" val="a"/></comp>
        <comp lib="0" name="Pin" loc="(400,100)"><a name="output" val="true"/><a name="width" val="32"/><a name="label" val="z"/></comp>
        <comp lib="0" name="Pin" loc="(100,300)"><a name="width" val="32"/><a name="label" val="b"/></comp>
        <comp lib="0" name="Pin" loc="(400,300)"><a name="output" val="true"/><a name="width" val="32"/><a name="label" val="y"/></comp>
        <wire from="(100,100)" to="(400,100)"/><wire from="(100,300)" to="(400,300)"/>''' + branch_xml + '</circuit></project>')
        self.w.application.open_path(source)
        self.source = source
        self.original = source.read_bytes()

    def test_slide_direct_bus_and_shared_branch_keeps_every_bit(self):
        for branch in (False, True):
            self.fixture(branch)
            scene = self.scene()
            wire = next(w for w in scene['wires'] if w['from']['y']==w['to']['y']==100)
            before = self.w.revision_id
            body = self.body(wireIds=[wire['wireId']],delta={'x':0,'y':-40})
            proposed = self.w.application.layout_preview(body)
            self.assertEqual(self.w.revision_id,before)
            self.w.application.project_action('move',body)
            loaded=self.scene()
            nets={c['label']:[b['netId'] for b in c['ends'][0]['netBits']] for c in loaded['components']}
            self.assertEqual(nets['a'],nets['z'])
            self.assertEqual(nets['b'],nets['y'])
            self.assertFalse(set(nets['a']) & set(nets['b']))
            if branch:self.assertEqual(nets['a'],nets['branch'])
            self.assertTrue(any(w['from']['y']==w['to']['y']==60 for w in loaded['wires']))
            # Logisim can merge collinear XML segments; compare retained requested
            # line, and native bits, rather than requiring source/native IDs equal.
            self.assertTrue(any(w['from']['y']==w['to']['y']==60 for w in proposed['segments']))
            self.assertEqual(self.source.read_bytes(),self.original)

    def test_mixed_move_and_delete_are_atomic_and_invalid_wire_cannot_delete_component(self):
        self.fixture()
        before=self.scene()
        component=next(c for c in before['components'] if c['label']=='a')
        wire=next(w for w in before['wires'] if w['from']['y']==100)
        self.action('move',componentIds=[component['componentId']],wireIds=[wire['wireId']],delta={'x':40,'y':-40})
        scene=self.scene();component=next(c for c in scene['components'] if c['label']=='a')
        self.assertEqual(component['location'],{'x':140,'y':60})
        wire=next(w for w in scene['wires'] if w['from']['y']==w['to']['y']==60)
        self.assertEqual({wire['from']['x'],wire['to']['x']},{140,440},'connector does not leave a dangling tail')
        revision=self.w.revision_id
        with self.assertRaises(ValueError):
            self.action('delete',componentIds=[component['componentId']],wireIds=['missing-wire'])
        self.assertEqual(self.w.revision_id,revision)
        self.action('delete',componentIds=[component['componentId']],wireIds=[wire['wireId']])
        after=self.scene()
        self.assertFalse(any(c['label']=='a' for c in after['components']))
        self.assertFalse(any(w['from']==wire['from'] and w['to']==wire['to'] for w in after['wires']))
        self.action('undo')
        self.assertEqual(self.w.revision_id,revision)
        self.assertEqual(self.source.read_bytes(),self.original)

    def test_foreign_signal_collision_rejects_without_publishing(self):
        self.fixture()
        wire=next(w for w in self.scene()['wires'] if w['from']['y']==100)
        before=self.w.revision_id
        with self.assertRaises(ValueError):
            self.action('move',wireIds=[wire['wireId']],delta={'x':0,'y':200})
        self.assertEqual(self.w.revision_id,before)
        self.assertEqual(self.source.read_bytes(),self.original)

    def test_floating_duplicate_native_wire_remains_one_selectable_segment(self):
        source=self.root/'floating.circ'
        source.write_text('''<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/><circuit name="main">
        <wire from="(100,100)" to="(200,100)"/><wire from="(100,100)" to="(200,100)"/></circuit></project>''')
        self.w.application.open_path(source)
        scene=self.scene();self.assertEqual(len(scene['wires']),1)
        self.action('move',wireIds=[scene['wires'][0]['wireId']],delta={'x':0,'y':40})
        moved=self.scene();self.assertEqual(len(moved['wires']),1)
        self.assertEqual(moved['wires'][0]['from']['y'],140)


if __name__=='__main__':unittest.main()
