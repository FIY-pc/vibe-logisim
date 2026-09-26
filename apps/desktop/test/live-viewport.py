"""Compare a native viewport to the full live drawing and retained port values."""
import base64
import io
import json
import runpy
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageChops

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace

fixture = runpy.run_path(str(REPO / 'apps/desktop/test/simulation-instances.py'))['fixture']


def bitmap(frame):
    return Image.open(io.BytesIO(base64.b64decode(frame['render']['url'].split(',')[1]))).convert('RGBA')


def main():
    with tempfile.TemporaryDirectory(prefix='vibe-live-viewport-') as temporary:
        root = Path(temporary)
        source = root / 'pair.circ'
        source.write_text(fixture())
        original = source.read_bytes()
        w = Workspace(REPO, root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'live-render')
        try:
            w.application.open_path(source)
            revision = w.revision_id

            def act(action, **values):
                status = w.simulation.status()
                return w.application.simulation_action({
                    'projectId': w.history.record['id'], 'revisionId': revision,
                    'sessionId': status['session']['id'] if status['session'] else None,
                    'viewId': status['view']['id'] if status['view'] else None,
                    'action': action, **values})

            def sample():
                return w.simulation.wait_frame(w.simulation.controls['commandSequence'])

            started = act('start', circuit='Root')
            a = next(c for c in sample()['components'] if c['label'] == 'A')
            act('input', componentId=a['componentId'], value='1')
            full = sample()
            full_bounds = full['render']['bounds']
            assert full['render']['scale'] == 1.5
            region = dict(x=int(full_bounds['x']) + 20, y=int(full_bounds['y']) + 10,
                          width=220, height=80, scale=1.5)
            act('viewport', viewport=region)
            cropped = sample()
            actual = bitmap(cropped)
            expected = bitmap(full).crop((30, 15, 360, 135))
            assert actual.size == expected.size == (330, 120)
            delta = ImageChops.difference(actual, expected)
            assert delta.convert('RGB').getbbox() is None, 'Native crop differs from the same full live state'
            assert cropped['components'] == full['components']
            assert cropped['ticks'] == full['ticks'] == 0
            assert cropped['sessionId'] == started['session']['id']

            # Non-integral scaling must map every raster pixel back to world
            # coordinates, including the rounded final column and row.
            region.update(width=221, height=81, scale=2.375)
            act('viewport', viewport=region)
            rounded = sample()
            render = rounded['render']
            assert bitmap(rounded).size == (525, 193)
            assert abs(render['bounds']['width'] * region['scale'] - 525) < 1e-9
            assert abs(render['bounds']['height'] * region['scale'] - 193) < 1e-9
            # Browser JSON normalizes 24.0 to 24; saving the same viewport still works.
            displayed = json.loads(json.dumps(render))
            displayed['bounds']['x'] = int(displayed['bounds']['x'])
            assert w.simulation.frame_image(rounded['id'], displayed) == displayed

            sequence = w.simulation.controls['commandSequence']
            for invalid in ({**region, 'scale': float('nan')}, {**region, 'width': 9999999}):
                try:
                    act('viewport', viewport=invalid)
                    raise AssertionError('Invalid viewport accepted')
                except ValueError as error:
                    assert '超出限制' in str(error)
            assert w.simulation.controls['commandSequence'] == sequence
            left = next(c for c in w.circuit_view('Root')['circuit']['components'] if c['label'] == 'LEFT')
            nested = act('view', instancePath=[{'componentId': left['componentId']}])['observation']
            assert nested['render']['scale'] == 1.5, 'Viewport must reset when entering another instance'
            try:
                act('viewport', viewport=region, viewId=cropped['viewId'])
                raise AssertionError('Old instance viewport accepted')
            except ValueError as error:
                assert '视图已切换' in str(error)
            assert source.read_bytes() == original and w.revision_id == revision
            report = dict(nativeCropMatchesFullDrawingExactly=True, portsAndTicksUnchanged=True,
                          fractionalPixelMapping=True, browserSnapshotRoundtrip=True,
                          rejectsOversizeAndOldInstance=True, sourceUnchanged=True, modelTurns=0)
            output = REPO / 'apps/desktop/docs/product/evidence/2026-09-16-adaptive-render/native.json'
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(report, indent=2) + '\n')
            print(json.dumps(report))
        finally:
            w.close()


if __name__ == '__main__':
    main()
