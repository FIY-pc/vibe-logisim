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
