"""One bounded, read-only native process per runtime, shared by editing queries.

It accepts immutable snapshots and never owns the current revision. Mutations
and simulation stay outside this process; a restart only loses derived caches.
"""
from __future__ import annotations

import base64
from collections import deque
import os
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import xml.etree.ElementTree as ET

from studio.infrastructure.files import sha256_file, sha256_bytes


class NativeWorker:
    def __init__(self, repo_root, state_root):
        root = repo_root / 'apps/desktop/circuit-lens'
        self.sources = [root / 'native/com/cburch/logisim/file' / name for name in (
            'NativeCircuitLoader.java', 'CircuitWorker.java', 'CircuitPalette.java', 'CircuitRenderer.java', 'CircuitObjects.java', 'CircuitInterface.java')]
        self.sources.append(root / 'native/com/cburch/logisim/std/memory/StudioMemory.java')
        self.sources.append(root / 'observer/src/com/cburch/logisim/circuit/ExactRuntimeObserver.java')
        self.sources.append(root / 'observer/src/com/cburch/logisim/circuit/NativeAttributeAdapter.java')
        self.cache_root = state_root / 'worker-cache'
        self.lock = threading.Lock()
        self.process = None
        self.binding = None
        self.closed = False
        self.starts = 0
        self.stderr_tail = deque(maxlen=8)
        self.stderr_reader = None

    def _stop(self):
        if self.process:
            process, self.process = self.process, None
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait()
            if self.stderr_reader:
                self.stderr_reader.join(timeout=0.5)
            process.stdin.close(); process.stdout.close(); process.stderr.close()
        self.binding = None

    def _failure(self, message):
        process = self.process
        if process is not None:
            try:
                code = process.wait(timeout=0.2)
            except subprocess.TimeoutExpired:
                code = None
            if code is not None:
                message += f'（退出码 {code}）'
                if self.stderr_reader:
                    self.stderr_reader.join(timeout=0.5)
        detail = ''.join(tuple(self.stderr_tail)).strip()
        return RuntimeError(message + (': ' + detail if detail else ''))

    def close(self):
        with self.lock:
            self.closed = True
            self._stop()

    def _classes(self, runtime, runtime_sha):
        key = sha256_bytes(b''.join(p.read_bytes() for p in self.sources) + runtime_sha.encode())
        target = self.cache_root / key / 'classes'
        if (target / 'com/cburch/logisim/file/CircuitWorker.class').is_file(): return target
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = Path(tempfile.mkdtemp(prefix='compile-', dir=target.parent))
        try:
            result = subprocess.run(['javac', '-encoding', 'UTF-8', '-cp', str(runtime),
                '-d', str(temporary), *map(str, self.sources)], capture_output=True, text=True, timeout=60)
            if result.returncode: raise ValueError(result.stderr[-4000:])
            # Another workspace can prepare the same runtime concurrently.
            if not target.exists(): temporary.rename(target)
        finally:
            if temporary.exists(): shutil.rmtree(temporary)
        return target

    def _receive(self):
        try: line = self.responses.get(timeout=60)
        except queue.Empty: raise self._failure('原生编辑服务响应超时') from None
        if not line: raise self._failure('原生编辑服务已结束')
        status, payload = line.split('\t', 1)
        value = base64.b64decode(payload, validate=True)
        if status == 'error': raise ValueError(value.decode('utf-8', errors='replace'))
        if status != 'ok': raise RuntimeError('无效的原生编辑响应')
        return value

    def _start(self, runtime, digest):
        self._stop()
        classes = self._classes(runtime, digest)
        self.process = subprocess.Popen(['java', '-Xmx768m', '-Djava.awt.headless=true', '-cp',
            os.pathsep.join([str(classes), str(runtime)]), 'com.cburch.logisim.file.CircuitWorker',
            str(runtime), digest, str(classes)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace', bufsize=1)
        process, responses = self.process, queue.Queue(maxsize=2)
        self.responses = responses
        tail = deque(maxlen=8)
        self.stderr_tail = tail
        def read_stderr():
            try:
                while chunk := process.stderr.read(1024):
                    tail.append(chunk)
            except (ValueError, OSError):
                return
        self.stderr_reader = threading.Thread(target=read_stderr, daemon=True)
        self.stderr_reader.start()
        def read():
            try:
                while True:
                    line = process.stdout.readline(48_000_000)
                    if line and not line.endswith('\n'): line = ''
                    responses.put_nowait(line.rstrip('\n'))
                    if not line: return
            except (ValueError, OSError, queue.Full): return
        threading.Thread(target=read, daemon=True).start()
        if self._receive() != b'ready': raise RuntimeError('原生编辑服务未就绪')
        self.binding = (runtime, digest)
        self.starts += 1

    def request(self, runtime, artifact, operation, output=None):
        with self.lock:
            if self.closed: raise RuntimeError('原生编辑服务已关闭')
            digest = sha256_file(runtime)
            try:
                if self.binding != (runtime, digest) or self.process.poll() is not None:
                    self._start(runtime, digest)
                envelope = ET.Element('request', artifact=str(artifact), digest=sha256_file(artifact))
                if output:
                    envelope.set('output', str(output))
                    if operation.tag in {'check-existing-ports', 'check-interface', 'check-placement'}:
                        envelope.set('outputDigest', sha256_file(output))
                envelope.append(operation)
                payload = base64.b64encode(ET.tostring(envelope, encoding='utf-8')).decode()
                self.process.stdin.write(payload + '\n'); self.process.stdin.flush()
                return self._receive()
            except ValueError:
                # A native domain rejection does not poison the loaded snapshots.
                raise
            except (BrokenPipeError, ConnectionResetError):
                error = self._failure('原生编辑服务连接中断')
                self._stop()
                raise error from None
            except Exception:
                self._stop()
                raise
