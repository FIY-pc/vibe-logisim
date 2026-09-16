"""Resident runtime parity, cache ownership, crash recovery and source protection.

Uses temporary course copies. No model calls or changes to course originals.
"""
import copy
import json
from pathlib import Path
import shutil
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace

root = Path(tempfile.mkdtemp(prefix='vibe-worker-'))
source = root / 'course.circ'
source.write_text((REPO / 'exports/interface-editing/stage6-if-id.circ').read_text().replace(
    '</project>', '<circuit name="manual"/></project>'))
for name in ('cs3410.jar', 'riscv-probe.jar'):
    shutil.copyfile(REPO / 'exports/interface-editing' / name, root / name)
w = Workspace(REPO, root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'worker-acceptance')

def body(**extra):
    return dict(projectId=w.history.record['id'], revisionId=w.revision_id, circuit='manual', **extra)

try:
    w.application.open_path(source)
    observer = w.observer
    # The original one-shot executable remains an independent parity oracle.
    expected = observer._run_json([str(observer.full_runner), '--full', str(w.frozen_path), 'IF_ID'],
                                 observer._environment(observer.prepare()))
    actual = observer.run_full(w.frozen_path, 'IF_ID')
    expected['observer'].pop('bundleSha256'); actual['observer'].pop('bundleSha256')
    assert actual == expected, 'Resident native observation differs from the standalone runtime'
    palette = w.application.placement
    identity = palette.catalog_identity()
    palette.query('catalog', body())
    template = palette.query('template', body(library='1', tool='AND Gate', attributes={'inputs':'2'}))
    starts = observer.worker.starts
    timings = []
    for x in (400, 500, 600):
        start = time.perf_counter()
        w.application.project_action('place', body(library='1', tool='AND Gate', attributes={'inputs':'2'}, x=x, y=300))
        w.application.project_action('save', body())
        view = w.circuit_view('manual')
        timings.append(round((time.perf_counter()-start)*1000, 1))
        assert palette.catalog_identity() == identity, 'Ordinary placement invalidated the component catalog'
        # Templates are independent of gate positions, but returned ownership must
        # always use the latest revision, even when the payload came from cache.
        cached = palette.query('template', body(library='1', tool='AND Gate', attributes={'inputs':'2'}))
        assert cached['revisionId'] == w.revision_id
        assert cached['ports'] == template['ports']
    assert len(view['circuit']['components']) == 3
    assert observer.worker.starts == starts, 'An edit restarted the runtime'

    # Incrementally prepared documents must mean exactly the same thing when
    # loaded from disk through the independent, non-cached native executable.
    expected = observer._run_json([str(observer.full_runner), '--full', str(w.frozen_path), 'manual'],
                                 observer._environment(observer.prepare()))
    actual = observer.run_full(w.frozen_path, 'manual')
    expected['observer'].pop('bundleSha256'); actual['observer'].pop('bundleSha256')
    assert actual == expected, 'Local edits differ from a fresh native load'
    saved = source.read_bytes()
    prefix = (REPO / 'exports/interface-editing/stage6-if-id.circ').read_bytes().split(b'</project>')[0]
    assert saved.startswith(prefix), 'Placement rewrote unrelated course modules'
    w.application.project_action('undo', body())
    assert len(w.circuit_view('manual')['circuit']['components']) == 2
    w.application.project_action('place', body(library='1', tool='AND Gate', attributes={'inputs':'2'}, x=600, y=300))
    w.application.project_action('save', body())
    assert source.read_bytes() == saved, 'Editing after undo did not reproduce the same bytes'
    component = w.circuit_view('manual')['circuit']['components'][0]
    w.application.project_action('edit', body(componentId=component['componentId'], attribute='label', value='手动 & gate'))
    w.application.project_action('save', body())
    assert any(c['label'] == '手动 & gate' for c in w.circuit_view('manual')['circuit']['components'])
    w.application.project_action('undo', body())
    w.application.project_action('save', body())
    assert source.read_bytes() == saved, 'Attribute undo did not restore the source exactly'

    # Bad requests do not change the file or poison the read-only service.
    revision, original = w.revision_id, source.read_bytes()
    try:
        w.application.project_action('place', body(library='1', tool='AND Gate', attributes={}, x=400, y=300))
        raise AssertionError('Duplicate placement accepted')
    except ValueError: pass
    assert w.revision_id == revision and source.read_bytes() == original
    assert observer.worker.starts == starts

    # The source guard still hashes contents, including dependencies. It cannot
    # be fooled by preserving file size and timestamp.
    import os
    for file in (source, root / 'cs3410.jar'):
        content = file.read_bytes(); stat = file.stat()
        altered = bytes([content[0] ^ 1]) + content[1:]
        file.write_bytes(altered); os.utime(file, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        assert w.history.disk_status()['changed'], 'Content change missed'
        try:
            w.application.project_action('save', body())
            raise AssertionError('External change overwritten')
        except ValueError: pass
        assert file.read_bytes() == altered
        file.write_bytes(content)
        assert not w.history.disk_status()['changed']

    observer.worker.process.kill(); observer.worker.process.wait()
    recovered = palette.query('template', body(library='1', tool='AND Gate', attributes={'label':'recovered'}))
    assert recovered['factory'] == 'AND Gate' and observer.worker.starts == starts+1
    assert source.read_bytes() == original
    report = dict(root=str(root), success=True, modelTurns=0, nativeParity=True,
                  editedNativeParity=True, unrelatedModulesByteIdentical=True, editAfterUndo=True,
                  attributeEditAndUndo=True,
                  workerRestartsDuringEdits=0, externalChangesProtected=True, crashRecovery=True,
                  coursePlaceSaveReadMilliseconds=timings)
    (root / 'result.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
finally:
    w.close()
