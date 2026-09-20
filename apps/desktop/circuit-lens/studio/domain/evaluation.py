"""Three-valued comparison of a settled observation with explicit expectations."""
from __future__ import annotations


def compare_sample(actual, expected, *, oscillating=False):
    if not isinstance(expected, dict) or not expected:
        raise ValueError('每个测试样本至少需要一个期望信号')
    if actual is None:
        return 'unknown', 'missing-sample'
    if oscillating:
        # A propagation-limit snapshot is not a settled sample, even when
        # an unrelated observed output happens to match the expectation.
        return 'unknown', 'oscillating'
    if any(actual.get(name) is not None and actual[name] != value for name, value in expected.items()):
        return 'failed', 'mismatch'
    if any(name not in actual for name in expected):
        return 'unknown', 'missing-signal'
    if any(actual[name] is None for name in expected):
        return 'unknown', 'undefined-signal'
    return 'passed', None


def observation_feedback(rows):
    """Summarize complete native rows, before any transport sampling/paging.

    Row comparisons belong to the domain, not the event consumer. Trace rows
    have no expectations; they can establish an observation, never a pass.
    """
    failures, unknown, checked = [], [], []
    for index, row in enumerate(rows):
        if row.get('oscillating') or row.get('status') == 'unknown':
            unknown.append({**row, 'rowIndex': index})
        elif row.get('expected') and row.get('oscillating') is False:
            if row.get('status') in {'passed', 'failed'}:
                checked.append(row)
                if row['status'] == 'failed':
                    failures.append({**row, 'rowIndex': index})
    status = 'failed' if failures else 'unknown' if unknown else (
        'passed' if checked and len(checked) == len(rows) else 'observed'
    )
    return {
        'status': status,
        'rowCount': len(rows),
        'checkedCount': len(checked),
        'failureCount': len(failures),
        'unknownCount': len(unknown),
        'firstFailure': failures[0] if failures else None,
        'firstUnknown': unknown[0] if unknown else None,
    }
