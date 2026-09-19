"""Actual JAR identity, transient stimuli and the published standalone Java recipe."""
import hashlib
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace

RUNTIMES = [
    ('2.16.2.2', REPO / 'apps/desktop/circuit-lens/native/Logisim-ITA.jar'),
    ('2.15.0', REPO / 'workspaces/hust-riscv/original/course-package/logisim-ita-cn-20200118.exe'),
]

def fixture(version):
    return f'''<project source="{version}" version="1.0"><lib name="0" desc="#Wiring"/>
    <main name="main"/><circuit name="main">
    <comp name="Pin" lib="0" loc="(80,80)"><a name="label" val="In"/><a name="width" val="8"/></comp>
    <comp name="Pin" lib="0" loc="(180,80)"><a name="label" val="Out"/><a name="width" val="8"/>
    <a name="output" val="true"/><a name="facing" val="west"/></comp>
    <wire from="(80,80)" to="(180,80)"/></circuit></project>'''

class RuntimeExecution(unittest.TestCase):
    def test_both_runtimes_and_standalone_recipe(self):
        reference = (REPO / 'apps/desktop/circuit-knowledge/java-runtime.md').read_text()
        java = re.search(r'```java\n(.*?)\n```', reference, re.S)[1]
        with tempfile.TemporaryDirectory(prefix='vibe-runtime-execution-') as directory:
            root = Path(directory)
            source = root / 'PinCheck.java'
            source.write_text(java)
            workspace = Workspace(REPO, root/'state', REPO/'apps/desktop/circuit-lens/lensctl.py', 'runtime-check')
            try:
                for version, jar in RUNTIMES:
                    with self.subTest(runtime=version):
                        artifact = root/(version+'.circ')
                        original = fixture(version).encode()
                        artifact.write_bytes(original)
                        workspace.open_path(artifact)
                        def call(tool, arguments):
                            return workspace.application.agent_tool({'projectId':workspace.history.record['id'],
                                'revisionId':workspace.revision_id, 'tool':tool, 'arguments':arguments})
                        args = {'circuit':'main','vectors':[{'inputs':{'In':v},'expected':{'Out':v}} for v in [0,1,128,255]]}
                        report = call('simulate_circuit', args)
                        self.assertEqual(report['passed'], 4)
                        self.assert_execution(report, jar, artifact)
                        evaluated = call('evaluate_circuit', {**args,'mode':'simulate'})
                        self.assertEqual(evaluated['binding']['runtimeProfile'], report['runtimeProfile'])
                        observed = call('inspect_circuit', {'circuit':'main'})
                        output = next(c for c in observed['components'] if c['label']=='Out')
                        trace_args = {'circuit':'main','ticks':2,'inputs':{'In':0},
                            'watches':[{'component':output['componentId'],'port':0,'name':'out'}]}
                        trace = call('trace_circuit', trace_args)
                        self.assertEqual([r['values']['out'] for r in trace['rows']], [0,0,0])
                        self.assert_execution(trace, jar, artifact)
                        experiment = call('harness_run', {**trace_args,'mode':'trace',
                            'inputEvents':[{'tick':1,'name':'In','value':253}]})
                        self.assertEqual([r['values']['out'] for r in experiment['result']['rows']], [0,253,253])
                        self.assertEqual(experiment['binding']['runtimeProfile'], trace['runtimeProfile'])
                        # Exercise a non-current runtime explicitly, as historical comparisons do.
                        other_jar = next(j for _,j in RUNTIMES if j!=jar)
                        historic = workspace.workbench.runtime._trace_artifact(
                            {'circuit':'main','ticks':1,'inputs':{'In':7},'watches':[
                                {'component':output['componentId'],'port':0,'name':'out'}]},
                            artifact, hashlib.sha256(original).hexdigest(), other_jar)
                        self.assert_execution(historic, other_jar, artifact)
                        subprocess.run(['javac','-encoding','UTF-8','-cp',str(jar),'-d',str(root),str(source)],
                            capture_output=True, text=True, check=True, timeout=30)
                        for value, exit_code, output_text in [('255',0,'Out=1111 1111'),('256',1,'out-of-range')]:
                            result = subprocess.run(['java','-Djava.awt.headless=true','-cp',f'{jar}:{root}',
                                'PinCheck',str(artifact),'main',f'In={value}'],capture_output=True,text=True,timeout=5)
                            self.assertEqual(result.returncode,exit_code,result.stderr)
                            self.assertIn(output_text,result.stdout+result.stderr)
                        self.assertEqual(artifact.read_bytes(), original, 'simulation must not save input stimuli')
                # A native response with mismatched identity must not become successful evidence.
                run = workspace.observer._run_captured
                def wrong_identity(command, **kwargs):
                    result = run(command, **kwargs)
                    if command[0]=='java':
                        result.stdout = re.sub(r'runtimeJarSha256="[^"]+"', 'runtimeJarSha256="wrong"', result.stdout)
                    return result
                with patch.object(workspace.observer, '_run_captured', side_effect=wrong_identity):
                    with self.assertRaisesRegex(ValueError,'execution identity'):
                        workspace.workbench.simulate(args)
            finally:
                workspace.close()

    def assert_execution(self, report, jar, artifact):
        self.assertEqual(report['execution']['runtimeJarSha256'],hashlib.sha256(jar.read_bytes()).hexdigest())
        self.assertEqual(report['execution']['artifactSha256'],hashlib.sha256(artifact.read_bytes()).hexdigest())
        self.assertEqual(report['runtimeProfile']['status'],'observed')
        self.assertEqual(report['runtimeProfile']['runtimeJarSha256'],report['execution']['runtimeJarSha256'])
        self.assertEqual(report['runtimeProfile']['reportedVersion'],report['execution']['runtimeVersion'])
        self.assertEqual(report['binding']['runtimeProfile'],report['runtimeProfile'])

if __name__=='__main__': unittest.main()
