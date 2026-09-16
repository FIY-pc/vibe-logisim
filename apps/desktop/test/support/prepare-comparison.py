"""Create an isolated review of two existing course artifacts, without a model."""
import json
import shutil
import sys
from pathlib import Path
REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO/'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace

root = Path(sys.argv[1]); root.mkdir(parents=True, exist_ok=True)
for name in ['stage6-if-id.circ', 'cs3410.jar', 'riscv-probe.jar']:
    shutil.copy(REPO/'exports/if-id-collaboration'/name, root/name)
w = Workspace(REPO, root/'state', REPO/'apps/desktop/circuit-lens/lensctl.py', 'comparison-e2e')
try:
    w.application.open_path(root/'stage6-if-id.circ')
    candidate = w.workbench.call(w.revision_id, 'submit_circuit', {
        'title':'IF_ID 布局与控制线整理（已有电路版本）',
        'circuitXml':(REPO/'exports/branch-editing/stage6-if-id.circ').read_text()})
    (root/'fixture.json').write_text(json.dumps({'candidateId':candidate['id'], 'projectId':w.history.record['id'], 'revisionId':w.revision_id}))
    print(root)
finally: w.close()
