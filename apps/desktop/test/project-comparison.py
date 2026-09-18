"""Review must distinguish rewiring from geometry and keep frozen ownership.

Port permutations/partial maps exercise failures that the UI circuit does not.
The service case loads the real course runtime on isolated half-adder files.
"""
import copy
from pathlib import Path
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0,str(REPO/'apps/desktop/circuit-lens'))
from studio.domain.connection_diff import compare_connections
from studio.application.workspace import Workspace
from studio.domain.errors import LensError
from studio.project.comparison import describe_changes


def component(name, nets):
    return {'componentId':name, 'factory':'Pin', 'label':name, 'location':{'x':0,'y':0},
            'ends':[{'index':0, 'width':len(nets), 'location':{'x':0,'y':0}, 'direction':'input',
                     'netBits':[{'bit':i,'netId':n} for i,n in enumerate(nets)]}]}


class PortPartitions(unittest.TestCase):
    def test_net_renumbering_and_geometry_do_not_mean_rewiring(self):
        a = [component('a',['n0','n1']),component('b',['n0','n1'])]
        b = [component('c',['r7','r9']),component('d',['r7','r9'])]
        b[0]['location']={'x':100,'y':200}
        self.assertEqual(compare_connections(a,b,[('a','c'),('b','d')])['status'],'unchanged')

    def test_crossed_bus_bits_are_detected_and_not_collapsed(self):
        a = [component('a',['n0','n1']),component('b',['n0','n1'])]
        b = [component('a',['n0','n1']),component('b',['n1','n0'])]
        result=compare_connections(a,b,[('a','a'),('b','b')])
        self.assertEqual(result['status'],'changed')
        after=result['rows'][0]['after']['connections']
        # Every displayed endpoint relationship must keep the crossed bit index.
        self.assertEqual({tuple((e['label'],tuple(e['bits'])) for e in group) for group in after},
                         {(('a',(0,)),('b',(1,))),(('a',(1,)),('b',(0,)))})

    def test_fanout_disconnection_groups_a_bus_without_losing_endpoints(self):
        nets=[f'n{i}' for i in range(32)]
        a=[component('a',nets),component('b',nets),component('c',nets)]
        b=copy.deepcopy(a);b[2]=component('c',[f'own{i}' for i in range(32)])
        result=compare_connections(a,b,[(c['componentId'],c['componentId']) for c in a])
        self.assertEqual(len(result['rows']),1)
        row=result['rows'][0];self.assertEqual(row['bitCount'],32)
        self.assertEqual({frozenset(e['label'] for e in g) for g in row['after']['connections']},
                         {frozenset(('a','b')),frozenset(('c',))})

    def test_missing_width_or_bit_map_is_unknown_and_port_contract_changes_are_visible(self):
        a=[component('a',['n']),component('b',['n'])]
        for damage in ('width','bits'):
            b=copy.deepcopy(a)
            if damage=='width':b[0]['ends'][0]['width']=0
            else:b[0]['ends'][0]['netBits']=[]
            result=compare_connections(a,b,[('a','a'),('b','b')])
            self.assertEqual(result['status'],'partial')
            self.assertEqual(result['unknownPorts'],1)
        b=copy.deepcopy(a);b[0]['ends'][0]['direction']='output'
        self.assertEqual(compare_connections(a,b,[('a','a'),('b','b')])['status'],'changed')

    def test_native_width_conflicts_cannot_be_reported_as_unchanged(self):
        circuit=ET.fromstring('<circuit name="main"/>')
        view={'components':[],'coverage':{'widthIncompatibilities':1}}
        self.assertEqual(describe_changes(circuit,circuit,view,view)['connectivity']['status'],'partial')


class FrozenReview(unittest.TestCase):
    def test_candidate_history_and_late_reads_stay_in_their_owned_snapshots(self):
        original=(REPO/'archive/tooling/tmp/half_adder.circ').read_bytes()
        with tempfile.TemporaryDirectory(prefix='vibe-comparison-service-') as temporary:
            root=Path(temporary);a=root/'a.circ';b=root/'b.circ'
            a.write_bytes(original);b.write_bytes(original)
            w=Workspace(REPO,root/'state',REPO/'apps/desktop/circuit-lens/lensctl.py','test')
            def binding():return {'projectId':w.history.record['id'],'revisionId':w.revision_id}
            try:
                w.application.open_path(a);initial=binding()
                candidate=w.application.agent_tool({**initial,'tool':'import_candidate','arguments':{
                    'circuitXml':original.decode().replace('val="sum"','val="result"'),'title':'Rename output'}})
                request={**initial,'kind':'candidate','id':candidate['id'],'circuit':'main'}
                result=w.comparison.describe(request)
                self.assertEqual(result['diff']['connectivity']['status'],'unchanged')
                self.assertEqual(result['diff']['counts'],{'interfaces':1})
                self.assertTrue(result['sides']['before']['current'])
                self.assertFalse(result['sides']['after']['current'])
                png=w.comparison.render({**request,'side':'before','x':0,'y':0,'width':200,'height':200,'scale':2})
                self.assertTrue(png.startswith(b'\x89PNG'))
                self.assertEqual(binding(),initial)
                self.assertEqual(w.frozen_path.read_bytes(),original)

                # A project can change while the native read is in flight.
                native=w.comparison._native; switched=False
                def delayed(snapshot,name):
                    nonlocal switched
                    value=native(snapshot,name)
                    if not switched: switched=True;w.application.open_path(b)
                    return value
                with patch.object(w.comparison,'_native',side_effect=delayed):
                    with self.assertRaises((ValueError,LensError)):w.comparison.describe(request)
                self.assertEqual(w.revision_id,initial['revisionId'])
                with self.assertRaises((ValueError,LensError)):
                    w.comparison.describe({**request,**binding()})
                with self.assertRaises((ValueError,LensError)):
                    w.comparison.render({**request,**binding(),'side':'after'})

                w.application.open_path(a)
                w.application.project_action('apply',{**binding(),'candidateId':candidate['id']})
                entry=w.history.record['history'][-1]
                history={**binding(),'kind':'history','id':entry['id'],'circuit':'main'}
                described=w.comparison.describe(history)
                self.assertEqual(described['diff']['counts'],{'interfaces':1})
                self.assertTrue(described['sides']['after']['current'])
                self.assertFalse(described['canRestore'])
                readonly=w.comparison.describe({**request,**binding()})
                self.assertFalse(readonly['canApply'])
                self.assertEqual(readonly['sides']['before']['revisionId'],initial['revisionId'])
                self.assertEqual(w.comparison.describe({**history,'mode':'current'})['diff']['rows'],[])
                self.assertEqual(a.read_bytes(),original);self.assertEqual(b.read_bytes(),original)
            finally:w.close()


if __name__=='__main__':unittest.main()
