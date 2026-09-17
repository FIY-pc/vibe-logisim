"""Host-only file moves, preserving document identity and unsaved revisions."""
from __future__ import annotations

import copy
import ctypes
import json
import os
from pathlib import Path
import sys

from studio.infrastructure.files import atomic_write_json


def rename_exclusive(source: Path, target: Path) -> None:
    """Unlike os.rename on POSIX, never replace a concurrently created target."""
    if sys.platform == 'win32':
        os.rename(source, target)
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'linux':
        result = libc.renameat2(-100, os.fsencode(source), -100, os.fsencode(target), 1)
    elif sys.platform == 'darwin':
        result = libc.renamex_np(os.fsencode(source), os.fsencode(target), 4)
    else:
        raise ValueError('此系统暂不支持安全移动文件')
    if result:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), str(target))


def move_workspace_path(workspace, folder_id: str, relative: str, destination: str):
    with workspace.lock:
        folder = workspace.folder
        if not folder or folder['id'] != folder_id:
            raise ValueError('工作区已切换，请重试')
        root = Path(folder['root']).resolve()
        source = root / relative
        target = root / destination
        if (not relative or not destination or Path(relative).is_absolute()
                or Path(destination).is_absolute() or '..' in Path(relative).parts
                or '..' in Path(destination).parts):
            raise ValueError('文件路径无效')
        if source == root or target == root or target.is_relative_to(source):
            raise ValueError('不能将文件夹移动到自身或它的子文件夹')
        if not source.parent.resolve().is_relative_to(root) or not target.parent.resolve().is_relative_to(root):
            raise ValueError('文件不在当前工作区内')
        if not source.exists() and not source.is_symlink():
            raise ValueError('文件已不存在，请刷新文件列表')
        if target.exists() or target.is_symlink():
            raise ValueError('目标文件夹内已有同名文件，请先更改名称或选择其他文件夹')

        records = []
        for file in workspace.project_store.project_directory.glob('project-*.json'):
            record = json.loads(file.read_text(encoding='utf-8'))
            old_path = Path(record['sourcePath']) if record.get('sourcePath') else None
            if old_path and old_path.is_relative_to(source):
                changed = copy.deepcopy(record)
                changed['sourcePath'] = str(target / old_path.relative_to(source))
                records.append((file, record, changed))
        # Old records at a reused destination must not steal the moved identity.
        moved_ids = {record['id'] for _, record, _ in records}
        for _, _, record in records:
            conflict = workspace.project_store.known_path(Path(record['sourcePath']))
            if conflict and conflict['id'] not in moved_ids:
                raise ValueError('目标位置保留着另一份电路的编辑历史，请选择其他文件夹')

        active = next((record for _, _, record in records
                       if workspace.history.record and record['id'] == workspace.history.record['id']), None)
        snapshot = workspace.project_store.prepare_revision(active, active['currentRevisionId']) if active else None
        rename_exclusive(source, target)
        written = []
        try:
            for file, old, new in records:
                atomic_write_json(file, new)
                written.append((file, old))
        except Exception:
            for file, old in reversed(written):
                atomic_write_json(file, old)
            rename_exclusive(target, source)
            raise
        if active:
            workspace.project_store.state = snapshot
            workspace.history.record = active
            workspace.project_store.refresh_pointer()
        return {'documentChanged': bool(active)}
