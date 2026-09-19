from __future__ import annotations



import hashlib
from pathlib import Path
import tempfile
import xml.etree.ElementTree as ET

class NativeOperations:
    def __init__(self, workspace, tools):
        self.workspace = workspace
        self.tools = tools

    def _native(self, artifact: Path, request: ET.Element, output: Path | None=None, *, runtime_jar=None):
        observer = self.workspace.observer
        runtime = runtime_jar or observer.runtime_jar
        if request.tag in {'component-catalog', 'component-template', 'place-component', 'check-existing-ports',
                           'property', 'memory', 'interface', 'check-interface', 'check-placement'}:
            return ET.fromstring(observer.worker.request(runtime, artifact, request, output))
        artifact_sha = hashlib.sha256(artifact.read_bytes()).hexdigest()
        runtime_sha = hashlib.sha256(runtime.read_bytes()).hexdigest()
        source = self.workspace.repo_root / 'apps/desktop/circuit-lens/native/com/cburch/logisim/file/CircuitWorkbench.java'
        memory = source.parents[1] / 'std/memory/StudioMemory.java'
        interface = source.with_name('CircuitInterface.java')
        sources = [source, memory, interface, source.with_name("CircuitPalette.java"), source.with_name("CircuitObjects.java")]
        sources.append(observer.attribute_adapter)
        key = hashlib.sha256(b''.join(p.read_bytes() for p in sources) + runtime.read_bytes()).hexdigest()
        classes = self.workspace.state_root / 'native-cache' / key
        with observer._compile_lock:
            if not (classes / 'com/cburch/logisim/file/CircuitWorkbench.class').is_file():
                classes.mkdir(parents=True, exist_ok=True)
                result = observer._run_captured(['javac', '-encoding', 'UTF-8', '-cp', str(runtime), '-d', str(classes), *map(str,sources)], timeout=60)
                if result.returncode:
                    raise ValueError(result.stderr[-4000:])
        with tempfile.TemporaryDirectory(prefix='native-request-', dir=self.workspace.state_root) as directory:
            request_path = Path(directory) / 'request.xml'
            request_path.write_bytes(ET.tostring(request, encoding='utf-8'))
            result = observer._run_captured(['java', '-Djava.awt.headless=true', '-cp', str(classes) + ':' + str(runtime), 'com.cburch.logisim.file.CircuitWorkbench', str(artifact), str(request_path), str(output or '')], timeout=60)
            if result.returncode:
                raise ValueError('Logisim: ' + result.stderr[-4000:])
            response = ET.fromstring(result.stdout)
            if (response.get('runtimeJarSha256') != runtime_sha
                    or response.get('artifactSha256') != artifact_sha
                    or not response.get('runtimeVersion')):
                raise ValueError('Native execution identity does not match the requested runtime and artifact')
            return response
