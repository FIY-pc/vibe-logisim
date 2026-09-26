"""Production acceptance for simultaneous, distinct final component positions.

Run: python3 apps/desktop/test/candidate-positions.py -v
Uses both supported native runtimes, inline circuits and Workspace tools only;
no model calls, monkeypatches, course fixtures or source application/save.
"""
from contextlib import contextmanager
from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
sys.path.insert(0, str(REPO / 'apps/desktop/test'))
from support.samples import runtime_versions
from studio.application.workspace import Workspace
from studio.domain.tool_errors import CircuitToolError

VERSIONS = runtime_versions(REPO)
VALUES = (0, 1, 128, 255)


def fixture(version):
    # Explicit appearance keeps external port positions and labels independent
    # of the internal Pin sort order, including when the two outputs swap.
    return f'''<?xml version="1.0"?>
<project source="{version}" version="1.0">
  <lib desc="#Wiring" name="0"/><main name="main"/>
  <circuit name="main">
    <a name="circuit" val="main"/>
    <appear>
      <rect x="50" y="50" width="100" height="80" fill="none" stroke="#000000"/>
      <circ-port x="46" y="86" width="8" height="8" pin="100,160"/>
      <circ-port x="145" y="65" width="10" height="10" pin="400,120"/>
      <circ-port x="145" y="105" width="10" height="10" pin="400,240"/>
      <circ-anchor x="146" y="86" width="8" height="8" facing="east"/>
    </appear>
    <comp lib="0" name="Pin" loc="(100,160)">
      <a name="label" val="input"/><a name="width" val="8"/>
      <a name="facing" val="east"/><a name="tristate" val="false"/>
    </comp>
    <comp lib="0" name="Pin" loc="(400,120)">
      <a name="label" val="out_a"/><a name="width" val="8"/>
      <a name="output" val="true"/><a name="facing" val="west"/>
    </comp>
    <comp lib="0" name="Pin" loc="(400,240)">
      <a name="label" val="out_b"/><a name="width" val="8"/>
      <a name="output" val="true"/><a name="facing" val="west"/>
    </comp>
    <wire from="(100,160)" to="(240,160)"/>
    <wire from="(240,160)" to="(240,120)"/>
    <wire from="(240,120)" to="(400,120)"/>
    <wire from="(240,160)" to="(240,240)"/>
    <wire from="(240,240)" to="(400,240)"/>
  </circuit>
</project>'''.encode()


