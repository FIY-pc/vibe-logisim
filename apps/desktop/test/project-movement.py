"""Native checks for topology patterns not all exercised by the course UI task."""
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
sys.path.insert(0, str(REPO / 'apps/desktop/test'))
from support.samples import skip_unless_samples
from studio.application.workspace import Workspace


class Movement(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='vibe-native-move-')
        self.root = Path(self.tmp.name)
        self.workspace = Workspace(REPO, self.root/'state', REPO/'apps/desktop/circuit-lens/lensctl.py', 'native-move')

    def tearDown(self):
        self.workspace.close()
        self.tmp.cleanup()

    def open(self, source, circuit):
        target = self.root/source.name
        shutil.copy(source, target)
        for dependency in source.parent.glob('*.jar'):
            shutil.copy(dependency, self.root/dependency.name)
        self.workspace.application.open_path(target)
        self.circuit = circuit
        self.source = target
        self.original = target.read_bytes()

    def action(self, name, **kwargs):
        w = self.workspace
        return w.application.project_action(name, {'projectId':w.history.record['id'], 'revisionId':w.revision_id, 'circuit':self.circuit, **kwargs})

    def scene(self):
        return self.workspace.workbench.inspect({'circuit':self.circuit})

    @skip_unless_samples(REPO, 'exports/if-id-collaboration/stage6-if-id.circ')
    def test_entire_course_module_moves_its_internal_wires_and_keeps_parent_interface(self):
        self.open(REPO/'exports/if-id-collaboration/stage6-if-id.circ','IF_ID')
        before = self.scene()
        components = before['components']
        anchor = components[0]  # Text labels may have an off-grid baseline.
        self.action('move',componentIds=[c['componentId'] for c in components],anchorId=anchor['componentId'],
                    x=anchor['location']['x']+40,y=anchor['location']['y']+20)
        expected = {(c['factory'],c['location']['x']+40,c['location']['y']+20) for c in components}
        self.assertEqual(expected,{(c['factory'],c['location']['x'],c['location']['y']) for c in self.scene()['components']})
        def wires(data):
            c=next(c for c in ET.fromstring(data).findall('circuit') if c.get('name')=='IF_ID')
            return {tuple(sorted(tuple(int(v) for v in w.get(k).strip('()').split(',')) for k in ('from','to'))) for w in c.findall('wire')}
        expected_wires={tuple(sorted((x+40,y+20) for x,y in edge)) for edge in wires(self.original)}
        self.assertEqual(expected_wires,wires(self.workspace.frozen_path.read_bytes()))
        old=ET.fromstring(self.original);new=ET.fromstring(self.workspace.frozen_path.read_bytes())
        for a,b in zip(old.findall('circuit'),new.findall('circuit')):
            if a.get('name')!='IF_ID':self.assertEqual(ET.tostring(a),ET.tostring(b))
        self.assertEqual(self.source.read_bytes(),self.original)

    @skip_unless_samples(REPO, 'archive/tooling/tmp/half_adder.circ')
    def test_fanout_port_move_and_failed_move_leave_the_design_usable(self):
        source=REPO/'archive/tooling/tmp/half_adder.circ'
        name=ET.parse(source).find('main').get('name')
        self.open(source,name)
        before=self.workspace.revision_id
        a=next(c for c in self.scene()['components'] if c['label']=='a')
        self.action('move',componentId=a['componentId'],x=a['location']['x'],y=a['location']['y']-40)
        self.assertNotEqual(self.workspace.revision_id,before)
        scene=self.scene()
        a=next(c for c in scene['components'] if c['label']=='a')
        b=next(c for c in scene['components'] if c['label']=='b')
        revision=self.workspace.revision_id
        with self.assertRaisesRegex(ValueError,'重叠'):
            self.action('move',componentId=a['componentId'],x=b['location']['x'],y=b['location']['y'])
        self.assertEqual(self.workspace.revision_id,revision)
        self.action('undo')
        self.assertEqual(self.workspace.revision_id,before)
        self.assertEqual(self.source.read_bytes(),self.original)

    def test_wire_branch_endpoints_preserve_other_signals_and_reject_accidental_junctions(self):
        # Two independent buses. The second path is a false shortcut through
        # the lower signal's endpoint; the native partition must reject it.
        source=self.root/'branches.circ'
        source.write_text('''<?xml version="1.0"?><project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/><circuit name="main">
        <comp lib="0" name="Pin" loc="(100,100)"><a name="label" val="a"/></comp>
        <comp lib="0" name="Pin" loc="(400,100)"><a name="output" val="true"/><a name="label" val="x"/></comp>
        <comp lib="0" name="Pin" loc="(100,200)"><a name="label" val="b"/></comp>
        <comp lib="0" name="Pin" loc="(400,200)"><a name="output" val="true"/><a name="label" val="y"/></comp>
        <wire from="(100,100)" to="(200,100)"/><wire from="(300,100)" to="(400,100)"/>
        <wire from="(100,200)" to="(400,200)"/></circuit></project>''')
        self.workspace.application.open_path(source);self.circuit='main'
        before=self.workspace.revision_id
        def path(points):return [{'x':x,'y':y} for x,y in points]
        with self.assertRaisesRegex(ValueError,'短接'):
            self.action('wire',points=path([(200,100),(200,200),(300,200),(300,100)]))
        self.assertEqual(self.workspace.revision_id,before)
        self.action('wire',points=path([(200,100),(200,60),(300,60),(300,100)]))
        cs={c['label']:c for c in self.scene()['components']}
        net=lambda label:cs[label]['ends'][0]['netBits'][0]['netId']
        self.assertEqual(net('a'),net('x'))
        self.assertEqual(net('b'),net('y'))
        self.assertNotEqual(net('a'),net('b'))


if __name__=='__main__':unittest.main()
