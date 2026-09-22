"""A serial warm JVM for isolated native simulation and trace requests."""
from __future__ import annotations

import base64
import os
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import xml.etree.ElementTree as ET

from studio.infrastructure.files import sha256_bytes, sha256_file
from studio.domain.tool_errors import CircuitToolError


class SimulationWorker:
    """Reuse only the JVM; load a fresh artifact for every request.

    Native failures terminate the process. This is deliberately separate from
    NativeWorker, whose cached LogisimFile objects are safe for read-only
    static observation but unsafe for simulation stimuli.
    """

    def __init__(self, repo_root: Path, state_root: Path):
        root = repo_root / 'apps/desktop/circuit-lens'
        native = root / 'native/com/cburch/logisim/file'
        self.sources = [
            native / name for name in (
                'CircuitSimulationWorker.java', 'CircuitWorkbench.java',
                'NativeCircuitLoader.java', 'CircuitInterface.java',
                'CircuitPalette.java', 'CircuitObjects.java',
            )
        ]
        self.sources.append(root / 'native/com/cburch/logisim/std/memory/StudioMemory.java')
        self.sources.append(root / 'observer/src/com/cburch/logisim/circuit/NativeAttributeAdapter.java')
        self.sources.append(root / 'observer/src/com/cburch/logisim/circuit/NativePortSemantics.java')
        self.cache_root = state_root / 'simulation-worker-cache'
        self.lock = threading.Lock()
        self.process: subprocess.Popen[str] | None = None
        self.responses: queue.Queue[str] | None = None
        self.stderr_reader: threading.Thread | None = None
        self.stderr_tail = bytearray()
        self.binding: tuple[str, str] | None = None
        self.closed = False
        self.starts = 0

    def _stop(self) -> None:
        process, self.process = self.process, None
        self.binding = None
        if process is not None:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            if self.stderr_reader:
                self.stderr_reader.join(timeout=.5)
            for stream in (process.stdin, process.stdout, process.stderr):
                try:
                    stream.close()
                except (OSError, ValueError):
                    pass

    def close(self) -> None:
        with self.lock:
            self.closed = True
            self._stop()

    def _classes(self, runtime: Path, runtime_sha: str) -> Path:
        key = sha256_bytes(b''.join(path.read_bytes() for path in self.sources) + runtime_sha.encode())
        target = self.cache_root / key / 'classes'
        if (target / 'com/cburch/logisim/file/CircuitSimulationWorker.class').is_file():
            return target
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = Path(tempfile.mkdtemp(prefix='compile-', dir=target.parent))
        try:
            result = subprocess.run(
                ['javac', '-encoding', 'UTF-8', '-cp', str(runtime), '-d', str(temporary),
                 *map(str, self.sources)], capture_output=True, text=True, timeout=60,
            )
            if result.returncode:
                raise ValueError(result.stderr[-4000:])
            if not target.exists():
                temporary.rename(target)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
        return target

    def _failure(self, code: str, message: str, phase: str, request_context=None) -> CircuitToolError:
        detail = bytes(self.stderr_tail[-8192:]).decode('utf-8', errors='replace').strip()
        context = {
            'service': 'simulation-worker',
            'phase': phase,
            'workerStopped': True,
        }
        if code == 'NATIVE_RUNTIME_TIMEOUT':
            context['timeoutSeconds'] = 60
        if isinstance(request_context, dict):
            context.update({key: value for key, value in request_context.items() if value is not None})
        return CircuitToolError(
            code,
            message + (': ' + detail if detail else ''),
            hint='原生运行服务已停止并会在下一次调用时重启；这不是电路功能通过或失败的结论。',
            context=context,
        )

    def _receive(self, phase: str = 'request', request_context=None) -> bytes:
        assert self.responses is not None
        try:
            line = self.responses.get(timeout=60)
        except queue.Empty:
            error = self._failure('NATIVE_RUNTIME_TIMEOUT', '仿真服务响应超时（60 秒）', phase, request_context)
            self._stop()
            raise error from None
        if not line:
            error = self._failure('NATIVE_RUNTIME_EXITED', '仿真服务已结束', phase, request_context)
            self._stop()
            raise error
        try:
            status, encoded = line.split('\t', 1)
            value = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as error:
            self._stop()
            raise self._failure('NATIVE_RUNTIME_PROTOCOL', '仿真服务返回了无效协议', phase, request_context) from error
        if status == 'error':
            self._stop()
            raise ValueError(value.decode('utf-8', errors='replace'))
        if status != 'ok':
            self._stop()
            raise self._failure('NATIVE_RUNTIME_PROTOCOL', '仿真服务返回了未知状态', phase, request_context)
        return value

    def _start(self, runtime: Path, runtime_sha: str) -> None:
        self._stop()
        classes = self._classes(runtime, runtime_sha)
        self.process = subprocess.Popen(
            ['java', '-Xmx768m', '-Djava.awt.headless=true', '-cp',
             os.pathsep.join((str(classes), str(runtime))),
             'com.cburch.logisim.file.CircuitSimulationWorker', str(runtime), runtime_sha],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', errors='replace', bufsize=1,
            start_new_session=(os.name != 'nt'),
        )
        process = self.process
        self.responses = queue.Queue(maxsize=2)
        self.stderr_tail = bytearray()

        def read_stderr() -> None:
            try:
                while True:
                    chunk = process.stderr.buffer.read1(1024)
                    if not chunk:
                        return
                    self.stderr_tail.extend(chunk)
                    del self.stderr_tail[:-8192]
            except (OSError, ValueError):
                return

        def read_stdout() -> None:
            try:
                while True:
                    line = process.stdout.readline(48_000_000)
                    if not line:
                        self.responses.put('')
                        return
                    if not line.endswith('\n'):
                        self.responses.put('')
                        return
                    self.responses.put(line.rstrip('\n'))
            except (OSError, ValueError, queue.Full):
                try:
                    self.responses.put_nowait('')
                except queue.Full:
                    pass

        self.stderr_reader = threading.Thread(target=read_stderr, daemon=True)
        self.stderr_reader.start()
        threading.Thread(target=read_stdout, daemon=True).start()
        if self._receive('startup') != b'ready':
            self._stop()
            raise self._failure('NATIVE_RUNTIME_START_FAILED', '仿真服务未就绪', 'startup')
        self.binding = (str(runtime.resolve()), runtime_sha)
        self.starts += 1

    def request(self, runtime: Path, artifact: Path, operation: ET.Element) -> bytes:
        with self.lock:
            if self.closed:
                raise RuntimeError('仿真服务已关闭')
            runtime = runtime.resolve()
            runtime_sha = sha256_file(runtime)
            artifact_sha = sha256_file(artifact)
            request_context = {
                'operation': operation.tag,
                'circuit': operation.get('circuit'),
                'artifactSha256': artifact_sha,
            }
            try:
                if self.binding != (str(runtime), runtime_sha) or self.process is None or self.process.poll() is not None:
                    self._start(runtime, runtime_sha)
                envelope = ET.Element('request', artifact=str(artifact.resolve()), digest=artifact_sha)
                envelope.append(operation)
                payload = base64.b64encode(ET.tostring(envelope, encoding='utf-8')).decode('ascii')
                assert self.process is not None and self.process.stdin is not None
                self.process.stdin.write(payload + '\n')
                self.process.stdin.flush()
                return self._receive('request', request_context)
            except (BrokenPipeError, ConnectionResetError):
                error = self._failure('NATIVE_RUNTIME_DISCONNECTED', '仿真服务连接中断', 'request', request_context)
                self._stop()
                raise error from None
            except Exception:
                # Domain errors from this worker are intentionally terminal.
                self._stop()
                raise
