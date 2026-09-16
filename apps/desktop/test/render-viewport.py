"""Check viewport alignment against an independent full native drawing, and
reject a delayed native result after the real project changes underneath it.
No model calls or source-file writes.
"""
import io
import json
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path

from PIL import Image, ImageChops

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace
from studio.domain.errors import LensError


def main():
    with tempfile.TemporaryDirectory(prefix='vibe-native-render-') as temporary:
        root = Path(temporary)
        for name in ('stage6-if-id.circ', 'cs3410.jar', 'riscv-probe.jar'):
            shutil.copy(REPO / 'exports/branch-editing' / name, root / name)
        source = root / 'stage6-if-id.circ'
        original = source.read_bytes()
        w = Workspace(REPO, root/'state', REPO/'apps/desktop/circuit-lens/lensctl.py', 'native-render')
        try:
            w.application.open_path(source)
            scene = w.circuit_view('IF_ID')['circuit']
            render = scene['render']
            values = dict(name='IF_ID', revisionId=w.revision_id, profileId=render['profileId'],
                          x=500, y=100, width=300, height=220, scale=2)
            start = time.perf_counter()
            data = w.circuits_service.render_viewport(values)
            cold_ms = (time.perf_counter()-start)*1000
            pid = w.observer.worker.process.pid
            actual = Image.open(io.BytesIO(data)).convert('RGB')
            assert actual.size == (600, 440)
            png = next((w.revision_dir/'exact'/render['profileId']).glob('*.png'))
            full = Image.open(png).convert('RGBA')
            paper = Image.new('RGBA', full.size, 'white'); paper.alpha_composite(full)
            x, y = (values['x']-render['bounds']['x'])*2, (values['y']-render['bounds']['y'])*2
            expected = paper.convert('RGB').crop((x, y, x+600, y+440))
            difference = ImageChops.difference(actual, expected)
            # Java's opaque/alpha surfaces can round antialiasing differently.
            pixels = iter(difference.tobytes())
            significant = sum(max(rgb)>16 for rgb in zip(pixels, pixels, pixels))
            ratio = significant/(actual.width*actual.height)
            assert ratio < .005, f'Viewport does not align with full native drawing: {ratio}'
            assert w.circuits_service.render_viewport(values) == data
            warm_ms = []
            for offset in (10, 20, 30):
                start = time.perf_counter()
                w.circuits_service.render_viewport({**values, 'x':values['x']+offset})
                warm_ms.append((time.perf_counter()-start)*1000)
                assert w.observer.worker.process.pid == pid
            try:
                w.circuits_service.render_viewport({**values, 'scale':'nan'})
                raise AssertionError('Non-finite size accepted')
            except LensError as error:
                assert error.code == 'INVALID_VIEWPORT'
            w.observer.worker.process.kill(); w.observer.worker.process.wait()
            assert w.circuits_service.render_viewport(values) == data
            w.circuits_service.render_viewport({**values, 'x':values['x']+40})
            assert w.observer.worker.process.pid != pid

            native = w.renderer.render
            ready, release = threading.Event(), threading.Event()
            outcome = []
            def delayed(*args):
                result = native(*args); ready.set()
                assert release.wait(30)
                return result
            w.renderer.render = delayed
            def request():
                try: outcome.append(w.circuits_service.render_viewport(values))
                except Exception as error: outcome.append(error)
            thread = threading.Thread(target=request)
            thread.start(); assert ready.wait(30)
            component = next(c for c in scene['components'] if c['factory']=='Register' and c['label']=='ID.PC')
            try:
                w.application.project_action('edit', {'projectId':w.history.record['id'], 'revisionId':w.revision_id,
                    'circuit':'IF_ID', 'componentId':component['componentId'], 'attribute':'label', 'value':'Temporary render race'})
            finally: release.set(); thread.join(30)
            assert len(outcome)==1 and isinstance(outcome[0], LensError) and outcome[0].code=='STALE_RENDER', outcome
            assert source.read_bytes()==original
            report = {'nativeCropSize':[600,440], 'significantPixelDifferenceRatio':ratio,
                      'coldCompileLoadDrawMs':round(cold_ms,1), 'warmUncachedDrawMs':[round(t,1) for t in warm_ms],
                      'reusesNativeProcess':True, 'recoversAfterProcessDeath':True,
                      'rejectsResultAfterConcurrentEdit':True, 'sourceUnchanged':True, 'modelTurns':0}
            output=REPO/'apps/desktop/docs/product/evidence/2026-09-15-hierarchy-rendering/native.json'
            output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
            print(json.dumps(report,ensure_ascii=False))
        finally: w.close()


if __name__ == '__main__': main()
