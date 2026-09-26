"""Skip a test script cleanly when its sample files are not present.

Several acceptance scripts were written against circuits, course libraries and
runtime files that are not distributed with the repository (``exports/``,
``archive/``, ``experiments/``, the course package under ``workspaces/``). In a
plain checkout those scripts must say so and exit 0 instead of failing on a
missing path.

    sys.path.insert(0, str(REPO / 'apps/desktop/test'))
    from support.samples import requires_samples, skip_unless_samples, runtime_versions

    requires_samples(REPO, 'archive/tooling/tmp/half_adder.circ')   # standalone script

    @skip_unless_samples(REPO, 'exports/interface-editing')          # TestCase or test method
    def test_course_file(self): ...

    for version in runtime_versions(REPO): ...   # '2.15.0' only with the course runtime

``requires_samples`` is for scripts that run as programs; it ends the process.
unittest modules use the decorator so the remaining tests still run and the
skipped ones are reported as skipped.

Circuits saved as ``source="2.15.*"`` are loaded with the course-issued Logisim
runtime (see ``studio/project/package.py``), which is course material and not
in the repository either. ``runtime_versions`` drops that version when the file
is absent so the 2.16.2.2 leg of a two-runtime test still runs.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

NOTE = 'sample files not in the repository (development material kept alongside a checkout)'
COURSE_RUNTIME = 'workspaces/hust-riscv/original/course-package/logisim-ita-cn-20200118.exe'
RUNTIME_VERSIONS = ('2.16.2.2', '2.15.0')


def missing_samples(repo, *relative):
    root = Path(repo)
    return [p for p in relative if not (root / p).exists()]


def requires_samples(repo, *relative):
    """Print SKIP and exit 0 when any sample is absent."""
    missing = missing_samples(repo, *relative)
    if not missing:
        return
    print(f"SKIP: {NOTE}: {', '.join(missing)}", flush=True)
    sys.exit(0)


def skip_unless_samples(repo, *relative):
    """Decorator for a TestCase or test method that needs sample files."""
    missing = missing_samples(repo, *relative)
    return unittest.skipIf(bool(missing), f"{NOTE}: {', '.join(missing)}")


def course_runtime_available(repo):
    return (Path(repo) / COURSE_RUNTIME).is_file()


def runtime_versions(repo):
    """The Logisim source versions this checkout can load natively."""
    if course_runtime_available(repo):
        return RUNTIME_VERSIONS
    print(f'NOTE: course runtime not present ({COURSE_RUNTIME}); 2.15.0 cases are skipped', flush=True)
    return RUNTIME_VERSIONS[:1]


def requires_course_runtime(repo):
    """Print SKIP and exit 0 when the course-issued Logisim runtime is absent."""
    if course_runtime_available(repo):
        return
    print(f'SKIP: {NOTE}: {COURSE_RUNTIME}', flush=True)
    sys.exit(0)
