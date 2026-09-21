from __future__ import annotations

import hashlib
import json

from studio.domain.plugin import binding_for, result_envelope
from studio.domain.evaluation import compare_sample


class EvaluationService:
    """Compare an observation with an explicit user-provided test spec.

    Execution stays in NativeCircuitRuntime; this service only interprets
    returned rows. A missing/unknown signal therefore stays unknown.
    """
    def __init__(self, runtime):
        self.runtime = runtime

    def evaluate(self, args):
        """Compare a native observation with an explicit test specification."""
        if not isinstance(args, dict):
            raise ValueError('评测参数必须为对象')
        mode = args.get('mode')
        if mode not in {'simulate', 'trace'}:
            raise ValueError('评测模式必须为 simulate 或 trace')

        if mode == 'simulate':
            vectors = args.get('vectors')
            if not isinstance(vectors, list) or not vectors or any(
                not isinstance(vector, dict) or not vector.get('expected') for vector in vectors
            ):
                raise ValueError('组合评测的每个向量都必须提供 expected 输出')
            report = self.runtime.simulate(args)
            cases = []
            for index, row in enumerate(report.get('rows', [])):
                if row.get('passed') is True:
                    case_status = 'passed'
                elif row.get('passed') is False:
                    case_status = 'failed'
                else:
                    case_status = 'unknown'
                cases.append({'index': index, 'status': case_status, 'expected': row.get('expected'), 'actual': row.get('outputs'),
                              **({'reason': row['reason']} if row.get('reason') else {})})
            expectation = {'mode': mode, 'vectors': [
                {'inputs': vector.get('inputs'), 'expected': vector.get('expected')}
                for vector in vectors
            ]}
        else:
            expected_rows = args.get('expectedRows')
            if not isinstance(expected_rows, list) or not expected_rows:
                raise ValueError('时序评测必须提供 expectedRows')
            for expected in expected_rows:
                if not isinstance(expected, dict) or type(expected.get('tick')) is not int or expected['tick'] < 0:
                    raise ValueError('expectedRows 需要非负 tick')
                self.runtime._values(expected.get('values'), '期望信号')
                if not expected['values']:
                    raise ValueError('expectedRows 每一行至少需要一个期望信号')
            report = self.runtime.trace(args)
            actual_by_tick = {row.get('tick'): row for row in report.get('rows', [])}
            cases = []
            for expected in expected_rows:
                actual_row = actual_by_tick.get(expected['tick'])
                actual_values = actual_row.get('values') if actual_row else None
                case_status, reason = compare_sample(actual_values, expected['values'],
                                                     oscillating=bool(actual_row and actual_row.get('oscillating')))
                cases.append({'tick': expected['tick'], 'status': case_status, 'expected': expected['values'], 'actual': actual_values,
                              **({'reason': reason} if reason else {})})
            expectation = {'mode': mode, 'expectedRows': expected_rows}

        expectation_sha = hashlib.sha256(json.dumps(
            expectation, ensure_ascii=False, sort_keys=True, separators=(',', ':')
        ).encode('utf-8')).hexdigest()

        failed = [case for case in cases if case['status'] == 'failed']
        unknown = [case for case in cases if case['status'] == 'unknown']
        status = 'failed' if failed else ('unknown' if unknown else 'passed')
        evaluation = {
            'status': status,
            'caseCount': len(cases),
            'passedCount': sum(case['status'] == 'passed' for case in cases),
            'failedCount': len(failed),
            'unknownCount': len(unknown),
            'cases': cases,
            'spec': {
                'mode': mode,
                'stimulusSha256': report.get('stimulusSha256'),
                'expectationSha256': expectation_sha,
            },
        }
        artifact_sha = report.get('artifactSha256') or self.runtime.workspace.artifact_sha256
        binding = binding_for(self.runtime.workspace, circuit=args.get('circuit'), candidate_id=args.get('candidateId'), artifact_sha256=artifact_sha, runtime_profile=report.get('runtimeProfile'))
        feedback = {
            'status': status,
            'rowCount': len(report.get('rows', [])),
            'checkedCount': len(cases) - len(unknown),
            'failureCount': len(failed),
            'unknownCount': len(unknown),
            'expectationSha256': expectation_sha,
            'firstFailure': failed[0] if failed else None,
            'firstUnknown': unknown[0] if unknown else None,
            'note': '评测只比较本次显式提供的测试规格；它不声明未覆盖的行为。',
        }
        run = {
            'id': report.get('runId'),
            'label': '显式测试',
            'kind': 'evaluation',
            'mode': mode,
            'status': 'completed',
            'authority': report.get('authority', 'Logisim native clock and propagation'),
            'runtimeProfileId': report.get('runtimeProfileId'),
            'stimulusSha256': report.get('stimulusSha256'),
            'expectationSha256': expectation_sha,
            'rowCount': len(report.get('rows', [])),
        }
        envelope = result_envelope(binding=binding, run=run, observation=report, feedback=feedback)
        envelope['evaluation'] = evaluation
        envelope['session'] = {
            'revisionId': self.runtime.workspace.revision_id,
            'circuit': args.get('circuit'),
            'candidateId': args.get('candidateId') or None,
            'artifactSha256': artifact_sha,
            'mode': mode,
            'authority': report.get('authority', 'Logisim native clock and propagation'),
        }
        return envelope
