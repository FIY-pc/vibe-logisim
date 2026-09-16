"""Two copies of one definition, nested two levels, in one real native run."""
import sys
import tempfile
import unittest
from pathlib import Path

REPO=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(REPO/'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace

SYMBOL='''<appear><rect x="50" y="50" width="50" height="30" fill="none" stroke="#000000"/><circ-port x="46" y="56" width="8" height="8" pin="100,100"/><circ-port x="95" y="55" width="10" height="10" pin="300,100"/><circ-anchor x="46" y="46" width="8" height="8" facing="east"/></appear>'''
PINS='''<comp lib="0" name="Pin" loc="(100,100)"><a name="label" val="D"/><a name="tristate" val="false"/></comp><comp lib="0" name="Pin" loc="(300,100)"><a name="label" val="Q"/><a name="output" val="true"/></comp>'''

def fixture():
    return f'''<project source="2.7.1" version="1.0"><lib name="0" desc="#Wiring"/><main name="Root"/>
    <circuit name="Cell">{SYMBOL}{PINS}<wire from="(100,100)" to="(300,100)"/></circuit>
    <circuit name="Wrapper">{SYMBOL}{PINS}<comp name="Cell" loc="(170,90)"/><wire from="(100,100)" to="(170,100)"/><wire from="(220,100)" to="(300,100)"/></circuit>
    <circuit name="Root"><comp name="Wrapper" loc="(200,200)"><a name="label" val="LEFT"/></comp><comp name="Wrapper" loc="(600,200)"><a name="label" val="RIGHT"/></comp>
    <comp lib="0" name="Pin" loc="(100,210)"><a name="label" val="A"/><a name="tristate" val="false"/></comp><comp lib="0" name="Pin" loc="(500,210)"><a name="label" val="B"/><a name="tristate" val="false"/></comp>
    <wire from="(100,210)" to="(200,210)"/><wire from="(500,210)" to="(600,210)"/></circuit></project>'''

class InstanceNavigation(unittest.TestCase):
    def test_live_paths_controls_reset_and_immutable_observation(self):
        with tempfile.TemporaryDirectory(prefix='vibe-instances-') as tmp:
            root=Path(tmp);source=root/'pair.circ';source.write_text(fixture());original=source.read_bytes()
            w=Workspace(REPO,root/'state',REPO/'apps/desktop/circuit-lens/lensctl.py','instances')
            try:
                w.application.open_path(source);revision=w.revision_id
                def act(action,**values):
                    status=w.simulation.status()
                    return w.application.simulation_action({'projectId':w.history.record['id'],'revisionId':w.revision_id,
                        'sessionId':status['session']['id'] if status['session'] else None,'viewId':status['view']['id'] if status['view'] else None,
                        'action':action,**values})
                def sample():return w.simulation.wait_frame(w.simulation.controls['commandSequence'])
                def pin(frame,label):return next(c for c in frame['components'] if c['label']==label and c['factory']=='Pin')
                started=act('start',circuit='Root');session=started['session']['id']
                act('input',componentId=pin(sample(),'A')['componentId'],value='1');sample()
                act('input',componentId=pin(sample(),'B')['componentId'],value='0');parent=sample()
                wrappers=w.circuit_view('Root')['circuit']['components'];cell=next(c for c in w.circuit_view('Wrapper')['circuit']['components'] if c['factory']=='Cell')
                def path(label):return [{'componentId':next(c for c in wrappers if c['label']==label)['componentId']},{'componentId':cell['componentId']}]
                left=act('view',instancePath=path('LEFT'))['observation'];self.assertEqual(pin(left,'Q')['ports'][0]['value'],1)
                self.assertEqual(left['ticks'],parent['ticks']);self.assertEqual(left['sessionId'],session)
                self.assertEqual(pin(left,'D')['control'],'parent-input')
                with self.assertRaises(ValueError):act('input',componentId=pin(left,'D')['componentId'],value='0')
                right=act('view',instancePath=path('RIGHT'))['observation'];self.assertEqual(pin(right,'Q')['ports'][0]['value'],0)
                self.assertEqual(pin(left,'Q')['componentId'],pin(right,'Q')['componentId'])
                self.assertNotEqual(left['instancePath'],right['instancePath'])
                inspected=w.workbench.call(revision,'inspect_circuit',{'circuit':'Cell'},observation_id=left['id'])
                self.assertEqual(inspected['displayedSimulation']['instancePath'],left['instancePath'])
                self.assertEqual(pin(inspected['displayedSimulation'],'Q')['ports'][0]['value'],1)
                with self.assertRaisesRegex(ValueError,'视图已切换'):act('input',componentId=pin(right,'D')['componentId'],value='1',viewId=left['viewId'])
                with self.assertRaisesRegex(ValueError,'路径已失效'):act('view',instancePath=[{'componentId':'missing'}])
                self.assertEqual(w.simulation.status()['view']['id'],right['viewId'])
                act('tick');running=sample();self.assertEqual(running['ticks'],1)
                again=act('view',instancePath=path('LEFT'))['observation'];self.assertEqual(pin(again,'Q')['ports'][0]['value'],1)
                frozen=w.simulation.observation(revision,left['id'],'Cell');self.assertEqual(frozen['instancePath'],left['instancePath'])
                act('reset');reset=sample();self.assertEqual(reset['ticks'],0);self.assertEqual(reset['instancePath'],left['instancePath'])
                self.assertEqual(pin(reset,'Q')['ports'][0]['value'],0)
                back=act('view',instancePath=[])['observation'];self.assertEqual(back['circuit'],'Root');self.assertEqual(back['sessionId'],session)
                self.assertEqual(source.read_bytes(),original);self.assertEqual(w.revision_id,revision)
                act('stop');self.assertIsNone(w.simulation.status()['session'])
                # The existing RAM editor must operate on the selected copy,
                # not a root component with the same revision-local ID.
                ram_source=root/'memory-pair.circ'
                ram_xml=fixture().replace('<main name="Root"/>','<lib name="1" desc="#Memory"/><main name="Root"/>').replace('<circuit name="Cell">','<circuit name="Cell"><comp name="RAM" lib="1" loc="(500,300)"><a name="addrWidth" val="4"/><a name="dataWidth" val="8"/></comp>')
                ram_source.write_text(ram_xml);w.application.open_path(ram_source)
                wrappers=w.circuit_view('Root')['circuit']['components'];cell=next(c for c in w.circuit_view('Wrapper')['circuit']['components'] if c['factory']=='Cell')
                ram=next(c for c in w.circuit_view('Cell')['circuit']['components'] if c['factory']=='RAM')
                act('start',circuit='Root');act('view',instancePath=path('LEFT'))
                act('memory',componentId=ram['componentId'],offset=0,count=4);original_word=sample()['memory']['words'][0]['value']
                act('memory-write',componentId=ram['componentId'],offset=0,count=4,address=0,value='ab',expected=format(original_word,'x'))
                self.assertEqual(sample()['memory']['words'][0]['value'],0xab)
                act('view',instancePath=path('RIGHT'));act('memory',componentId=ram['componentId'],offset=0,count=4)
                self.assertEqual(sample()['memory']['words'][0]['value'],original_word)
                act('view',instancePath=path('LEFT'));act('memory',componentId=ram['componentId'],offset=0,count=4)
                self.assertEqual(sample()['memory']['words'][0]['value'],0xab)
                self.assertEqual(ram_source.read_text(),ram_xml)
            finally:w.close()

if __name__=='__main__':unittest.main()
