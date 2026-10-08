"""Production organization contract: source binding, protection and publication.

No model calls. The actual zero-shot model runs are separate evidence.
"""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from contextlib import nullcontext

spec = importlib.util.spec_from_file_location('fidelity', Path(__file__).with_name('arrange-fidelity.py'))
fidelity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fidelity)
from studio.domain.tool_errors import CircuitToolError
from studio.project.arrangement import copper_preserved
from studio.domain.control_routing import repeated_control_networks, shared_rail
from studio.domain.routing import Router, Partition
from studio.domain.schematic_layout import SchematicLayout


class OrganizationContract(unittest.TestCase):
    def test_side_combs_are_mirrored_and_reject_obstacles_atomically(self):
        for side in ('left', 'right'):
            for obstacle in ('none', 'copper', 'label'):
                with self.subTest(side=side, obstacle=obstacle):
                    nodes={};partition=Partition()
                    for i in range(3):
                        cid=str(i);partition.join('control',cid)
                        nodes[cid]={'componentId':cid,'factoryName':'Register',
                            'bounds':{'x':100,'y':100+i*100,'width':40,'height':40},
                            'ends':[{'index':0,'direction':'input',
                                'location':{'x':100 if side=='left' else 140,'y':120+i*100},
                                'netBits':[{'bit':0,'netId':cid}]}]}
                    router=Router({'focus':{'components':list(nodes.values()),'wires':[],'wireBundles':[]}},partition)
                    if obstacle=='copper':router.add((50,180),(190,180),('foreign',),('foreign',))
                    labels=[(('foreign',),(55 if side=='left' else 155,160,85 if side=='left' else 185,200))] if obstacle=='label' else []
                    before=list(router.segments)
                    result=shared_rail(router,nodes,[(cid,0)for cid in nodes],
                        lambda c,i:SchematicLayout._port_edge(None,c,i),{}, {'left':50,'right':190},labels)
                    if obstacle=='none':
                        self.assertEqual(len(result),4)  # One trunk and three straight branches.
                        trunk=[(a,b)for a,b in result if a[0]==b[0]]
                        self.assertEqual(len(trunk),1)
                        self.assertEqual(abs(trunk[0][1][1]-trunk[0][0][1]),200)
                        self.assertEqual(len({router.connected.root((cid,))for cid in nodes}),1)
                    else:
                        self.assertIsNone(result)
                        self.assertEqual(router.segments,before)
                        self.assertEqual(len({router.connected.root((cid,))for cid in nodes}),3)

    def test_alias_flags_on_their_own_wire_do_not_collapse_during_emission(self):
        body=fidelity.pin(100,100,'A')+fidelity.tunnel(100,100,'A',facing='west')
        body+=fidelity.gate('NOT Gate',300,500)+fidelity.tunnel(270,500,'A')
        body+=fidelity.tunnel(300,500,'ALIAS_X',facing='west')+fidelity.tunnel(300,500,'ALIAS_Y',facing='west')
        body+=fidelity.gate('NOT Gate',700,500)+fidelity.tunnel(670,500,'ALIAS_X')
        source=fidelity.project(fidelity.circuit('main',body)).replace('<main name="main"/>','<lib name="6" desc="#Base"/><main name="main"/>')
        with tempfile.TemporaryDirectory(prefix='vibe-native-alias-')as tmp:
            session=fidelity.Session(tmp,source)
            try:
                obs=session.workspace.workbench.call(session.revision,'inspect_circuit',{'circuit':'main','layoutContext':{'panelBelowY':250}})
                result,artifact=session.arrange('main',artifactSha256=obs['artifactSha256'],panelBelowY=250,
                    organization={'groups':[{'id':'logic','label':'Logic','row':0,'componentIds':[c['componentId']for c in obs['layoutContext']['components']]}]})
                self.assertTrue(result['netlist']['equivalent'])
                flags=[c for c in session.observe(artifact,'main')['components']if c['factoryName']=='Tunnel' and fidelity.label(c)in ('ALIAS_X','ALIAS_Y')]
                self.assertEqual(len(flags),2)
                self.assertNotEqual(flags[0]['location'],flags[1]['location'])
            finally:session.close()

    def test_local_named_enable_does_not_hide_adjacent_data_label(self):
        body = fidelity.pin(100,100,'DATA',width=8)+fidelity.tunnel(100,100,'DATA',width=8,facing='west')
        for y,name in [(160,'LEFT'),(220,'RIGHT')]:
            body+=fidelity.pin(100,y,name)+fidelity.tunnel(100,y,name,facing='west')
        body+=fidelity.gate('AND Gate',400,500,inputs=2)
        body+=fidelity.tunnel(370,490,'LEFT')+fidelity.tunnel(370,510,'RIGHT')
        body+=fidelity.tunnel(400,500,'DISPLAY_ENABLE',facing='west')
        body+='<comp lib="4" name="Register" loc="(700,500)"><a name="width" val="8"/></comp>'
        body+=fidelity.tunnel(670,500,'DATA',width=8)+fidelity.tunnel(670,510,'DISPLAY_ENABLE')
        source=fidelity.project(fidelity.circuit('main',body)).replace('source="2.7.1"','source="2.15.0.2.exe"').replace(
            '<main name="main"/>','<lib name="4" desc="#Memory"/><lib name="6" desc="#Base"/><main name="main"/>')
        with tempfile.TemporaryDirectory(prefix='vibe-local-label-') as tmp:
            session=fidelity.Session(tmp,source)
            try:
                obs=session.workspace.workbench.call(session.revision,'inspect_circuit',{'circuit':'main','layoutContext':{'panelBelowY':250}})
                result,artifact=session.arrange('main',artifactSha256=obs['artifactSha256'],panelBelowY=250,
                    organization={'groups':[{'id':'display','label':'Display','row':0,'componentIds':[c['componentId']for c in obs['layoutContext']['components']]}]})
                self.assertTrue(result['netlist']['equivalent'])
                self.assertEqual(result['arrangement']['labelGeometry']['remainingCollisions'],0)
                actual=session.observe(artifact,'main')
                self.assertTrue(any(fidelity.label(c)=='DISPLAY_ENABLE' for c in actual['components']))
                self.assertEqual(session.src.read_text(),source)
            finally:session.close()

    def test_one_bit_fanout_alone_is_not_control_evidence(self):
        nodes={str(i):{'factoryName':'Register','ends':[
            {'direction':'input','semanticRole':'clock'},
            {'direction':'input','semanticRole':'d'},
            {'direction':'input','semanticRole':None}]} for i in range(4)}
        layout=SimpleNamespace(by_id=nodes,nets={k:[(cid,index)for cid in nodes]
            for index,k in enumerate(['control','one-bit-data','unknown'])},
            bits_of={k:[0] for k in ['control','one-bit-data','unknown']},
            classes={k:'wire' for k in ['control','one-bit-data','unknown']})
        self.assertEqual(repeated_control_networks(layout,set(nodes)),{'control'})

    def test_shared_control_rails_preserve_native_nets_and_respect_keep_tunnels(self):
        # Two columns share clock, reset and a SIDE enable with arbitrary names.
        # Data ports share the enable net too: semantic role, not net membership,
        # must decide which ports can join the regular control rail.
        names = ('pulse', 'clear', 'permit')
        body = ''.join(fidelity.pin(100, 80+i*70, name) +
                       fidelity.tunnel(100, 80+i*70, name, facing='west') for i,name in enumerate(names))
        ids=[]
        for i in range(8):
            x,y=500,400+i*180;ids.append(f'c{x}_{y}')
            body += f'<comp lib="4" name="Register" loc="({x},{y})"><a name="width" val="1"/><a name="label" val="R{i}"/></comp>'
            body += fidelity.tunnel(x-20,y+20,'pulse',facing='north')
            body += fidelity.tunnel(x-10,y+20,'clear',facing='north')
            body += fidelity.tunnel(x-30,y+10,'permit')
            body += fidelity.tunnel(x-30,y,'permit')
            body += fidelity.pin(900,400+i*180,f'Y{i}',out=True)
            body += fidelity.tunnel(900,400+i*180,f'Q{i}')
            body += fidelity.tunnel(x,y,f'Q{i}',facing='west')
        source=fidelity.project(fidelity.circuit('main',body)).replace('source="2.7.1"','source="2.15.0.2.exe"').replace(
            '<main name="main"/>','<lib name="4" desc="#Memory"/><lib name="6" desc="#Base"/><main name="main"/>')
        with tempfile.TemporaryDirectory(prefix='vibe-control-rails-') as tmp:
            session=fidelity.Session(tmp,source)
            try:
                for mode in ('rails', 'side-only', 'keep', 'blocked', 'disabled'):
                    with self.subTest(mode=mode):
                        keep=list(names) if mode=='keep' else list(names[:2]) if mode=='side-only' else []
                        obs=session.workspace.workbench.call(session.revision,'inspect_circuit',
                            {'circuit':'main','layoutContext':{'panelBelowY':250,'keepTunnels':keep}})
                        others=[c['componentId'] for c in obs['layoutContext']['components'] if c['componentId'] not in ids]
                        organization={'groups':[{'id':'single','label':'Sample bank','row':0,'layout':'bank','columns':2,'componentIds':ids},
                                                 {'id':'out','label':'Outputs','row':0,'componentIds':others}],
                                      'sharedControls':mode!='disabled'}
                        # Simulate exhausted clear corridors, independently of the
                        # router heuristic: all ports must retain native connectivity.
                        context=patch('studio.domain.control_routing.shared_rail',return_value=None) if mode=='blocked' else nullcontext()
                        with context:
                            result,artifact=session.arrange('main',artifactSha256=obs['artifactSha256'],
                                panelBelowY=250,keepTunnels=keep,organization=organization)
                        self.assertTrue(result['netlist']['equivalent'])
                        self.assertTrue(result['changes'][0]['protectedComponentsPreserved'])
                        controls=result['arrangement']['sharedControls']
                        self.assertEqual(len(controls['trees']),0 if mode in ('keep','disabled') else 2 if mode=='side-only' else 6)
                        if mode in ('rails','side-only','blocked'):
                            for r in controls['routes']:
                                expected='named-fallback' if mode=='blocked' or (mode=='rails' and r['label']=='permit') else 'shared-rail'
                                self.assertEqual(r['method'],expected)
                            self.assertEqual({r['column'] for r in controls['routes']},{0,1})
                            # The data input tied to permit never enters a control tree.
                            permit=[t for t in controls['trees'] if 'permit' in t['labels']]
                            self.assertEqual([len(t['ports']) for t in permit],[4,4])
                        actual=session.observe(artifact,'main')
                        labels=[fidelity.label(c) for c in actual['components'] if c['factoryName']=='Tunnel']
                        for name in (() if mode=='disabled' else ('pulse','clear')):
                            self.assertEqual(labels.count(name),3 if mode=='rails' else 9)
                self.assertEqual(session.src.read_text(),source)
            finally: session.close()

    def test_grouped_default_interface_moves_pins_without_swapping_parent_ports(self):
        child = fidelity.circuit('sub', fidelity.pin(100, 100, 'A') + fidelity.pin(100, 200, 'B')
                                 + fidelity.pin(100, 300, 'C') + fidelity.pin(500, 100, 'Y', out=True)
                                 + fidelity.wire((100, 100), (500, 100)))
        with tempfile.TemporaryDirectory(prefix='vibe-grouped-pin-order-') as tmp:
            probe_dir = Path(tmp) / 'probe'
            probe_dir.mkdir()
            source = fidelity.with_parent(probe_dir, 'sub', child).replace(
                '<main name="main"/>', '<lib name="6" desc="#Base"/><main name="main"/>')
            session = fidelity.Session(tmp, source)
            try:
                original_ports = session.instance_ports(session.src, 'main', 'sub')
                observed = session.workspace.workbench.call(session.revision, 'inspect_circuit',
                                                            {'circuit':'sub', 'layoutContext':{'panelBelowY':0}})
                groups = [{'id':str(i), 'label':name, 'row':i,
                           'componentIds':[cid]} for i, (name,cid) in enumerate(
                               [('C','c100_300'),('B','c100_200'),('A','c100_100'),('Y','c500_100')])]
                result, artifact = session.arrange('sub', artifactSha256=observed['artifactSha256'],
                                                   panelBelowY=0, organization={'groups':groups})
                self.assertTrue(result['arrangement']['interfaceOrderRepairs'])
                self.assertEqual(original_ports, session.instance_ports(artifact, 'main', 'sub'))
                self.assertTrue(result['netlist']['equivalent'])
                self.assertEqual(session.src.read_text(), source)
                actual = {c['selector']['label']:c['location'] for c in session.observe(artifact,'sub')['components'] if c['factoryName']=='Pin'}
                self.assertNotEqual(actual['A'], {'x':100, 'y':100})
            finally:
                session.close()

    def test_protected_copper_accepts_native_splits_but_not_gaps_or_displacement(self):
        def wire(x1, x2, y=20):
            return {'from': {'x': x1, 'y': y}, 'to': {'x': x2, 'y': y}}
        original = [wire(100, 300)]
        self.assertTrue(copper_preserved(original, [wire(100, 180), wire(300, 180)]))
        self.assertFalse(copper_preserved(original, [wire(100, 170), wire(180, 300)]))
        self.assertFalse(copper_preserved(original, [wire(100, 300, y=30)]))

    def test_ordered_interfaces_include_vertical_faces_and_a_fixed_pin(self):
        pins = [('east',100,100),('east',100,200),('west',500,100),('west',500,200),
                ('north',200,500),('north',300,500),('south',200,700),('south',300,700)]
        child = fidelity.circuit('sub', ''.join(fidelity.pin(x,y,f'P{i}', facing=f)
                                                for i,(f,x,y) in enumerate(pins)))
        with tempfile.TemporaryDirectory(prefix='vibe-grouped-all-faces-') as tmp:
            probe_dir = Path(tmp) / 'probe'; probe_dir.mkdir()
            source = fidelity.with_parent(probe_dir, 'sub', child).replace(
                '<main name="main"/>', '<lib name="6" desc="#Base"/><main name="main"/>')
            session = fidelity.Session(tmp, source)
            try:
                ports = session.instance_ports(session.src, 'main', 'sub')
                observed = session.workspace.workbench.call(session.revision, 'inspect_circuit',
                    {'circuit':'sub', 'layoutContext':{'panelBelowY':0, 'pinnedComponentIds':['c100_100']}})
                groups = [{'id':str(i),'label':f'P{i}','row':i,'componentIds':[f'c{x}_{y}']}
                          for i,(_f,x,y) in enumerate(reversed(pins)) if (x,y)!=(100,100)]
                result, artifact = session.arrange('sub', artifactSha256=observed['artifactSha256'],
                    panelBelowY=0, pinnedComponentIds=['c100_100'], organization={'groups':groups})
                self.assertEqual(ports, session.instance_ports(artifact, 'main', 'sub'))
                fixed = next(c for c in session.observe(artifact,'sub')['components']
                             if c['factoryName']=='Pin' and c['selector']['label']=='P0')
                self.assertEqual(fixed['location'], {'x':100,'y':100})
                self.assertTrue(result['changes'][0]['protectedComponentsPreserved'])
            finally:
                session.close()

    def test_bound_organization_preserves_fixed_objects_and_rejects_missing_members(self):
        body = (fidelity.pin(100, 100, 'A') + fidelity.pin(500, 100, 'Y', out=True)
                + fidelity.gate('NOT Gate', 300, 500)
                + fidelity.wire((100, 100), (100, 500))
                + fidelity.wire((100, 500), (270, 500))
                + fidelity.wire((300, 500), (500, 500))
                + fidelity.wire((500, 500), (500, 100)))
        source = fidelity.project(fidelity.circuit('main', body)).replace(
            '<main name="main"/>', '<lib name="6" desc="#Base"/><main name="main"/>')
        with tempfile.TemporaryDirectory(prefix='vibe-organize-contract-') as tmp:
            session = fidelity.Session(tmp, source)
            try:
                wb = session.workspace.workbench
                options = {'panelBelowY': 200}
                observed = wb.call(session.revision, 'inspect_circuit', {'circuit': 'main', 'layoutContext': options})
                context = observed['layoutContext']
                self.assertEqual(set(context['fixedComponentIds']), {'c100_100', 'c500_100'})
                self.assertEqual([c['componentId'] for c in context['components']], ['c300_500'])
                organization = {'groups': [{'id': 'logic', 'label': '反相逻辑', 'row': 0, 'componentIds': ['c300_500']}]}
                with self.assertRaises(CircuitToolError) as missing_hash:
                    session.arrange('main', organization=organization, **options)
                self.assertEqual(missing_hash.exception.code, 'STALE_REVISION')
                with self.assertRaises(CircuitToolError) as invalid:
                    session.arrange('main', artifactSha256=observed['artifactSha256'],
                                    organization={'groups': [{'id': 'bad', 'label': 'bad', 'row': 0, 'componentIds': ['c100_100']}]}, **options)
                self.assertEqual(invalid.exception.code, 'INVALID_LAYOUT_ORGANIZATION')
                self.assertEqual(list((session.workspace.state_root / 'candidates').glob('candidate-*')), [])
                result, artifact = session.arrange('main', artifactSha256=observed['artifactSha256'], organization=organization, **options)
                self.assertTrue(result['netlist']['equivalent'])
                self.assertTrue(result['changes'][0]['protectedComponentsPreserved'])
                self.assertTrue(result['interfacePreserved'])
                self.assertEqual(hashlib.sha256(session.src.read_bytes()).hexdigest(), observed['artifactSha256'])
                self.assertIn('反相逻辑', artifact.read_text())
                self.assertNotEqual(artifact.read_bytes(), session.src.read_bytes())
            finally:
                session.close()


if __name__ == '__main__':
    unittest.main()
