"""Copy locked production Node dependencies, excluding renderer-only PDF assets.

The built-in agent imports its SDK at runtime, so the distributable must carry
its transitive dependencies instead of relying on a developer's node_modules.
"""
import json
import shutil
from pathlib import Path


def copy_node_dependencies(desktop: Path, app: Path):
    lock = json.loads((desktop / 'package-lock.json').read_text())
    copied = []
    for relative, metadata in lock['packages'].items():
        if not relative.startswith('node_modules/') or metadata.get('dev'):
            continue
        if relative == 'node_modules/pdfjs-dist' or relative.startswith('node_modules/@napi-rs/canvas'):
            continue  # copied with the existing browser-only asset selection
        source = desktop / relative
        if not source.is_dir():
            if metadata.get('optional'):
                continue
            raise ValueError(f'Run npm ci before building: {relative} missing')
        if source.is_symlink():
            raise ValueError(f'Runtime dependency must not be a symlink: {relative}')
        target = app / relative
        shutil.copytree(source, target, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns('node_modules', '.cache'))
        copied.append(relative)
    return copied
