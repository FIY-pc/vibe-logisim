"""Bounded, read-only viewport drawing in the selected course runtime.

Shares the resident read-only runtime with editing queries. A small viewport
LRU lives here; workspace locks never cover drawing.
"""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
import math
from pathlib import Path
import threading
import xml.etree.ElementTree as ET

from studio.infrastructure.files import sha256_file


@dataclass(frozen=True)
class RenderInput:
    artifact: Path
    artifact_sha: str
    runtime: Path
    runtime_sha: str


def viewport(values):
    try:
        x, y, width, height = (int(values[k]) for k in ('x', 'y', 'width', 'height'))
        scale = float(values['scale'])
        if not math.isfinite(scale) or not 0 < scale <= 32 or width <= 0 or height <= 0:
            raise ValueError()
        if max(abs(x), abs(y), width, height) > 10_000_000:
            raise ValueError()
        w, h = math.ceil(width * scale), math.ceil(height * scale)
        if w > 4096 or h > 4096 or w * h > 8_000_000:
            raise ValueError()
        return x, y, width, height, scale
    except (KeyError, TypeError, ValueError, OverflowError):
        raise ValueError('画面范围或分辨率超出限制') from None


class ViewportRenderer:
    def __init__(self, repo_root, state_root, *, worker=None):
        from studio.runtime.worker import NativeWorker
        self.worker = worker or NativeWorker(repo_root, state_root)
        self.owns_worker = worker is None
        self.lock = threading.Lock()
        self.cache = OrderedDict()
        self.closed = False

    def close(self):
        with self.lock:
            self.closed = True
            self.cache.clear()
            if self.owns_worker: self.worker.close()

    def render(self, snapshot, name, region):
        if not self.lock.acquire(timeout=1):
            raise RuntimeError('局部绘图正忙，请稍后重试')
        try:
            if self.closed: raise RuntimeError('绘图服务已关闭')
            key = (snapshot, name, region)
            if key in self.cache:
                self.cache.move_to_end(key)
                return self.cache[key]
            if sha256_file(snapshot.artifact) != snapshot.artifact_sha or sha256_file(snapshot.runtime) != snapshot.runtime_sha:
                raise RuntimeError('局部绘图输入已改变')
            operation = ET.Element('render', circuit=name, **dict(zip(
                ('x','y','width','height','scale'), map(str,region))))
            data = self.worker.request(snapshot.runtime, snapshot.artifact, operation)
            if not data.startswith(b'\x89PNG\r\n\x1a\n'): raise RuntimeError('无效的局部画面')
            self.cache[key] = data
            while len(self.cache) > 8 or sum(map(len, self.cache.values())) > 24_000_000:
                self.cache.popitem(last=False)
            return data
        finally:
            self.lock.release()
