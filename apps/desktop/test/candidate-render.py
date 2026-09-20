"""Real two-JAR candidates and opaque previews; no model or source checkout."""
import base64
from copy import deepcopy
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace
from studio.domain.errors import LensError
from studio.domain.tool_errors import CircuitToolError


def fixture(version):
    return f'''<project source="{version}" version="1.0">
      <lib name="0" desc="#Wiring"/><lib name="1" desc="#I/O"/><main name="main"/>
      <circuit name="main">
        <comp lib="0" name="Pin" loc="(100,100)"><a name="label" val="Input"/></comp>
        <comp lib="0" name="Pin" loc="(260,100)"><a name="output" val="true"/>
          <a name="facing" val="west"/><a name="label" val="Output"/></comp>
        <wire from="(100,100)" to="(100,160)"/><wire from="(100,160)" to="(260,160)"/>
        <wire from="(260,160)" to="(260,100)"/>
      </circuit><circuit name="untouched"><comp lib="0" name="Pin" loc="(80,80)"/></circuit>
    </project>'''.encode()


def file_hashes(directory):
    return {str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in directory.rglob('*') if p.is_file()}


class CandidateRender(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='vibe-candidate-render-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name)
        cls.w = Workspace(REPO, cls.root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'candidate-render')
        cls.addClassCleanup(cls.w.close)
        cls.cases = []
        for version in ('2.16.2.2', '2.15.0'):
            source = cls.root / (version + '.circ')
            source.write_bytes(fixture(version))
            cls.w.open_path(source)
            inspected = cls.call('inspect_circuit', {'circuit': 'main', 'includeWires': True})
            component = next(c['componentId'] for c in inspected['components'] if c['label'] == 'Input')
            wired = cls.call('wire_candidate', {'title': 'Preview wire candidate', 'circuit': 'main',
                'additions': [{'id': 'indicator', 'factory': 'LED', 'location': {'x': 360, 'y': 220}}],
                'connections': [{'name': 'Input to indicator', 'from': {'component': component, 'port': 0}, 'to': {'component': 'indicator', 'port': 0}}]})
            rerouted = cls.call('reroute_candidate', {'title': 'Preview reroute candidate', 'circuit': 'main', 'artifactSha256': inspected['artifactSha256'],
                'wireIds': [wire['wireId'] for wire in inspected['wireGeometry']['wires']]})
            cls.cases.append((source, wired, rerouted))

    @classmethod
    def tearDownClass(cls):
        cls.w.close()
        cls.temp.cleanup()

    @classmethod
    def call(cls, tool, args):
        return cls.w.application.agent_tool({'projectId': cls.w.history.record['id'], 'revisionId': cls.w.revision_id,
                                           'tool': tool, 'arguments': args})

    def setUp(self):
        self.source, self.candidate, _ = self.cases[0]
        self.w.open_path(self.source)

    def test_both_runtimes_wire_and_reroute_full_and_viewport(self):
        evidence = Path(os.environ['VIBE_CANDIDATE_RENDER_EVIDENCE']) if os.environ.get('VIBE_CANDIDATE_RENDER_EVIDENCE') else None
        records = []
        for source, wired, rerouted in self.cases:
            self.w.open_path(source)
            revision = self.w.revision_id
            before = deepcopy(self.w.circuit_view('main')['circuit'])
            source_bytes = source.read_bytes()
            default = self.call('render_circuit', {})
            for candidate in (wired, rerouted):
                directory, _ = self.w.workbench._metadata(candidate['id'])
                frozen = file_hashes(directory)
                for region in (None, {'x': 0, 'y': 0, 'width': 400, 'height': 300, 'scale': 2}):
                    result = self.call('render_circuit', {'candidateId': candidate['id'], **({'viewport': region} if region else {})})
                    metadata, binding = result['result'], result['binding']
                    image = Image.open(io.BytesIO(base64.b64decode(result['modelContentItems'][0]['imageData']))).convert('RGBA')
                    self.assertEqual(image.getchannel('A').getextrema(), (255, 255))
                    self.assertEqual(image.getpixel((0, 0)), (255, 255, 255, 255))
                    self.assertLess(min(image.convert('RGB').getextrema()[0]), 100)
                    self.assertEqual(binding['candidateId'], candidate['id'])
                    self.assertEqual(binding['artifactSha256'], candidate['artifactSha256'])
                    self.assertEqual(metadata['artifactSha256'], hashlib.sha256((directory / 'artifact.circ').read_bytes()).hexdigest())
                    self.assertEqual(binding['baseRevisionId'], revision)
                    self.assertEqual(binding['revisionId'], revision)
                    self.assertEqual(binding['currentArtifactSha256'], self.w.artifact_sha256)
                    self.assertEqual(binding['runtimeProfile'], metadata['runtimeProfile'])
                    self.assertEqual(metadata['runtimeProfile']['runtimeJarSha256'], hashlib.sha256(self.w.observer.runtime_jar.read_bytes()).hexdigest())
                    self.assertEqual(metadata['runtimeProfile']['status'], 'observed')
                    if region:
                        self.assertEqual(image.size, (800, 600))
                    if evidence:
                        evidence.mkdir(parents=True, exist_ok=True)
                        stem = source.stem + '-' + ('wire' if candidate is wired else 'reroute') + '-' + metadata['kind']
                        image.save(evidence / (stem + '.png'))
                        (evidence / (stem + '.json')).write_text(json.dumps(result, ensure_ascii=False))
                    records.append({'runtime': source.stem, 'candidate': 'wire' if candidate is wired else 'reroute',
                                    'kind': metadata['kind'], 'opaqueWhite': True, 'binding': binding,
                                    'imageSha256': metadata['imageSha256'], 'bytes': metadata['bytes']})
                # A definition with no change metadata remains renderable.
                self.call('render_circuit', {'candidateId': candidate['id'], 'circuit': 'untouched'})
                self.assertEqual(file_hashes(directory), frozen)
            self.assertEqual(self.call('render_circuit', {})['result'], default['result'])
            self.assertEqual(self.w.circuit_view('main')['circuit'], before)
            self.assertEqual(self.w.revision_id, revision)
            self.assertEqual(source.read_bytes(), source_bytes)
        if evidence:
            (evidence / 'native-summary.json').write_text(json.dumps({'records': records, 'sourceAndCandidatesUnchanged': True,
                'noCheckout': True, 'modelCalls': 0}, ensure_ascii=False, indent=2))

    def test_owner_base_and_current_file_rejection(self):
        candidate_id = self.candidate['id']
        other = self.root / 'identical-other.circ'
        other.write_bytes(self.source.read_bytes())
        self.w.open_path(other)
        with self.assertRaises(CircuitToolError):
            self.call('render_circuit', {'candidateId': candidate_id})
        self.w.open_path(self.source)
        component = self.w.circuit_view('main')['circuit']['components'][0]
        try:
            self.w.application.project_action('edit', {'projectId': self.w.history.record['id'], 'revisionId': self.w.revision_id,
                'circuit': 'main', 'componentId': component['componentId'], 'attribute': 'label', 'value': 'Edited'})
            with self.assertRaises(CircuitToolError):
                self.call('render_circuit', {'candidateId': candidate_id})
        finally:
            self.w.history.undo(self.w.history.record['id'], self.w.revision_id)

    def test_tamper_before_and_after_cached_render(self):
        args = {'candidateId': self.candidate['id']}
        self.call('render_circuit', args)
        directory, _ = self.w.workbench._metadata(self.candidate['id'])
        artifact = directory / 'artifact.circ'
        original = artifact.read_bytes()
        try:
            artifact.write_bytes(original + b'\n')
            with self.assertRaises(CircuitToolError):
                self.call('render_circuit', args)
            artifact.write_bytes(original)
            native = self.w.renderer.render
            def changed(*args):
                result = native(*args)
                artifact.write_bytes(original + b'\n')
                return result
            with patch.object(self.w.renderer, 'render', side_effect=changed):
                with self.assertRaises(CircuitToolError):
                    self.call('render_circuit', args)
        finally:
            artifact.write_bytes(original)

    def test_dependency_digest_and_candidate_identity_rejection(self):
        directory, metadata = self.w.workbench._metadata(self.candidate['id'])
        manifest = directory / 'candidate.json'
        original = manifest.read_bytes()
        dependency = directory / 'test-dependency.bin'
        try:
            dependency.write_bytes(b'changed')
            metadata['dependencies'] = [{'name': dependency.name, 'sha256': hashlib.sha256(b'frozen').hexdigest()}]
            manifest.write_text(json.dumps(metadata))
            with self.assertRaises(CircuitToolError) as caught:
                self.call('render_circuit', {'candidateId': self.candidate['id']})
            self.assertIn('组件库已被外部修改', str(caught.exception))
            metadata['dependencies'] = []
            metadata['id'] = 'candidate-' + 'f' * 16
            manifest.write_text(json.dumps(metadata))
            with self.assertRaises(CircuitToolError) as caught:
                self.call('render_circuit', {'candidateId': self.candidate['id']})
            self.assertEqual(caught.exception.code, 'STALE_RENDER')
        finally:
            manifest.write_bytes(original)
            dependency.unlink()

    def test_profile_and_backend_change_even_with_same_runtime_path(self):
        w = self.w
        args = {'candidateId': self.candidate['id']}
        native = w.renderer.render
        original_worker = w.renderer.worker
        current_profile = dict(w.observer.profile())
        for change in (lambda: current_profile.update(id='changed-profile'),
                       lambda: setattr(w.renderer, 'worker', object())):
            current_profile = dict(w.observer.profile())
            def changed(*values):
                data = native(*values)
                change()
                return data
            try:
                with patch.object(w.observer, 'profile', side_effect=lambda *a: current_profile), patch.object(w.renderer, 'render', side_effect=changed):
                    with self.assertRaises(LensError) as caught:
                        w.circuits_service.render_for_agent(args)
                self.assertEqual(caught.exception.code, 'STALE_RENDER')
            finally:
                w.renderer.worker = original_worker

    def test_runtime_switch_before_and_during_render(self):
        runtime = self.w.observer.runtime_jar
        other = REPO / 'workspaces/hust-riscv/original/course-package/logisim-ita-cn-20200118.exe'
        args = {'candidateId': self.candidate['id']}
        try:
            self.w.observer.runtime_jar = other
            with self.assertRaises(LensError):
                self.w.circuits_service.render_for_agent(args)
            self.w.observer.runtime_jar = runtime
            native = self.w.renderer.render
            def switched(*args):
                result = native(*args)
                self.w.observer.runtime_jar = other
                return result
            with patch.object(self.w.renderer, 'render', side_effect=switched):
                with self.assertRaises(LensError) as caught:
                    self.w.circuits_service.render_for_agent(args)
            self.assertEqual(caught.exception.code, 'STALE_RENDER')
        finally:
            self.w.observer.runtime_jar = runtime

    def test_file_switch_and_external_change_during_render(self):
        original = self.source.read_bytes()
        other = self.root / 'during-render.circ'
        other.write_bytes(original)
        args = {'candidateId': self.candidate['id']}
        native = self.w.renderer.render
        for action in (lambda: self.w.open_path(other), lambda: self.source.write_bytes(original + b'\n')):
            self.w.open_path(self.source)
            def changed(*values):
                data = native(*values)
                action()
                return data
            try:
                with patch.object(self.w.renderer, 'render', side_effect=changed):
                    with self.assertRaises(LensError) as caught:
                        self.w.circuits_service.render_for_agent(args)
                self.assertEqual(caught.exception.code, 'STALE_RENDER')
            finally:
                self.source.write_bytes(original)


if __name__ == '__main__':
    unittest.main()
