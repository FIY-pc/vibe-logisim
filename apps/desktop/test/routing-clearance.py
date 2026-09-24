"""Focused native routing checks and reproducible A/B images; no model calls.

VIBE_ROUTING_EVIDENCE=/persistent/path keeps native PNGs, observations and
candidates. VIBE_ROUTING_BASELINE=8d55cb6 also compares that committed Router.
Real artifacts are optional evidence, not a dependency of generic acceptance.
"""
import json
import hashlib
import os
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace
from studio.domain.routing import Router, Partition, point
from studio.domain import rerouting
from studio.domain.wire_geometry import subtract_segments


def fixture(kind='lead', rotation=0, version='2.16.2.2'):
    root = ET.fromstring(f'''<project source="{version}" version="1.0">
      <lib name="0" desc="#Wiring"/><lib name="1" desc="#Gates"/>
      <main name="main"/><circuit name="main"/>
      <circuit name="untouched"><comp lib="0" name="Pin" loc="(80,80)"/></circuit>
    </project>''')
    c = root.find('circuit')
    directions = ['east', 'south', 'west', 'north']
    def rotated(p):
        x, y = p[0] - 260, p[1] - 220
        for _ in range(rotation):
            x, y = -y, x
        return f'({x+360},{y+360})'
    def comp(name, p, **attrs):
        item = ET.SubElement(c, 'comp', lib='1' if name == 'NOT Gate' else '0', name=name, loc=rotated(p))
        for key, value in attrs.items():
            if key == 'facing':
                value = directions[(directions.index(value) + rotation) % 4]
            ET.SubElement(item, 'a', name=key, val=str(value))
    def wire(a, b):
        ET.SubElement(c, 'wire', {'from': rotated(a), 'to': rotated(b)})
    comp('Pin', (100,120), label='a', facing='east')
    comp('Pin', (420,260 if kind == 'lead' else 120), label='out', output='true', facing='west')
    # This second bus and definition must survive every partial operation.
    comp('Pin', (100,360), label='keep', facing='east', width=4)
    comp('Pin', (420,360), label='kept_out', output='true', facing='west', width=4)
    wire((100,360),(420,360))
    if kind == 'lead':
        comp('NOT Gate', (220,120), facing='east')
        wire((100,120),(200,120))
        wire((220,120),(220,260))
        wire((220,260),(420,260))
    else:
        comp('NOT Gate', (270,120), facing='east')
        wire((100,120),(100,60))
        wire((100,60),(420,60))
        wire((420,60),(420,120))
    return ET.tostring(root)


def load_baseline(ref):
    source = subprocess.check_output(['git', 'show', ref + ':apps/desktop/circuit-lens/studio/domain/routing.py'], cwd=REPO, text=True)
    module = types.ModuleType('routing_baseline')
    exec(compile(source, ref + '/routing.py', 'exec'), module.__dict__)
    return module.Router


