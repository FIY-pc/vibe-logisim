"""Retained runtime evidence survives edits/restart but cannot cross projects."""
import runpy
import sys
import tempfile
import unittest
from pathlib import Path

REPO=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(REPO/'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace
fixture=runpy.run_path(str(REPO/'apps/desktop/test/simulation-instances.py'))['fixture']

class KeptMoments(unittest.TestCase):
    def test_capture_identity_restart_and_archive(self):
        with tempfile.TemporaryDirectory(prefix='vibe-kept-moments-') as tmp:
            root=Path(tmp);source=root/'pair.circ';source.write_text(fixture());original=source.read_bytes()
            def workspace():return Workspace(REPO,root/'state',REPO/'apps/desktop/circuit-lens/lensctl.py','moments')
            w=workspace()
            try:
                w.application.open_path(source);project=w.history.record['id'];revision=w.revision_id
                started=w.application.simulation_action({'projectId':project,'revisionId':revision,'action':'start','circuit':'Root'})
                sample=started['observation'];a=next(c for c in sample['components'] if c['label']=='A')
                kept=w.application.moments.action({'action':'capture','projectId':project,'revisionId':revision,'observationId':sample['id'],'signals':[a['componentId']+':0']})
                self.assertEqual(kept['signals'][0]['value'],0);self.assertTrue(kept['render']['url'].startswith('data:image/png;base64,'))
                self.assertIn(project,kept['signals'][0]['reference']);self.assertEqual(kept['sample']['id'],sample['id'])
                w.application.simulation_action({'projectId':project,'revisionId':revision,'sessionId':started['session']['id'],'action':'input','componentId':a['componentId'],'value':'1'})
                w.simulation.wait_frame(w.simulation.controls['commandSequence'])
                self.assertEqual(w.application.moments.read(project,kept['id'])['signals'][0]['value'],0)
                # A shortcut carries the exact displayed image, allowing capture
                # after bitmap eviction/stop. Its identity still comes from the
                # native sample; a substituted image must not be accepted.
                second=w.simulation.latest
                w.simulation.close()
                with self.assertRaisesRegex(ValueError,'不一致'):
                    w.application.moments.action({'action':'capture','projectId':project,'revisionId':revision,
                        'observationId':second['id'],'render':sample['render']})
                delayed=w.application.moments.action({'action':'capture','projectId':project,'revisionId':revision,
                    'observationId':second['id'],'render':second['render'],'signals':[a['componentId']+':0']})
                self.assertEqual(delayed['signals'][0]['value'],1)
                self.assertEqual(delayed['render'],second['render'])
                w.application.moments.action({'action':'archive','projectId':project,'id':delayed['id']})
                w.simulation.close();w.close();w=workspace();w.application.open_path(source)
                self.assertEqual(w.history.record['id'],project)
                read=w.workbench.call(revision,'read_kept_observation',{'observationId':kept['id'],'componentIds':[a['componentId']]})
                self.assertEqual(read['components'][0]['ports'][0]['value'],0)
                self.assertEqual(read['revisionId'],revision)
                self.assertEqual(w.application.moments.read(project,kept['id'])['render'],kept['render'])
                renamed=w.application.moments.action({'action':'rename','projectId':project,'id':kept['id'],'title':'输入之前'})
                self.assertEqual(renamed['title'],'输入之前');self.assertNotIn('render',renamed)
                w.application.moments.action({'action':'archive','projectId':project,'id':kept['id']})
                self.assertEqual(w.application.moments.list(project),[])
                self.assertTrue(w.application.moments.read(project,kept['id'])['archived'],'a conversation link remains readable')
                self.assertEqual(w.revision_id,revision);self.assertEqual(source.read_bytes(),original)
                copy=root/'other.circ';copy.write_bytes(original);w.application.open_path(copy)
                self.assertNotEqual(w.history.record['id'],project)
                with self.assertRaisesRegex(ValueError,'另一份工程'):w.application.moments.read(project,kept['id'])
                with self.assertRaisesRegex(ValueError,'引用无效'):w.application.moments.read(w.history.record['id'],'../outside')
            finally:w.close()

if __name__=='__main__':unittest.main()
