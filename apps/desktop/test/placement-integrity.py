"""Fast placement must still use the course loader's electrical/interface checks."""
from pathlib import Path
import sys, tempfile, xml.etree.ElementTree as ET
from unittest.mock import patch
REPO=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(REPO/'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace
root=Path(tempfile.mkdtemp(prefix='vibe-placement-integrity-'));source=root/'test.circ'
text=(REPO/'apps/desktop/electron/templates/blank.circ').read_text().replace('<circuit name="main"/>','<circuit name="main"><comp lib="0" name="Pin" loc="(200,200)"><a name="width" val="8"/></comp></circuit>')
text=text.replace('</project>', '<circuit name="child"><comp lib="0" name="Pin" loc="(100,100)"/><comp lib="0" name="Pin" loc="(100,200)"/></circuit><circuit name="parent"><comp name="child" loc="(500,500)"/></circuit></project>')
source.write_text(text)
w=Workspace(REPO,root/'state',REPO/'apps/desktop/circuit-lens/lensctl.py','placement-integrity')
try:
 w.open_path(source);original=source.read_bytes();revision=w.revision_id
 assert len(w.circuit_view('main')['circuit']['components'])==1
 def body(**extra):return dict(projectId=w.history.record['id'],revisionId=w.revision_id,circuit='main',library='0',tool='Tunnel',attributes={'width':'1','label':'BUS'},x=200,y=200,**extra)
 # A different-width port on an existing eight-bit pin cannot be published.
 try:w.application.project_action('place',body());raise AssertionError('width mismatch accepted')
 except ValueError as e:assert '位宽' in str(e),str(e)
 assert w.revision_id==revision and source.read_bytes()==original
 # Automatic symbol changes must not move existing parent ports.
 pin=dict(projectId=w.history.record['id'],revisionId=w.revision_id,circuit='child',library='0',tool='Pin',attributes={},x=100,y=150)
 try:w.application.project_action('place',pin);raise AssertionError('parent ports moved')
 except ValueError as e:assert '接口' in str(e),str(e)
 assert w.revision_id==revision
 # Snapshot write failure also leaves both native baseline and source unchanged.
 valid=body();valid['attributes']['width']='8'
 with patch.object(w.project_store,'freeze_circuit',side_effect=OSError('disk full')):
  try:w.application.project_action('place',valid);raise AssertionError('disk failure ignored')
  except OSError:pass
 assert w.revision_id==revision
 # Read-only validation rejection must not poison the worker for the next edit.
 w.application.project_action('place',valid);w.application.project_action('save',dict(projectId=w.history.record['id'],revisionId=w.revision_id))
 scene=w.circuit_view('main')['circuit'];assert len(scene['components'])==2
 pin=next(c for c in scene['components'] if c['factory']=='Pin');tunnel=next(c for c in scene['components'] if c['factory']=='Tunnel')
 assert pin['ends'][0]['netBits']==tunnel['ends'][0]['netBits'] and len(pin['ends'][0]['netBits'])==8
 assert not scene['widthIncompatibilities']
 committed=w.observer.run_full(w.frozen_path,'main')
 fresh=w.observer._run_json([str(w.observer.full_runner),'--full',str(w.frozen_path),'main'],w.observer._environment(w.observer.prepare()))
 for doc in (committed,fresh):doc['observer'].pop('bundleSha256');doc['observer'].pop('sourcePath',None)
 import json
 (root/'resident.json').write_text(json.dumps(committed,ensure_ascii=False));(root/'fresh.json').write_text(json.dumps(fresh,ensure_ascii=False))
 # Label bounds depend on whether native drawing has initialized font metrics.
 # Compare the complete electrical/attribute observation, not those draw caches.
 for doc in (committed,fresh):
  doc['focus'].pop('bounds')
  for component in doc['focus']['components']:component.pop('bounds')
  for circuit in doc['project']['circuits']:circuit.pop('bounds')
 assert committed==fresh,'electrical observation differs from independent native reload: '+str(root)
 for kind in ('undo','save'):w.application.project_action(kind,dict(projectId=w.history.record['id'],revisionId=w.revision_id))
 assert source.read_bytes()==original
 print({'root':str(root),'widthMismatchRejected':True,'failurePreserved':True,'nativeReloadMatches':True,'undoExact':True})
finally:w.close()
