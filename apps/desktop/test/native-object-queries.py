"""A proposed or failed edit must not change the resident native snapshot."""
import json
from pathlib import Path
import shutil
import sys
import tempfile
from unittest.mock import patch
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
sys.path.insert(0, str(REPO / 'apps/desktop/test'))
from support.samples import requires_samples
requires_samples(REPO, 'exports/interface-editing/stage6-if-id.circ', 'exports/interface-editing/cs3410.jar', 'exports/interface-editing/riscv-probe.jar')
from studio.application.workspace import Workspace

root = Path(tempfile.mkdtemp(prefix='vibe-native-objects-'))
source = root / 'course.circ'
fixture = '''<circuit name="objects"><comp lib="4" name="ROM" loc="(400,200)">
<a name="addrWidth" val="8"/><a name="dataWidth" val="32"/><a name="label" val="ROM"/>
<a name="contents">addr/data: 8 32
a5a5a5a5 12345678</a></comp>
<comp lib="0" name="Pin" loc="(100,100)"><a name="label" val="A"/></comp></circuit>'''
source.write_text((REPO / 'exports/interface-editing/stage6-if-id.circ').read_text().replace('</project>', fixture + '</project>'))
for name in ('cs3410.jar', 'riscv-probe.jar'):
    shutil.copyfile(REPO / 'exports/interface-editing' / name, root / name)
w = Workspace(REPO, root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'native-objects')

try:
    w.application.open_path(source)
    original, revision = source.read_bytes(), w.revision_id
    baseline = w.observer.run_full(w.frozen_path, 'objects')
    worker = w.observer.worker
    starts = worker.starts

    def query(kind, **attrs):
        request = ET.Element(kind, circuit='objects', factory='ROM', x='400', y='200', **attrs)
        return w.workbench._native(w.frozen_path, request)

    def page():
        return ET.tostring(query('memory', offset='0', count='4'))

    before = page()
    # Resize and rename validation changes only cloned attribute sets.
    for attr, value in [('label', '临时名称'), ('dataWidth', '8'), ('addrWidth', '7')]:
        assert query('property', attribute=attr, value=value).text == value
        assert page() == before
    draft = query('property', attribute='contents', address='0', expected='a5a5a5a5', value='ffffffff').text
    assert 'ffffffff' in draft
    assert page() == before, 'Unapplied ROM proposal changed cached memory'
    for attrs in [dict(attribute='contents', address='0', expected='0', value='ff'),
                  dict(attribute='contents', address='256', expected='0', value='1'),
                  dict(attribute='contents', address='0', expected='a5a5a5a5', value='100000000'),
                  dict(attribute='contents', address='0', expected='a5a5a5a5', value='ffffffffffffffff'),
                  dict(attribute='missing', value='bad')]:
        try:
            query('property', **attrs)
            raise AssertionError('Invalid property accepted')
        except ValueError:
            pass
        assert page() == before
    assert w.observer.run_full(w.frozen_path, 'objects') == baseline

    # A native proposal can succeed before durable preparation fails. The next
    # read must still show the original snapshot, not the rejected ROM contents.
    rom = next(c for c in w.circuit_view('objects')['circuit']['components'] if c['factory'] == 'ROM')
    def body(**attrs):
        return dict(projectId=w.history.record['id'], revisionId=w.revision_id, circuit='objects', **attrs)
    change = dict(componentId=rom['componentId'], attribute='contents', address=0, expected='a5a5a5a5', value='ffffffff')
    with patch.object(w.project_store, 'freeze_circuit', side_effect=OSError('injected disk failure')):
        try:
            w.application.project_action('edit', body(**change))
            raise AssertionError('Injected preparation failure was ignored')
        except OSError:
            pass
    assert w.revision_id == revision and source.read_bytes() == original and page() == before
    w.application.project_action('edit', body(**change))
    w.application.project_action('save', body())
    assert query('memory', offset='0', count='1').find('memory/word').get('value') == str(0xffffffff)
    actual = w.observer.run_full(w.frozen_path, 'objects')
    fresh = w.observer._run_json([str(w.observer.full_runner), '--full', str(w.frozen_path), 'objects'],
                                w.observer._environment(w.observer.prepare()))
    actual['observer'].pop('bundleSha256'); fresh['observer'].pop('bundleSha256')
    assert actual == fresh, 'Committed ROM differs from fresh native load'
    w.application.project_action('undo', body()); w.application.project_action('save', body())
    assert w.revision_id == revision and source.read_bytes() == original and page() == before

    # Both sides of an interface comparison come from separately bound snapshots.
    circuit = w.project_store.document.circuit('objects')
    pin = circuit.find("comp[@name='Pin']")
    ET.SubElement(pin, 'a', name='width', val='8')
    changed = w.project_store.freeze_circuit(circuit)
    try:
        w.workbench._native(w.frozen_path, ET.Element('check-interface', circuit='objects'), changed.frozen_path)
        raise AssertionError('Changed external interface accepted')
    except ValueError:
        pass
    w.workbench._native(w.frozen_path, ET.Element('check-interface', circuit='objects'), w.frozen_path)
    assert worker.starts == starts
    assert page() == before and source.read_bytes() == original
    # Exercise the retained standalone command compiler too; this operation
    # still intentionally owns a separate simulation process.
    request = ET.Element('simulate', circuit='objects')
    vector = ET.SubElement(request, 'vector'); ET.SubElement(vector, 'input', name='A', value='0')
    assert w.workbench._native(w.frozen_path, request).find('vector').get('oscillating') == 'false'
    report = dict(root=str(root), success=True, modelTurns=0, unsubmittedEditsIsolated=True,
                  failedPreparationIsolated=True, romCommitNativeParity=True, undoRestoresBytes=True,
                  rejectedInterfaceIsolated=True, workerStartsDuringQueries=worker.starts-starts,
                  standaloneSimulationRetained=True)
    (root / 'result.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
finally:
    w.close()
