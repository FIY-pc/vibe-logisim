#!/usr/bin/env python3
"""ProjectPackage jar dependency location, pinned on real inherited 2.7.1 files.

Students' inherited files record the original author's own machine path in the
jar descriptor (C:\\作业\\…, /Users/…, mixed separators). Only the basename can
mean anything on the student's machine, so ProjectPackage matches it in the
circuit's directory and lets the existing guards (no links out of the
directory, 32 MB, trusted digest) decide acceptance.

Run: python3 -B apps/desktop/test/project-package-dependencies.py
Pure Python; no native runtime, no model calls, no saves outside a tempdir.
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))

from studio.project.package import ProjectPackage, TRUSTED_LIBRARIES, digest  # noqa: E402

TEMPLATE = '''<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<project source="2.7.1" version="1.0">
  <lib desc="#Wiring" name="0"/>
  <lib desc="{descriptor}" name="8"/>
  <circuit name="main"/>
</project>
'''

root = Path(tempfile.mkdtemp(prefix='pkg-deps-'))
counter = 0


def load(descriptor, directory=root, source=True):
    global counter
    counter += 1
    path = directory / f'case{counter}.circ'
    path.write_text(TEMPLATE.format(descriptor=descriptor), encoding='utf-8')
    return ProjectPackage(path.read_bytes(), path if source else None)


WIN = 'jar#C:\\作业\\组原\\my实验\\CPU\\cs3410.jar#edu.cornell.cs3410.Components'

# Missing jar: the basename is identified, the message says what to do.
p = load(WIN)
assert not p.dependencies and not p.supported
assert any('缺少组件库' in e and 'cs3410.jar' in e and '同一目录' in e for e in p.errors), p.errors

# A jar of the right name beside the file is matched through any recorded path
# shape; the untrusted digest is then rejected with the dependency on record.
(root / 'cs3410.jar').write_bytes(b'PK\x03\x04 not the reviewed jar')
for descriptor in (
        WIN,
        'jar#/Users/someone/Desktop/组原实验/lab4/cs3410.jar#edu.cornell.cs3410.Components',
        'jar#C:/教学资料\\汇总/cs3410.jar#edu.cornell.cs3410.Components',
        'jar#cs3410.jar#edu.cornell.cs3410.Components'):
    p = load(descriptor)
    assert p.dependencies and p.dependencies[0]['name'] == 'cs3410.jar', (descriptor, p.errors)
    assert p.dependencies[0]['sourcePath'] == str(root / 'cs3410.jar')
    assert any('尚未支持此组件库版本' in e for e in p.errors), (descriptor, p.errors)
    assert not p.contents and not p.supported

# A descriptor with no identifiable file name is refused, not guessed at.
p = load('jar#C:\\dir\\#edu.cornell.cs3410.Components')
assert not p.dependencies
assert any('无法从工程依赖中识别' in e for e in p.errors), p.errors

# The directory boundary still holds: a symlink out of the project directory
# is rejected even when the basename matches.
outside = Path(tempfile.mkdtemp(prefix='pkg-outside-')) / 'evil.jar'
outside.write_bytes(b'outside payload')
(root / 'evil.jar').symlink_to(outside)
p = load('jar#C:\\x\\evil.jar#edu.cornell.cs3410.Components')
assert any('组件库不能通过链接访问工程目录之外' in e for e in p.errors), p.errors
assert not p.contents

# Unchanged surrounding contract: file# stays unsupported, and without a local
# source path there is nothing to match against.
p = load('file#some.circ#main')
assert any('暂不支持此工程依赖' in e for e in p.errors), p.errors
p = load(WIN, source=False)
assert any('请从本地路径打开工程' in e for e in p.errors), p.errors

# With the reviewed jar in place, a Windows-path descriptor loads fully.
# The jar is not committed (binaries stay out of git), so this leg runs only
# where a local copy of the course package exists.
trusted = next((j for j in (
    REPO / 'workspaces/hust-riscv/original/course-package/电路框架-cpu21-riscv/cs3410.jar',
) if j.is_file() and TRUSTED_LIBRARIES.get(digest(j.read_bytes())) == 'edu.cornell.cs3410.Components'), None)
if trusted:
    inner = root / 'trusted'
    inner.mkdir()
    (inner / 'cs3410.jar').write_bytes(trusted.read_bytes())
    p = load(WIN, directory=inner)
    assert p.supported and not p.errors, p.errors
    assert list(p.contents) == ['cs3410.jar']
    assert p.revision_id != p.artifact_sha256
    print('trusted-jar full load: ok (' + str(trusted.relative_to(REPO)) + ')')
else:
    print('trusted-jar full load: skipped (no local reviewed cs3410.jar)')

print('project-package-dependencies: PASS')
