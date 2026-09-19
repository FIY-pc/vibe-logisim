"""Model images must be legible on their own and belong to the current file.

Real native drawing, no model calls. Pillow is a test-only pixel decoder.
"""
import base64
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageChops

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace
from studio.domain.errors import LensError

SOURCE = b'''<?xml version="1.0" encoding="UTF-8"?>
<project source="2.16.2.2" version="1.0">
  <lib desc="#Wiring" name="0"/><main name="main"/>
  <circuit name="main">
    <comp lib="0" loc="(100,100)" name="Pin"><a name="label" val="Input"/></comp>
    <comp lib="0" loc="(260,100)" name="Pin">
      <a name="output" val="true"/><a name="facing" val="west"/><a name="label" val="Output"/>
    </comp>
    <wire from="(100,100)" to="(260,100)"/>
  </circuit>
</project>'''


class AgentRender(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='vibe-agent-render-')
        cls.root = Path(cls.temporary.name)
        cls.source = cls.root / 'design.circ'
        cls.source.write_bytes(SOURCE)
        cls.workspace = Workspace(REPO, cls.root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'agent-render')

    @classmethod
    def tearDownClass(cls):
        cls.workspace.close()
        cls.temporary.cleanup()

    def setUp(self):
        self.workspace.open_path(self.source)

    def render(self, **arguments):
        w = self.workspace
        result = w.application.agent_tool({
            'projectId': w.history.record['id'], 'revisionId': w.revision_id,
            'tool': 'render_circuit', 'arguments': arguments,
        })
        data = base64.b64decode(result['modelContentItems'][0]['imageData'], validate=True)
        return result, Image.open(io.BytesIO(data)).convert('RGBA')

    def test_full_and_crop_are_opaque_readable_and_cacheable(self):
        w = self.workspace
        revision = w.revision_id
        result, full = self.render()
        metadata = result['result']
        self.assertEqual(full.getchannel('A').getextrema(), (255, 255))
        self.assertEqual(full.getpixel((0, 0)), (255, 255, 255, 255))
        self.assertEqual(metadata['background'], 'white')
        # Known wire midpoint must remain visible, at the advertised coordinates.
        x = round((180 - metadata['region']['x']) * metadata['scale'])
        y = round((100 - metadata['region']['y']) * metadata['scale'])
        self.assertLess(max(full.getpixel((x, y))[:3]), 20)
        self.assertEqual(result['binding']['revisionId'], revision)
        self.assertEqual(result['binding']['runtimeProfileId'], metadata['runtimeProfileId'])
        with patch.object(w.renderer.worker, 'request', wraps=w.renderer.worker.request) as request:
            repeated, _ = self.render()
            self.assertEqual(repeated['result']['imageSha256'], metadata['imageSha256'])
            self.assertEqual(request.call_count, 0, 'repeat observation should reuse the native cache')
            self.assertTrue(repeated['modelContentItems'], 'repeat observations must still deliver images')
        _, crop = self.render(viewport={'x': 140, 'y': 80, 'width': 60, 'height': 40, 'scale': 2})
        self.assertEqual(crop.getchannel('A').getextrema(), (255, 255))
        self.assertEqual(crop.size, (120, 80))
        left = (140 - metadata['region']['x']) * 2
        top = (80 - metadata['region']['y']) * 2
        self.assertIsNone(ImageChops.difference(crop.convert('RGB'), full.crop((left, top, left+120, top+80)).convert('RGB')).getbbox())
        self.assertEqual(w.revision_id, revision)
        self.assertEqual(self.source.read_bytes(), SOURCE)

    def test_edit_changes_image_and_revision_without_changing_disk(self):
        w = self.workspace
        before, _ = self.render()
        try:
            component = w.circuit_view('main')['circuit']['components'][0]
            w.application.project_action('edit', {
                'projectId': w.history.record['id'], 'revisionId': w.revision_id,
                'circuit': 'main', 'componentId': component['componentId'],
                'attribute': 'label', 'value': 'Changed',
            })
            after, _ = self.render()
            self.assertNotEqual(after['result']['imageSha256'], before['result']['imageSha256'])
            self.assertNotEqual(after['binding']['revisionId'], before['binding']['revisionId'])
            self.assertEqual(after['binding']['artifactSha256'], w.artifact_sha256)
            self.assertEqual(self.source.read_bytes(), SOURCE)
        finally:
            w.history.undo(w.history.record['id'], w.revision_id)

    def test_delayed_image_rejects_project_switch_even_with_identical_bytes(self):
        w = self.workspace
        other = self.root / 'other.circ'
        other.write_bytes(SOURCE)
        native = w.renderer.render
        original_project, original_revision = w.history.record['id'], w.revision_id
        def switched(*args):
            data = native(*args)
            w.open_path(other)
            return data
        with patch.object(w.renderer, 'render', side_effect=switched):
            with self.assertRaises(LensError) as error:
                w.circuits_service.render_for_agent({})
        self.assertEqual(error.exception.code, 'STALE_RENDER')
        self.assertEqual(w.revision_id, original_revision)
        self.assertNotEqual(w.history.record['id'], original_project)

    def test_delayed_image_rejects_runtime_profile_change(self):
        w = self.workspace
        original_profile = w.observer.profile()
        current_profile = dict(original_profile)
        native = w.renderer.render
        def switched(*args):
            data = native(*args)
            current_profile['id'] = 'different-runtime-profile'
            return data
        with patch.object(w.observer, 'profile', side_effect=lambda: current_profile), patch.object(w.renderer, 'render', side_effect=switched):
            with self.assertRaises(LensError) as error:
                w.circuits_service.render_for_agent({})
        self.assertEqual(error.exception.code, 'STALE_RENDER')


if __name__ == '__main__':
    unittest.main()
