"""Discovery correctness at the production tool boundary; no Java or model."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest

DESKTOP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DESKTOP / 'circuit-lens'))
from studio.application.tools import Workbench
from studio.domain.tool_errors import CircuitToolError


def fixture(count=90):
    components = [{'componentId': f'c{i}', 'factory': 'Pin', 'label': '中文🙂\\"\n' * (i % 8),
                   'ends': [{'index': 0, 'width': None if i % 3 else 32, 'direction': None,
                             'netBits': [], 'runtimeTooltip': None}], 'location': {'x': i * 10, 'y': 0},
                   'attributes': {}, 'bounds': {}, 'subcircuit': None} for i in range(count)]
    view = {'revision': {'artifactSha256': 'a' * 64}, 'circuit': {
        'name': 'main', 'components': components, 'wires': [], 'nets': [], 'widthIncompatibilities': []},
        'capabilities': {'exactConnectivity': True, 'observationProfile': {'id': 'native-fixture'}},
        'unknowns': [{'claim': '功能与驱动未知🙂'}], 'observerError': None}
    w = SimpleNamespace(revision_id='r1', artifact_sha256='a' * 64,
                        history=SimpleNamespace(record={'id': 'p1'}), lock=threading.RLock(),
                        raw_project={'circuits': []}, circuits=lambda: {}, package=SimpleNamespace(resources=[]),
                        circuit_view=lambda name: view)
    return Workbench(w), view


def call(wb, options=None, **args):
    return wb.call(wb.workspace.revision_id, 'inspect_circuit', {
        'circuit': 'main', **({'componentDirectory': options} if options is not None else {}), **args},
        project_id=wb.workspace.history.record['id'], thread_id='thread-中文', turn_id='t', call_id='c')


class Discovery(unittest.TestCase):
    def test_pages_budget_full_entries_projection_and_details(self):
        wb, view = fixture()
        original = deepcopy(view)
        cursor, pages, found = None, [], []
        while True:
            result = call(wb, {'maxBytes': 1800, **({'cursor': cursor} if cursor else {})})
            pages.append(result)
            self.assertLessEqual(result['page']['bytes'], 1800)
            self.assertEqual(result['page']['bytes'], len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode()))
            self.assertEqual(result['page']['offset'], len(found))
            self.assertEqual(result['page']['returned'], len(result['components']))
            self.assertTrue(result['components'])
            found.extend(result['components'])
            cursor = result['page']['nextCursor']
            if not cursor:
                break
        expected = [{**{k: c[k] for k in ('componentId', 'factory', 'label')},
                     'ends': [{k: e[k] for k in ('index', 'width', 'direction')} for e in c['ends']]}
                    for c in original['circuit']['components']]
        self.assertEqual(found, expected)
        self.assertEqual(len({c['componentId'] for c in found}), len(found))
        # Production model projection and JSON.stringify must preserve every
        # directory fact and match the byte count, including Unicode/escapes.
        subprocess.run(['node', '-e', '''
const assert = require('node:assert/strict');
const {dynamicToolResponse} = require('./electron/model-tool-output.cjs');
for (const page of JSON.parse(require('node:fs').readFileSync(0,'utf8'))) {
  const text = dynamicToolResponse(page).contentItems[0].text;
  assert.deepEqual(JSON.parse(text), page);
  assert.equal(Buffer.byteLength(text), page.page.bytes);
}
'''], cwd=DESKTOP, input=json.dumps(pages).encode(), check=True)
        details = call(wb, componentIds=[found[45]['componentId']])
        self.assertEqual(details['components'][0]['ends'], original['circuit']['components'][45]['ends'])
        self.assertIn('connectivityIssues', details)
        self.assertEqual(view, original)

    def test_stale_observations_and_identity_never_continue(self):
        mutations = [
            lambda w, v: setattr(w, 'revision_id', 'r2'),
            lambda w, v: w.history.record.update(id='p2'),
            lambda w, v: (setattr(w, 'artifact_sha256', 'b' * 64), v['revision'].update(artifactSha256='b' * 64)),
            lambda w, v: v['capabilities']['observationProfile'].update(id='other-runtime'),
            lambda w, v: v['circuit']['components'].reverse(),
            lambda w, v: v['circuit']['components'][50].update(label='changed'),
            lambda w, v: v['circuit'].update(nets=[{'unknown': True}]),
            lambda w, v: v['unknowns'].append({'claim': 'new unknown'}),
        ]
        for mutate in mutations:
            wb, view = fixture()
            cursor = call(wb, {'maxBytes': 1800})['page']['nextCursor']
            mutate(wb.workspace, view)
            with self.assertRaises(CircuitToolError) as caught:
                call(wb, {'cursor': cursor})
            self.assertEqual(caught.exception.code, 'STALE_COMPONENT_CURSOR')
            self.assertFalse(caught.exception.retryable)

    def test_malformed_empty_and_oversized_pages(self):
        wb, _ = fixture(0)
        page = call(wb, {})
        self.assertEqual(page['components'], [])
        self.assertIsNone(page['page']['nextCursor'])
        for options in ({'cursor': ''}, {'cursor': 'd1:broken:1'}, {'cursor': None},
                        {'maxBytes': True}, {'maxBytes': 32001}, {'unknown': 1}):
            with self.assertRaises(CircuitToolError):
                call(wb, options)
        wb, view = fixture()
        first = call(wb, {'maxBytes': 1800})
        cursor = first['page']['nextCursor']
        for invalid in (cursor.rsplit(':', 1)[0] + ':99999', cursor.rsplit(':', 1)[0] + ':0'):
            with self.assertRaises(CircuitToolError):
                call(wb, {'cursor': invalid})
        # A later oversized item must not be silently skipped or repeated in
        # an empty successful page. It is available through the old full path.
        view['circuit']['components'][5]['label'] = '大' * 20000
        first = call(wb, {})
        self.assertEqual(first['page']['returned'], 5)
        with self.assertRaises(CircuitToolError) as caught:
            call(wb, {'cursor': first['page']['nextCursor']})
        self.assertEqual(caught.exception.code, 'COMPONENT_DIRECTORY_BUDGET')
        self.assertEqual(caught.exception.context['componentId'], 'c5')
        self.assertGreater(caught.exception.context['requiredBytes'], 32000)
        self.assertEqual(call(wb, componentIds=['c5'])['components'][0]['label'], '大' * 20000)
        empty, view = fixture(0)
        view['unknowns'] = ['?' * 33000]
        with self.assertRaises(CircuitToolError) as caught:
            call(empty, {})
        self.assertEqual(caught.exception.code, 'COMPONENT_DIRECTORY_BUDGET')

    def test_unknown_ports_and_observation_not_mutated(self):
        wb, view = fixture(1)
        view['circuit']['components'][0]['ends'] = []
        self.assertEqual(call(wb, {})['components'][0]['ends'], [])
        view['observerError'] = 'native unavailable'
        view['capabilities']['exactConnectivity'] = False
        old = deepcopy(view)
        page = call(wb, {})
        self.assertIsNone(page['components'][0]['ends'])
        self.assertEqual(page['authority'], 'geometry-only')
        self.assertEqual(page['error'], old['observerError'])
        self.assertEqual(page['unknowns'], old['unknowns'])
        self.assertEqual(view, old)
        self.assertEqual(call(wb)['error'], old['observerError'])
        self.assertIsNone(call(wb)['stimulusSchema'])

    def test_full_path_and_live_observation_remain_full(self):
        wb, view = fixture(1)
        sample = {'id': 's1', 'sessionId': 's', 'circuit': 'main', 'instancePath': [],
                  'components': [{'componentId': 'c0', 'value': None}]}
        wb.workspace.simulation = SimpleNamespace(observation=lambda *a: deepcopy(sample))
        full = wb.call('r1', 'inspect_circuit', {'circuit': 'main', 'includeNets': True}, 's1')
        self.assertEqual(full['displayedSimulation'], sample)
        self.assertEqual(full['components'][0]['ends'], view['circuit']['components'][0]['ends'])
        self.assertIn('reference', full['components'][0])
        compact = wb.call('r1', 'inspect_circuit', {'circuit': 'main', 'componentDirectory': {}}, 's1')
        self.assertNotIn('displayedSimulation', compact)
        self.assertNotIn('reference', compact['components'][0])
        self.assertEqual(wb.workspace.simulation.observation(), sample)
        for extra in ({'componentIds': []}, {'includeNets': False}, {'includeWires': True}, {'wireOffset': 0}):
            with self.assertRaises(CircuitToolError):
                call(wb, {}, **extra)
        with self.assertRaises(CircuitToolError):
            wb.call('r1', 'inspect_circuit', {'componentDirectory': {}})

    def test_candidate_and_actual_digest(self):
        wb, view = fixture()
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            data = b'<project><main name="main"/><circuit name="main"/></project>'
            (directory / 'artifact.circ').write_bytes(data)
            digest = hashlib.sha256(data).hexdigest()
            document = {'revision': {'artifactSha256': digest}}
            wb._metadata = lambda candidate: (directory, {})
            wb.workspace.observer = SimpleNamespace(run_full=lambda *a: document, profile=lambda: {})
            wb.workspace._transform_exact = lambda *a: view
            page = call(wb, {'maxBytes': 1800}, candidateId='candidate-a')
            self.assertEqual(page['artifactSha256'], digest)
            with self.assertRaises(CircuitToolError) as caught:
                call(wb, {'cursor': page['page']['nextCursor']}, candidateId='candidate-b')
            self.assertEqual(caught.exception.code, 'STALE_COMPONENT_CURSOR')
            document['revision']['artifactSha256'] = 'f' * 64
            with self.assertRaises(CircuitToolError) as caught:
                call(wb, {}, candidateId='candidate-a')
            self.assertEqual(caught.exception.code, 'STALE_COMPONENT_OBSERVATION')


if __name__ == '__main__':
    unittest.main()
