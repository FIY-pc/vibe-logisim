"""Native interface edits through the same application boundary as the UI."""
import copy
import shutil
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

REPO=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(REPO/'apps/desktop/circuit-lens'))
sys.path.insert(0,str(REPO/'apps/desktop/test'))
from support.samples import skip_unless_samples
from studio.application.workspace import Workspace


class InterfaceEditing(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='vibe-interface-');self.root=Path(self.tmp.name)
        self.w=Workspace(REPO,self.root/'state',REPO/'apps/desktop/circuit-lens/lensctl.py','interface')
        self.source=self.root/'logic.circ'
        self.source.write_text('''<project source="2.7.1" version="1.0"><lib name="0" desc="#Wiring"/><main name="main"/>
        <circuit name="child"><comp name="Pin" lib="0" loc="(100,100)"><a name="label" val="a"/></comp><comp name="Pin" lib="0" loc="(300,100)"><a name="label" val="z"/><a name="output" val="true"/></comp><wire from="(100,100)" to="(300,100)"/></circuit>
        <circuit name="main"><comp name="child" loc="(200,200)"/><comp name="child" loc="(500,200)"><a name="facing" val="north"/></comp><comp name="child" loc="(200,500)"><a name="facing" val="west"/></comp><comp name="child" loc="(500,500)"><a name="facing" val="south"/></comp></circuit></project>''')
        self.w.application.open_path(self.source);self.name='child';self.original=self.source.read_bytes()
        # Wire each of the four orientations to independent external inputs
        # and outputs, using the actual initial native port locations.
        symbol=self.w.application.interfaces.read(self.ref())
        root=ET.fromstring(self.original);parent=root.find("circuit[@name='main']")
        pin_defs={p['id']:p for p in symbol['ports']}
        for i,use in enumerate(symbol['uses']):
            for pin,p in use['ports'].items():
                output=pin_defs[pin]['direction']=='output'
                dx,dy={'east':(80,0),'west':(-80,0),'north':(0,-80),'south':(0,80)}[use['facing']]
                if not output:dx,dy=-dx,-dy
                x,y=p['x']+dx,p['y']+dy
                comp=ET.SubElement(parent,'comp',{'name':'Pin','lib':'0','loc':f'({x},{y})'})
                ET.SubElement(comp,'a',name='output',val=str(output).lower());ET.SubElement(comp,'a',name='label',val=f'p{i}-{pin}')
                ET.SubElement(parent,'wire',{'from':f'({x},{y})','to':f"({p['x']},{p['y']})"})
        self.source=self.root/'connected.circ';self.source.write_bytes(ET.tostring(root));self.original=self.source.read_bytes();self.w.application.open_path(self.source)

    def tearDown(self):self.w.close();self.tmp.cleanup()
    def ref(self):return {'projectId':self.w.history.record['id'],'revisionId':self.w.revision_id,'circuit':self.name}
    def draft(self):
        s=self.w.application.interfaces.read(self.ref());return {k:copy.deepcopy(s[k]) for k in ('ports','shapes')}
    def apply(self,draft):return self.w.application.project_action('interface',{**self.ref(),'draft':draft})

    def test_default_symbol_all_orientations_and_stale_draft(self):
        before=self.ref();draft=self.draft();self.apply(draft)
        self.assertEqual(self.w.revision_id,before['revisionId'])
        draft['ports'][0]['x']-=20
        prepared=self.w.application.interfaces.prepare({**before,'draft':draft})
        self.assertEqual(self.w.revision_id,before['revisionId'])
        self.assertEqual(prepared['impacts'][1]['movedPorts'],4)
        self.w.application.project_action('interface',{**before,'draft':draft,'previewId':prepared['previewId']})
        self.assertNotEqual(self.w.revision_id,before['revisionId'])
        with self.assertRaises(ValueError):self.w.application.project_action('interface',{**before,'draft':draft,'previewId':prepared['previewId']})
        self.w.application.project_action('undo',self.ref());self.assertEqual(self.w.revision_id,before['revisionId'])
        self.assertEqual(self.source.read_bytes(),self.original)

    def test_connected_width_change_rejects_then_explicit_disconnect_and_delete(self):
        draft=self.draft();pin=draft['ports'][0];pin['width']=8
        before=self.w.revision_id
        with self.assertRaises(ValueError):self.apply(draft)
        self.assertEqual(self.w.revision_id,before)
        pin['disconnect']=True;self.apply(draft)
        scene=self.w.circuit_view(self.name)['circuit'];self.assertEqual(scene['wires'],[])
        draft=self.draft();draft['ports'].pop(0);self.apply(draft)
        self.assertEqual(len(self.w.application.interfaces.read(self.ref())['ports']),1)

    def test_add_rename_direction_and_duplicate_position(self):
        draft=self.draft();first=draft['ports'][0]
        draft['ports'].append({**first,'id':'new-port','label':'extra','direction':'output','width':8,'internalX':100,'internalY':300,'y':first['y']+100})
        self.apply(draft)
        draft=self.draft();extra=next(p for p in draft['ports'] if p['label']=='extra');extra['label']='RESET';extra['direction']='input';extra['width']=1;self.apply(draft)
        draft=self.draft();draft['ports'][1].update({k:draft['ports'][0][k] for k in ('x','y')})
        with self.assertRaisesRegex(ValueError,'同一位置'):self.apply(draft)

    def test_new_or_detached_pin_cannot_inherit_shared_wire(self):
        draft=self.draft();first=draft['ports'][0]
        draft['ports'].append({**first,'id':'new-on-wire','label':'middle','internalX':200,'internalY':100,'y':first['y']+100})
        before=self.w.revision_id
        with self.assertRaisesRegex(ValueError,'共享接点'):self.apply(draft)
        self.assertEqual(self.w.revision_id,before)
        root=ET.fromstring(self.original);child=root.find("circuit[@name='child']")
        comp=ET.SubElement(child,'comp',{'name':'Pin','lib':'0','loc':'(200,100)'})
        ET.SubElement(comp,'a',name='label',val='middle')
        source=self.root/'junction.circ';source.write_bytes(ET.tostring(root));self.w.application.open_path(source)
        draft=self.draft();next(p for p in draft['ports'] if p['label']=='middle')['disconnect']=True
        before=self.w.revision_id
        with self.assertRaisesRegex(ValueError,'共享接点'):self.apply(draft)
        self.assertEqual(self.w.revision_id,before)

    @skip_unless_samples(REPO, 'exports/layout-editing/stage6-if-id.circ', 'exports/layout-editing/cs3410.jar', 'exports/layout-editing/riscv-probe.jar')
    def test_course_parent_rewire_and_one_undo(self):
        for name in ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar']:shutil.copy(REPO/'exports/layout-editing'/name,self.root/name)
        self.source=self.root/'stage6-if-id.circ';self.original=self.source.read_bytes()
        self.w.application.open_path(self.source);self.name='IF_ID';before=self.ref();draft=self.draft()
        pin=next(p for p in draft['ports'] if p['label']=='ID.PC');pin['y']-=20;pin['label']='DECODE.PC'
        self.apply(draft)
        symbol=self.w.application.interfaces.read(self.ref());self.assertEqual(next(p for p in symbol['ports'] if p['label']=='DECODE.PC')['y'],110)
        self.w.application.project_action('undo',self.ref());self.assertEqual(self.w.revision_id,before['revisionId'])
        self.assertEqual(self.source.read_bytes(),self.original)


if __name__=='__main__':unittest.main()