class CandidatePositions(unittest.TestCase):
    @contextmanager
    def opened(self, version):
        with tempfile.TemporaryDirectory(prefix='vibe-candidate-positions-') as directory:
            root = Path(directory)
            self.source = root / 'design.circ'
            self.original = fixture(version)
            self.source.write_bytes(self.original)
            self.w = Workspace(REPO, root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py',
                               'candidate-positions')
            try:
                self.w.open_path(self.source)
                self.before_state = deepcopy((self.w.revision_id, self.w.artifact_sha256, self.w.history.record))
                self.frozen = self.w.frozen_path.read_bytes()
                self.before = self.call('inspect_circuit', includeWires=True)
                self.assert_bus(self.before)
                self.assert_simulation()
                try:
                    yield
                finally:
                    self.assert_source_unchanged()
            finally:
                self.w.close()

    def call(self, tool, **arguments):
        return self.w.application.agent_tool({
            'projectId': self.w.history.record['id'], 'revisionId': self.w.revision_id,
            'tool': tool, 'arguments': {'circuit': 'main', **arguments},
        })

    def positions(self, observed, **locations):
        components = {c['label']: c for c in observed['components']}
        return [{'componentId': components[label]['componentId'], 'x': xy[0], 'y': xy[1]}
                for label, xy in locations.items()]

    def propose(self, observed, positions, **extra):
        args = {'artifactSha256': observed['artifactSha256'], 'positions': positions, **extra}
        if observed['candidateId']:
            args['candidateId'] = observed['candidateId']
        return self.call('move_candidate', **args)

    def move(self, observed, **locations):
        positions = self.positions(observed, **locations)
        try:
            candidate = self.propose(observed, positions)
        except CircuitToolError as error:
            self.fail(f'Legal simultaneous move rejected: {error}; '
                      f'candidateId={observed["candidateId"]}; '
                      f'artifactSha256={observed["artifactSha256"]}; '
                      f'positions={json.dumps(positions)}; labels={locations}')
        after = self.call('inspect_circuit', candidateId=candidate['id'], includeWires=True)
        expected = {c['label']: c['location'] for c in observed['components']}
        expected.update({label: {'x': xy[0], 'y': xy[1]} for label, xy in locations.items()})
        self.assertEqual({c['label']: c['location'] for c in after['components']}, expected)
        self.assertEqual(candidate['parentCandidateId'], observed['candidateId'])
        self.assertTrue(candidate['interfacePreserved'])
        self.assertTrue(candidate['sourceUnchanged'])
        self.assertEqual(candidate['changes'][0]['wiringProof']['authority'], 'native-bit-net-partition')
        self.assertEqual(candidate['changes'][0]['wiringProof']['checkedPortBits'], 24)
        self.assert_bus(after)
        self.assert_appearance(candidate['id'], expected)
        self.assert_simulation(candidate['id'])
        self.assert_source_unchanged()
        return candidate, after

    def assert_bus(self, observed):
        self.assertEqual(observed['authority'], 'exact-runtime')
        pins = {c['label']: c for c in observed['components']}
        self.assertEqual(set(pins), {'input', 'out_a', 'out_b'})
        self.assertEqual(pins['input']['location'], {'x': 100, 'y': 160})
        nets = {}
        for label, pin in pins.items():
            self.assertEqual(pin['factory'], 'Pin')
            self.assertEqual(len(pin['ends']), 1)
            end = pin['ends'][0]
            self.assertEqual(end['width'], 8)
            nets[label] = {b['bit']: b['netId'] for b in end['netBits']}
            self.assertEqual(set(nets[label]), set(range(8)))
            self.assertEqual(len(set(nets[label].values())), 8)
        self.assertEqual(nets['input'], nets['out_a'])
        self.assertEqual(nets['input'], nets['out_b'])
        edges = {frozenset((tuple(w['from'][k] for k in ('x', 'y')),
                            tuple(w['to'][k] for k in ('x', 'y'))))
                 for w in observed['wireGeometry']['wires']}
        self.assertIn(frozenset(((100, 160), (240, 160))), edges, 'fixed input trunk retained')
        self.assertGreaterEqual(sum((240, 160) in edge for edge in edges), 3, 'fixed branch retained')

    def assert_appearance(self, candidate_id, locations):
        artifact = self.w.state_root / 'candidates' / candidate_id / 'artifact.circ'
        appearance = ET.parse(artifact).find('circuit/appear')
        original = ET.fromstring(self.original).find('circuit/appear')
        self.assertEqual(len(appearance), len(original))
        labels = iter(('input', 'out_a', 'out_b'))
        for before, after in zip(original, appearance):
            expected = dict(before.attrib)
            if before.tag == 'circ-port':
                location = locations[next(labels)]
                expected['pin'] = f'{location["x"]},{location["y"]}'
            self.assertEqual((after.tag, after.attrib), (before.tag, expected))

    def assert_simulation(self, candidate_id=None):
        result = self.call('simulate_circuit', **({'candidateId': candidate_id} if candidate_id else {}),
                           vectors=[{'inputs': {'input': value},
                                     'expected': {'out_a': value, 'out_b': value}} for value in VALUES])
        self.assertEqual((result['passed'], result['failed']), (4, 0), result)
        self.assertEqual(len(result['rows']), 4)
        for value, row in zip(VALUES, result['rows']):
            self.assertIs(row['passed'], True, row)
            self.assertEqual(row['outputs'], {'out_a': value, 'out_b': value})

    def candidate_files(self):
        root = self.w.state_root / 'candidates'
        return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*') if p.is_file()}

    def assert_source_unchanged(self):
        self.assertEqual(self.source.read_bytes(), self.original)
        self.assertEqual(self.w.frozen_path.read_bytes(), self.frozen)
        self.assertEqual((self.w.revision_id, self.w.artifact_sha256, self.w.history.record), self.before_state)

    def reject(self, observed, positions, *, pattern=None, **extra):
        files = self.candidate_files()
        root = self.w.state_root / 'candidates'
        directories = {p.name for p in root.iterdir()} if root.exists() else set()
        try:
            with self.assertRaises(CircuitToolError) as caught:
                self.propose(observed, positions, **extra)
            if pattern:
                self.assertRegex(str(caught.exception), pattern)
        finally:
            self.assert_source_unchanged()
            self.assertEqual(self.candidate_files(), files, 'no candidate artifacts/metadata mutated or published')
            self.assertEqual({p.name for p in root.iterdir()} if root.exists() else set(), directories)

    def test_distinct_moves_compose_without_changing_parent(self):
        for version in VERSIONS:
            with self.subTest(runtime=version), self.opened(version):
                _, parent = self.move(self.before, out_a=(460, 100), out_b=(520, 280))
                parent_files = self.candidate_files()
                self.move(parent, out_a=(500, 160), out_b=(580, 340), input=(100, 160))
                self.assertEqual({key: self.candidate_files()[key] for key in parent_files}, parent_files)
                self.reject(parent, self.positions(parent, out_a=(600, 200), out_b=(600, 200)), pattern='重叠')
                self.reject(parent, self.positions(parent, out_a=(100, 160)), pattern='重叠')
                self.reject(parent, self.positions(parent, out_a=(480, 100)),
                            artifactSha256=self.before['artifactSha256'])

    def test_swap_vacated_positions_is_simultaneous_in_either_request_order(self):
        for version in VERSIONS:
            with self.subTest(runtime=version), self.opened(version):
                # Either single move overlaps the stationary output. The joint
                # final layout is legal and must not be implemented as two moves.
                self.reject(self.before, self.positions(self.before, out_a=(400, 240)), pattern='重叠')
                self.reject(self.before, self.positions(self.before, out_b=(400, 120)), pattern='重叠')
                for targets in ({'out_a': (400, 240), 'out_b': (400, 120)},
                                {'out_b': (400, 120), 'out_a': (400, 240)}):
                    with self.subTest(order=list(targets)):
                        self.move(self.before, **targets)

    def test_invalid_positions_do_not_publish_or_change_parent(self):
        for version in VERSIONS:
            with self.subTest(runtime=version), self.opened(version):
                _, parent = self.move(self.before, out_a=(460, 100), out_b=(520, 280))
                target = self.positions(parent, out_a=(480, 120))[0]
                bad_positions = {
                    'empty': [], 'duplicate': [target, dict(target)],
                    'unknown': [{**target, 'componentId': 'missing-component'}],
                    'all unchanged': self.positions(parent, out_a=(460, 100), out_b=(520, 280)),
                    'missing coordinate': [{k: v for k, v in target.items() if k != 'y'}],
                }
                for axis in ('x', 'y'):
                    for value in (-10, 6010, 125, True, 120.5, '120'):
                        bad_positions[f'{axis}={value!r}'] = [{**target, axis: value}]
                for label, positions in bad_positions.items():
                    with self.subTest(rejection=label):
                        self.reject(parent, positions)
                for field, value in [('componentIds', [target['componentId']]), ('componentIds', []),
                                     ('wireIds', []), ('delta', {'x': 20, 'y': 20})]:
                    with self.subTest(mixed=field, value=value):
                        self.reject(parent, [target], **{field: value})
                # Rejection leaves the parent usable for another native run.
                self.assert_simulation(parent['candidateId'])


if __name__ == '__main__':
    unittest.main()
