"""Run the shipped layout solver using the desktop's own Node runtime."""
import json
import os
from pathlib import Path
import shutil
import subprocess

from studio.domain.tool_errors import CircuitToolError


def solve_groups(graph, evidence_dir):
    # LensBackend binds this to its own executable (Electron supports Node
    # mode). Standalone Python development can use an installed Node binary.
    executable = os.environ.get('VIBE_LOGISIM_LAYOUT_NODE') or shutil.which('node')
    if not executable:
        raise CircuitToolError('LAYOUT_RUNTIME_UNAVAILABLE', '布局运行时不可用。',
                               hint='桌面应用应自动提供布局运行时；独立 Python 开发入口需要 Node。')
    evidence_dir = Path(evidence_dir)
    payload = json.dumps(graph, ensure_ascii=False)
    (evidence_dir / 'elk-input.json').write_text(payload, encoding='utf-8')
    try:
        run = subprocess.run([executable, str(Path(__file__).with_name('elk-layout.cjs'))],
                             input=payload, capture_output=True, text=True, encoding='utf-8',
                             env={**os.environ, 'ELECTRON_RUN_AS_NODE': '1'}, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise CircuitToolError('LAYOUT_RUNTIME_FAILED', '布局运行时未完成：' + str(error)) from error
    if run.returncode:
        raise CircuitToolError('LAYOUT_RUNTIME_FAILED', '布局运行失败：' + run.stderr[-2000:])
    (evidence_dir / 'elk-output.json').write_text(run.stdout, encoding='utf-8')
    return json.loads(run.stdout)
