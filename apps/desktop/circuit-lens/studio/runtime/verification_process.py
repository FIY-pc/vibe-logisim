"""Bounded process I/O for workspace verification on the supported POSIX host.

Log previews and structured results have different budgets. Ordinary logs are
drained until exit/deadline, retaining their beginning and end. A JSON verdict
must be captured in full or explicitly rejected. No reader thread may outlive
the call or block stream.close() after the original process has exited.
"""
from __future__ import annotations

from dataclasses import dataclass
import os
import selectors
import signal
import subprocess
import time


PREVIEW_BYTES = 16 * 1024
JSON_RESULT_BYTES = 1024 * 1024
READ_BYTES = 64 * 1024
TRUNCATED = "\n…(输出已截断，保留开头和结尾)\n"


class _Capture:
    def __init__(self, limit: int, *, tail: bool):
        self.limit = limit
        self.keep_tail = tail
        self.total = 0
        self.head = bytearray()
        self.tail = b""

    def append(self, chunk: bytes):
        self.total += len(chunk)
        head_limit = self.limit // 2 if self.keep_tail else self.limit
        self.head.extend(chunk[:max(0, head_limit - len(self.head))])
        if self.keep_tail:
            self.tail = (self.tail + chunk)[-self.limit // 2:]

    def content(self) -> bytes:
        if not self.keep_tail or self.total <= len(self.head):
            return bytes(self.head)
        remaining = min(self.total, self.limit) - len(self.head)
        return bytes(self.head) + self.tail[-remaining:]

    def preview(self) -> str:
        value = self.content()
        if self.total <= PREVIEW_BYTES:
            return value.decode('utf-8', errors='replace')
        half = PREVIEW_BYTES // 2
        return (value[:half].decode('utf-8', errors='replace') + TRUNCATED
                + value[-half:].decode('utf-8', errors='replace'))


@dataclass(frozen=True)
class ProcessOutput:
    exit_code: int | None
    timed_out: bool
    output_limited: bool
    stdout: str
    stderr: str
    json_output: bytes | None
    stdout_bytes: int
    stderr_bytes: int


def _kill_group(process):
    # The leader can already have exited while descendants hold the pipes.
    # Always address its session's process group, never only a live leader.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def execute_verifier(command, *, cwd, environment, timeout, json_status=False) -> ProcessOutput:
    if os.name != 'posix':
        raise OSError('外部验证器当前需要 POSIX 进程与管道支持')
    stdout = _Capture(JSON_RESULT_BYTES if json_status else PREVIEW_BYTES, tail=not json_status)
    stderr = _Capture(PREVIEW_BYTES, tail=True)
    with subprocess.Popen(command, cwd=cwd, env=environment, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          start_new_session=True) as process, selectors.DefaultSelector() as selector:
        for stream, capture in ((process.stdout, stdout), (process.stderr, stderr)):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, capture)
        deadline = time.monotonic() + timeout
        timed_out = output_limited = False
        try:
            # EOF as well as process exit is part of completion. Descendants
            # holding descriptors remain governed by the same deadline.
            while selector.get_map() or process.poll() is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    break
                if not selector.get_map():
                    try:
                        process.wait(timeout=remaining)
                    except subprocess.TimeoutExpired:
                        timed_out = True
                    break
                for key, _events in selector.select(min(remaining, .05)):
                    try:
                        chunk = os.read(key.fd, READ_BYTES)
                    except BlockingIOError:
                        continue
                    if chunk:
                        key.data.append(chunk)
                    else:
                        selector.unregister(key.fileobj)
                if json_status and stdout.total > JSON_RESULT_BYTES:
                    output_limited = True
                    break
        finally:
            # Reap the direct child and stop descendants, including a child
            # ignoring TERM after the leader exited. Nonblocking pipes close
            # without a text-reader lock, even if a descendant changed session.
            _kill_group(process)
        stopped = timed_out or output_limited
        return ProcessOutput(
            exit_code=None if stopped else process.returncode,
            timed_out=timed_out, output_limited=output_limited,
            stdout=stdout.preview(), stderr=stderr.preview(),
            json_output=stdout.content() if json_status and not stopped else None,
            stdout_bytes=stdout.total, stderr_bytes=stderr.total,
        )