class RoutingClearance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.evidence = Path(os.environ['VIBE_ROUTING_EVIDENCE']) if os.environ.get('VIBE_ROUTING_EVIDENCE') else None
        if cls.evidence:
            if cls.evidence.exists() and any(cls.evidence.iterdir()):
                raise ValueError('Use an empty evidence directory; previous runs are retained.')
            cls.evidence.mkdir(parents=True, exist_ok=True)
            (cls.evidence/'run.json').write_text(json.dumps({
                'modelCalls':0, 'baselineRef':os.environ.get('VIBE_ROUTING_BASELINE'),
                'routingSourceSha256':hashlib.sha256((REPO/'apps/desktop/circuit-lens/studio/domain/routing.py').read_bytes()).hexdigest(),
                'validationSourceSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            },indent=2))
        cls.temp = tempfile.TemporaryDirectory(prefix='routing-clearance-', dir=cls.evidence)
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name)
        cls.w = Workspace(REPO, cls.root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'routing-clearance')
        cls.addClassCleanup(cls.w.close)
        cls.baseline = load_baseline(os.environ['VIBE_ROUTING_BASELINE']) if os.environ.get('VIBE_ROUTING_BASELINE') else None
        cls.records = []

    @classmethod
    def tearDownClass(cls):
        if cls.evidence:
            (cls.evidence / 'results.json').write_text(json.dumps(cls.records, indent=2, ensure_ascii=False))

    def call(self, tool, args):
        return self.w.application.agent_tool({'projectId': self.w.history.record['id'], 'revisionId': self.w.revision_id,
                                              'tool': tool, 'arguments': args})

    def open(self, data, name, circuit='main'):
        self.source = self.root / (name + '.circ')
        self.source.write_bytes(data)
        self.original = data
        self.name, self.circuit = name, circuit
        self.w.open_path(self.source)
        self.revision = self.w.revision_id
        self.before = self.w.observer.run_full(self.source, circuit)
        return self.before

    def propose(self, ids, router=Router, label='after'):
        with patch.object(rerouting, 'Router', router):
            start = time.perf_counter()
            result = self.call('reroute_candidate', {'circuit': self.circuit,
                'artifactSha256': self.before['revision']['artifactSha256'], 'wireIds': sorted(ids)})
            elapsed = (time.perf_counter() - start) * 1000
        directory, _ = self.w.workbench._metadata(result['id'])
        candidate = (directory / 'artifact.circ').read_bytes()
        after = self.w.observer.run_full(directory / 'artifact.circ', self.circuit)
        self.assertEqual(self.source.read_bytes(), self.original)
        self.assertEqual(self.w.revision_id, self.revision)
        old_xml, new_xml = ET.fromstring(self.original), ET.fromstring(candidate)
        old_c = next(c for c in old_xml.findall('circuit') if c.get('name') == self.circuit)
        new_c = next(c for c in new_xml.findall('circuit') if c.get('name') == self.circuit)
        self.assertEqual([ET.tostring(c) for c in old_c.findall('comp')], [ET.tostring(c) for c in new_c.findall('comp')])
        self.assertEqual([ET.tostring(c) for c in old_xml.findall('circuit') if c is not old_c],
                         [ET.tostring(c) for c in new_xml.findall('circuit') if c is not new_c])
        # Compare actual retained copper coverage after native normalization.
        after_segments = [(point(wire['from']), point(wire['to'])) for wire in after['focus']['wires']]
        for wire in self.before['focus']['wires']:
            if wire['wireId'] not in ids:
                self.assertEqual(subtract_segments(point(wire['from']), point(wire['to']), after_segments), [])
        record = {'name': self.name, 'variant': label, 'wireIds':sorted(ids), 'elapsedMs': elapsed, 'candidate': result,
                  'sourceAndRevisionUnchanged': True, 'componentsAndOtherDefinitionsUnchanged': True,
                  'retainedCopperPreserved': True}
        self.records.append(record)
        if self.evidence:
            output = self.evidence / self.name
            output.mkdir(exist_ok=True)
            (output / 'source.circ').write_bytes(self.original)
            (output / 'source-observation.json').write_text(json.dumps(self.before))
            (output / (label + '.circ')).write_bytes(candidate)
            (output / (label + '.json')).write_text(json.dumps(after))
            # Only composite native transparency onto white; never draw wires.
            from PIL import Image
            im = Image.open(next(directory.glob('*.png'))).convert('RGBA')
            white = Image.new('RGBA', im.size, 'white')
            white.alpha_composite(im)
            white.convert('RGB').save(output / (label + '.png'))
        return result, after

    def test_native_leads_in_four_orientations_and_both_runtimes(self):
        for version in ('2.16.2.2', '2.15.0'):
            for rotation in range(4):
                with self.subTest(version=version, rotation=rotation):
                    before = self.open(fixture(rotation=rotation, version=version), f'lead-{version}-{rotation}')
                    gate = next(c for c in before['focus']['components'] if c['factoryName'] == 'NOT Gate')
                    output = next(e for e in gate['ends'] if e['direction'] == 'output')
                    owner = [b['netId'] for b in output['netBits']]
                    bundles = {b['bundleId'] for b in before['focus']['wireBundles'] if [n['netId'] for n in b['bitNets']] == owner}
                    ids = {wire['wireId'] for wire in before['focus']['wires'] if wire['bundleId'] in bundles}
                    if self.baseline:
                        self.propose(ids, self.baseline, 'before')
                    result, after = self.propose(ids)
                    p = point(output['location'])
                    outward = [(10,0),(0,10),(-10,0),(0,-10)][rotation]
                    adjacent = []
                    for wire in after['focus']['wires']:
                        a,b = point(wire['from']),point(wire['to'])
                        if p in (a,b):
                            q = b if p == a else a
                            adjacent.append(((q[0]-p[0])//max(abs(q[0]-p[0]),abs(q[1]-p[1]))*10,
                                             (q[1]-p[1])//max(abs(q[0]-p[0]),abs(q[1]-p[1]))*10))
                    self.assertEqual(adjacent, [outward], 'gate output must have a visible outward lead')
                    simulated = self.call('simulate_circuit', {'circuit':'main', 'candidateId':result['id'],
                        'vectors':[{'inputs':{'a':a,'keep':b},'expected':{'out':1-a,'kept_out':b}} for a in range(2) for b in range(16)]})
                    self.assertEqual((simulated['passed'],simulated['failed']), (32,0))
                    self.records[-1]['simulation'] = {'passed':simulated['passed'],'failed':simulated['failed']}

    def test_native_obstacle_bypass_and_wire_candidate(self):
        for version in ('2.16.2.2','2.15.0'):
            before = self.open(fixture(kind='obstacle',version=version), 'obstacle-'+version)
            wire_ids = {wire['wireId'] for wire in before['focus']['wires'] if wire['from']['y'] != 500}
            if self.baseline:
                self.propose(wire_ids,self.baseline,'before')
            result, after = self.propose(wire_ids)
            obstacle = next(c for c in before['focus']['components'] if c['factoryName'] == 'NOT Gate')['bounds']
            self.assert_clears(after, obstacle)
            # The other shared caller uses the same preferences for new wiring.
            root = ET.fromstring(self.original)
            c = root.find('circuit')
            for wire in list(c.findall('wire')):
                if wire.get('from') != '(200,500)':
                    c.remove(wire)
            before = self.open(ET.tostring(root),'new-wire-'+version)
            components = {c['selector']['label']:c['componentId'] for c in before['focus']['components']}
            result = self.call('wire_candidate', {'title':'Route around an existing component','circuit':'main','connections':[{'name':'a to out','from':{'component':components['a'],'port':0},
                'to':{'component':components['out'],'port':0}}]})
            simulated = self.call('simulate_circuit', {'circuit':'main','candidateId':result['id'],
                'vectors':[{'inputs':{'a':a,'keep':b},'expected':{'out':a,'kept_out':b}} for a in range(2) for b in range(16)]})
            self.assertEqual((simulated['passed'],simulated['failed']),(32,0))
            directory, _ = self.w.workbench._metadata(result['id'])
            self.assert_clears(self.w.observer.run_full(directory/'artifact.circ','main'), obstacle)
            self.records.append({'name':self.name,'variant':'wire_candidate','wiringProof':result['changes'][0]['wiringProof'],
                                 'simulation':{'passed':simulated['passed'],'failed':simulated['failed']}})
            self.assertEqual(self.source.read_bytes(),self.original)
            self.assertEqual(self.w.revision_id,self.revision)

    def assert_clears(self, document, obstacle):
        for wire in document['focus']['wires']:
            for x,y in Router.grid(point(wire['from']),point(wire['to'])):
                gap = max(obstacle['x']-x, x-obstacle['x']-obstacle['width'],
                          obstacle['y']-y, y-obstacle['y']-obstacle['height'], 0)
                self.assertGreaterEqual(gap,10,'unrelated wire must clear the component edge')

    def test_direct_route_stays_straight(self):
        before = self.open(fixture(), 'straight')
        component = next(c for c in before['focus']['components'] if c['selector']['label'] == 'keep')
        bits = [n['netId'] for n in component['ends'][0]['netBits']]
        bundles = {b['bundleId'] for b in before['focus']['wireBundles'] if [n['netId'] for n in b['bitNets']] == bits}
        ids = {wire['wireId'] for wire in before['focus']['wires'] if wire['bundleId'] in bundles}
        for label,router in ([('before',self.baseline)] if self.baseline else [])+[('after',Router)]:
            result,_ = self.propose(ids,router,label)
            summary = result['changes'][0]['routing']
            self.assertEqual(summary['lengthBefore'], summary['lengthAfter'])
            self.assertEqual(summary['lengthAfter'],320)

    def test_soft_clearance_keeps_narrow_gap_and_boundary_anchor_reachable(self):
        def box(x,y,w,h):
            return {'factoryName':'body','bounds':dict(x=x,y=y,width=w,height=h),'ends':[]}
        # Only one grid row between bodies; making clearance a hard obstacle
        # would reject this legal connection and a fixed junction on the edge.
        router = Router({'focus':{'components':[box(100,80,100,20),box(100,110,100,20)],
                                  'wires':[],'wireBundles':[]}}, Partition())
        router.extent = (80,100,220,110)
        segments = router.path({(100,100)},(220,100),('signal',))
        self.assertEqual(segments[0][0],(100,100))
        self.assertEqual(segments[-1][1],(220,100))
        self.assertTrue(all(p not in router.blocked for a,b in segments for p in router.grid(a,b)))

    def test_search_window_follows_circuits_drawn_above_the_origin(self):
        # Course files put the observation panel at negative y. The window used
        # to be clamped at 0, so every route to a port above the origin failed
        # with "留出更多空间" although the space was empty.
        pin = lambda x, y: {'factoryName': 'Pin', 'bounds': dict(x=x - 10, y=y - 10, width=20, height=20),
                            'ends': [{'location': {'x': x, 'y': y}, 'netBits': [{'netId': 'n1', 'bit': 0}], 'direction': 'input'}]}
        router = Router({'focus': {'components': [pin(300, -250), pin(500, -250)], 'wires': [], 'wireBundles': []}}, Partition())
        self.assertLess(router.extent[1], -250)
        segments = router.path({(300, -250)}, (500, -250), ('n1',))
        self.assertEqual((segments[0][0], segments[-1][1]), ((300, -250), (500, -250)))

    @unittest.skipUnless(os.environ.get('VIBE_ROUTING_EVIDENCE'),'optional frozen real artifacts')
    def test_frozen_real_artifacts(self):
        cases = [
            ('satadd-1.9.3','experiments/011-saturating-adder/results/2026-09-20/full-1.9.3/design.circ'),
            ('satadd-1.9.4','experiments/011-saturating-adder/results/2026-09-20/full-1.9.4/design.circ'),
            ('full-adder','experiments/007-local-rerouting/results/2026-09-19/direct-tool/before.circ'),
        ]
        for name, path in cases:
            source = REPO/path
            circuit = ET.parse(source).find('main').get('name')
            before = self.open(source.read_bytes(),name,circuit)
            for selection,ids in [('all',{wire['wireId'] for wire in before['focus']['wires']}),
                                  *([('control',{'w006'})] if name == 'satadd-1.9.3' else [])]:
                self.name = name+'-'+selection
                for label,router in ([('before',self.baseline)] if self.baseline else [])+[('after',Router)]:
                    result,_ = self.propose(ids,router,label)
                    times=[]
                    # Native load/compilation excluded from this geometry-only cost.
                    with patch.object(rerouting,'Router',router):
                        for _ in range(11):
                            start=time.perf_counter();rerouting.reroute(before,ids);times.append((time.perf_counter()-start)*1000)
                    self.records[-1]['geometryMs']={'median':statistics.median(times),'min':min(times),'max':max(times),'repetitions':len(times)}


if __name__ == '__main__':
    unittest.main()
