"""Regressions from real course artifacts; no model calls."""
import copy
import importlib.util
import tempfile
import unittest
from pathlib import Path
import xml.etree.ElementTree as ET

spec=importlib.util.spec_from_file_location('fidelity',Path(__file__).with_name('arrange-fidelity.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
from studio.domain.connectivity import assert_preserved_connections
from studio.project.layout_document import _apply
from studio.project.arrangement import copper_preserved


def alias(cid,label,net='a',x=100):
    return {'componentId':cid,'factory':'Tunnel','location':{'x':x,'y':100},
            'attributes':{'label':label},'ends':[{'index':0,'width':1,'netBits':[{'bit':0,'netId':net}]}]}


class LayoutStability(unittest.TestCase):
    def test_existing_aliases_match_one_to_one_but_new_shorts_are_rejected(self):
        before=[alias('a','First'),alias('b','Alias'),alias('c','Remote','b',200)]
        after=copy.deepcopy(list(reversed(before)))
        self.assertEqual(assert_preserved_connections(before,after,set(),0,0),3)
        after[0]['ends'][0]['netBits'][0]['netId']='a'
        with self.assertRaisesRegex(ValueError,'短接'):
            assert_preserved_connections(before,after,set(),0,0)
        with self.assertRaisesRegex(ValueError,'数量'):
            assert_preserved_connections(before,after[:-1],set(),0,0)

    def test_selecting_one_alias_does_not_move_its_colocated_neighbor(self):
        circuit=ET.fromstring('<circuit>'+f.tunnel(100,100,'First')+f.tunnel(100,100,'Alias')+'</circuit>')
        _apply(circuit,{'components':[alias('a','First'),alias('b','Alias')]},{'b':(0,40)},[])
        self.assertEqual([c.get('loc') for c in circuit.findall('comp')],['(100,100)','(100,140)'])

    def test_native_geometry_is_independent_of_prior_overview_render(self):
        text=f.project(f.circuit('main',f.tunnel(100,100,'a long signal name')+f.tunnel(150,120,'alias')+f.pin(5000,5000,'far')))
        with tempfile.TemporaryDirectory() as tmp:
            session=f.Session(tmp,text)
            try:
                observer=session.workspace.observer
                def geometry(render=None):
                    data=observer.run_full(session.src,'main',render)
                    return [(c['componentId'],c['bounds'],c['visualBounds'],c['ends']) for c in data['focus']['components']]
                cold=geometry()
                self.assertEqual(cold,geometry(Path(tmp)/'overview.png'))
                self.assertEqual(cold,geometry())
                self.assertEqual(session.src.read_text(),text)
            finally:session.close()

    def test_fixed_copper_survives_tunnel_union_and_boundary_crossing(self):
        text=f.project(f.circuit('main',f.pin(100,100,'Source')+f.wire((100,100),(200,100))
            +f.wire((200,100),(200,500))+f.tunnel(200,500,'data')
            +f.gate('NOT Gate',230,500)
            +f.tunnel(400,500,'data')+f.wire((400,500),(470,500))+f.gate('NOT Gate',500,500)
            +f.wire((50,50),(250,50))))
        with tempfile.TemporaryDirectory() as tmp:
            session=f.Session(tmp,text)
            try:
                result,artifact=session.arrange('main',panelBelowY=250)
                focus=session.observe(artifact,'main')
                def w(a,b):return {'from':dict(zip(('x','y'),a)),'to':dict(zip(('x','y'),b))}
                self.assertTrue(copper_preserved([w((100,100),(200,100)),w((200,100),(200,250)),w((50,50),(250,50))],focus['wires']))
                self.assertTrue(result['netlist']['equivalent'])
                self.assertEqual(session.src.read_text(),text)
            finally:session.close()

    def test_source_text_has_content_and_is_not_an_electrical_bank_member(self):
        heading='<comp lib="6" name="Text" loc="(100,450)"><a name="text" val="Input bank"/><a name="halign" val="left"/></comp>'
        legend='<comp lib="6" name="Text" loc="(100,410)"><a name="text" val="'+('A long original legend '*8)+'"/><a name="halign" val="left"/></comp>'
        text=f.project(f.circuit('main',f.pin(100,500,'A')+heading+legend)).replace('<main name="main"/>','<lib name="6" desc="#Base"/><main name="main"/>')
        with tempfile.TemporaryDirectory() as tmp:
            session=f.Session(tmp,text)
            try:
                obs=session.workspace.workbench.call(session.revision,'inspect_circuit',{'circuit':'main','layoutContext':{'panelBelowY':0}})
                context=obs['layoutContext']
                self.assertEqual([c['componentId'] for c in context['components']],['c100_500'])
                self.assertEqual(len(context['annotations']),2)
                self.assertTrue(all(a['text'] for a in context['annotations']))
                result,artifact=session.arrange('main',panelBelowY=0,artifactSha256=obs['artifactSha256'],
                    organization={'groups':[{'id':'bank','label':'Inputs','row':0,'layout':'bank',
                    'componentIds':['c100_500','c100_450','c100_410']}]})
                report=result['arrangement']
                self.assertLess(report['layoutGroups'][0]['width'],400)
                self.assertEqual(len(report['sourceAnnotations']),2)
                self.assertEqual(report['layoutGroups'][0]['componentIds'],['c100_500'])
                original=[{a.get('name'):a.get('val') for a in n.findall('a')} for n in ET.fromstring(text).findall('.//comp') if n.get('name')=='Text']
                actual=[{a.get('name'):a.get('val') for a in n.findall('a')} for n in ET.fromstring(artifact.read_text()).findall('.//comp') if n.get('name')=='Text']
                for attrs in original:self.assertIn(attrs,actual)
            finally:session.close()


if __name__=='__main__':unittest.main()
