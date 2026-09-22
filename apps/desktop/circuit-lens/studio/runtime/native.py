from __future__ import annotations



import hashlib
from pathlib import Path
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from studio.domain.tool_errors import CircuitToolError

class NativeOperations:
    def __init__(self, workspace, tools):
        self.workspace = workspace
        self.tools = tools

    @staticmethod
    def _runtime_failure(code, message, request, artifact_sha, runtime_sha, phase):
        context = {
            'service': 'native-command',
            'phase': phase,
            'operation': request.tag,
            'circuit': request.get('circuit'),
            'artifactSha256': artifact_sha,
            'runtimeJarSha256': runtime_sha,
            'workerStopped': True,
        }
        if code == 'NATIVE_RUNTIME_TIMEOUT':
            context['timeoutSeconds'] = 60
        return CircuitToolError(
            code,
            message,
            hint='原生命令没有产生有效结果；这不是电路功能通过或失败的结论。',
            context=context,
        )

    def _native(self, artifact: Path, request: ET.Element, output: Path | None=None, *, runtime_jar=None):
        observer = self.workspace.observer
        runtime = runtime_jar or observer.runtime_jar
        if request.tag in {'simulate', 'trace'}:
            artifact_sha = hashlib.sha256(artifact.read_bytes()).hexdigest()
            runtime_sha = hashlib.sha256(runtime.read_bytes()).hexdigest()
            response = ET.fromstring(observer.simulation_worker.request(runtime, artifact, request))
            if (response.get('runtimeJarSha256') != runtime_sha
                    or response.get('artifactSha256') != artifact_sha
                    or not response.get('runtimeVersion')):
                raise ValueError('Native execution identity does not match the requested runtime and artifact')
            return response
        if request.tag in {'component-catalog', 'component-template', 'component-templates', 'place-component', 'check-existing-ports',
                           'property', 'edit-components', 'memory', 'interface', 'check-interface', 'check-placement'}:
            return ET.fromstring(observer.worker.request(runtime, artifact, request, output))
        artifact_sha = hashlib.sha256(artifact.read_bytes()).hexdigest()
        runtime_sha = hashlib.sha256(runtime.read_bytes()).hexdigest()
        source = self.workspace.repo_root / 'apps/desktop/circuit-lens/native/com/cburch/logisim/file/CircuitWorkbench.java'
        memory = source.parents[1] / 'std/memory/StudioMemory.java'
        interface = source.with_name('CircuitInterface.java')
        sources = [source, source.with_name("NativeCircuitLoader.java"), memory, interface, source.with_name("CircuitPalette.java"), source.with_name("CircuitObjects.java")]
        sources.append(observer.attribute_adapter)
        sources.append(observer.port_semantics)
        key = hashlib.sha256(b''.join(p.read_bytes() for p in sources) + runtime.read_bytes()).hexdigest()
        classes = self.workspace.state_root / 'native-cache' / key
        with observer._compile_lock:
            if not (classes / 'com/cburch/logisim/file/CircuitWorkbench.class').is_file():
                classes.mkdir(parents=True, exist_ok=True)
                try:
                    result = observer._run_captured(['javac', '-encoding', 'UTF-8', '-cp', str(runtime), '-d', str(classes), *map(str,sources)], timeout=60)
                except subprocess.TimeoutExpired as error:
                    raise self._runtime_failure(
                        'NATIVE_RUNTIME_TIMEOUT', '原生 CircuitWorkbench 编译超时（60 秒）',
                        request, artifact_sha, runtime_sha, 'compile',
                    ) from error
                if result.returncode:
                    raise ValueError(result.stderr[-4000:])
        with tempfile.TemporaryDirectory(prefix='native-request-', dir=self.workspace.state_root) as directory:
            request_path = Path(directory) / 'request.xml'
            request_path.write_bytes(ET.tostring(request, encoding='utf-8'))
            try:
                result = observer._run_captured(['java', '-Djava.awt.headless=true', '-cp', str(classes) + ':' + str(runtime), 'com.cburch.logisim.file.CircuitWorkbench', str(artifact), str(request_path), str(output or '')], timeout=60)
            except subprocess.TimeoutExpired as error:
                raise self._runtime_failure(
                    'NATIVE_RUNTIME_TIMEOUT', '原生 CircuitWorkbench 响应超时（60 秒）',
                    request, artifact_sha, runtime_sha, 'request',
                ) from error
            if result.returncode:
                raise ValueError('Logisim: ' + result.stderr[-4000:])
            try:
                response = ET.fromstring(result.stdout)
            except ET.ParseError as error:
                raise self._runtime_failure(
                    'NATIVE_RUNTIME_PROTOCOL', '原生 CircuitWorkbench 返回了无效 XML',
                    request, artifact_sha, runtime_sha, 'request',
                ) from error
            if (response.get('runtimeJarSha256') != runtime_sha
                    or response.get('artifactSha256') != artifact_sha
                    or not response.get('runtimeVersion')):
                raise ValueError('Native execution identity does not match the requested runtime and artifact')
            return response
