from __future__ import annotations


from datetime import datetime, timezone
import hashlib
import json
import time
import uuid
import xml.etree.ElementTree as ET
from studio.domain.plugin import PLUGIN_ID, PLUGIN_VERSION, RESULT_SCHEMA, binding_for, result_envelope
from studio.runtime.evaluation import EvaluationService

class NativeCircuitRuntime:
    """Execute native Logisim observations for the circuit plugin.

    Codex thread/turn orchestration is outside this class. Evaluation is also
    delegated to EvaluationService so runtime rows and test interpretation
    cannot silently become one verdict-producing state machine.
    """
    def __init__(self, workspace, tools):
        self.workspace = workspace
        self.tools = tools
        self.evaluator = EvaluationService(self)

    def harness_run(self, args):
        """Run a real native experiment while keeping the workflow user-directed."""
        if not isinstance(args, dict):
            raise ValueError('Harness 参数必须为对象')
        mode = args.get('mode', 'trace')
        if mode == 'simulate' and (args.get('inputEvents') or args.get('buttonEvents')):
            raise ValueError('组合仿真不接受时钟或按钮事件，请改用 trace 模式')
        if mode == 'trace':
            report = self.trace(args)
        elif mode == 'simulate':
            report = self.simulate(args)
        else:
            raise ValueError('Harness mode must be trace or simulate')
        rows = report.get('rows', [])
        failures = [{**row, 'rowIndex': index} for index, row in enumerate(rows) if row.get('passed') is False or row.get('oscillating')]
        targets = [{'kind': 'component', 'component': watch.get('component'), 'componentId': watch.get('component'), 'port': watch.get('port'), 'name': watch.get('name')} for watch in args.get('watches', []) if isinstance(watch, dict)]
        connectivity = None
        if args.get('candidateId'):
            _, metadata = self.tools._metadata(args['candidateId'])
            proofs = [change['wiringProof'] for change in metadata.get('changes', []) if change.get('wiringProof')]
            if proofs:
                connectivity = proofs
        checked = [row for row in rows if row.get('passed') is not None]
        status = 'failed' if failures else (
            'passed' if checked and len(checked) == len(rows) and all(row.get('passed') is True for row in checked)
            else 'observed'
        )
        feedback = {
            'status': status,
            'rowCount': len(rows),
            'checkedCount': len(checked),
            'failureCount': len(failures),
            'targets': targets,
            'connectivity': connectivity,
            'firstFailure': failures[0] if failures else None,
            'nextActions': ['inspect_circuit 查看相关端口和位网', 'harness_run 以更窄的输入或观察点重跑', 'submit_circuit 刷新修复后的当前文件'],
            'note': 'Harness 提供真实运行反馈，不规定下一步必须验证还是继续构建。',
        }
        artifact_sha = report.get('artifactSha256') or self.workspace.artifact_sha256
        binding = binding_for(self.workspace, circuit=args.get('circuit'), candidate_id=args.get('candidateId'), artifact_sha256=artifact_sha)
        run = {
            'id': report.get('runId'),
            'kind': mode,
            'status': 'completed',
            'authority': report.get('authority', 'Logisim native clock and propagation'),
            'runtimeProfileId': report.get('runtimeProfileId'),
            'stimulusSha256': report.get('stimulusSha256'),
            'rowCount': len(rows),
        }
        envelope = result_envelope(binding=binding, run=run, observation=report, feedback=feedback)
        # Keep the original session/result shape for existing UI consumers;
        # the envelope is the new stable model-facing contract.
        envelope['session'] = {
            'revisionId': self.workspace.revision_id,
            'circuit': args.get('circuit'),
            'candidateId': args.get('candidateId') or None,
            'artifactSha256': artifact_sha,
            'mode': mode,
            'authority': report.get('authority', 'Logisim native clock and propagation'),
        }
        return envelope

    def evaluate(self, args):
        return self.evaluator.evaluate(args)

    def simulate(self, args):
        name, vectors = (args.get('circuit'), args.get('vectors'))
        if not isinstance(name, str) or not isinstance(vectors, list) or (not 1 <= len(vectors) <= 1024):
            raise ValueError('指定电路和 1–1024 组输入向量')
        if args.get('inputEvents') or args.get('buttonEvents'):
            raise ValueError('组合仿真不接受时钟或按钮事件，请改用 trace 模式')
        candidate_id = args.get('candidateId')
        if candidate_id:
            directory, metadata = self.tools._metadata(candidate_id)
            artifact = directory / 'artifact.circ'
        else:
            with self.workspace.observation_artifact() as frozen:
                artifact = frozen
        artifact_sha = self._artifact_sha(artifact)
        started_at = datetime.now(timezone.utc).isoformat()
        started = time.perf_counter()
        request = ET.Element('simulate', circuit=name)
        for vector in vectors:
            row = ET.SubElement(request, 'vector')
            for pin, value in self._values(vector.get('inputs', {}), '输入').items():
                ET.SubElement(row, 'input', name=pin, value=str(value))
            self._values(vector.get('expected'), '期望输出', allow_none=True)
        response = self.tools._native(artifact, request)
        finished = time.perf_counter()
        rows = []
        for i, row in enumerate(response):
            outputs = {o.get('name'): int(o.get('value')) if 'value' in o.attrib else None for o in row}
            expected = vectors[i].get('expected')
            passed = None if not expected else all((k in outputs and outputs[k] == v for k, v in expected.items())) and row.get('oscillating') == 'false'
            rows.append({'inputs': vectors[i]['inputs'], 'outputs': outputs, 'bits': {o.get('name'): o.get('bits') for o in row}, 'expected': expected, 'passed': passed, 'oscillating': row.get('oscillating') == 'true'})
        report = {
            'schema': RESULT_SCHEMA,
            'plugin': {'id': PLUGIN_ID, 'version': PLUGIN_VERSION},
            'circuit': name,
            'candidateId': candidate_id,
            'artifactSha256': artifact_sha,
            'authority': 'Logisim native propagation',
            'runId': self._run_id(),
            'runtimeProfileId': self.workspace.observer.profile().get('id'),
            'runtimeProfile': self.workspace.observer.profile(),
            'stimulusSha256': self._stimulus_sha({'mode': 'simulate', 'circuit': name, 'vectors': vectors}),
            'startedAt': started_at,
            'durationMs': round((finished - started) * 1000, 3),
            'rows': rows,
            'passed': sum((r['passed'] is True for r in rows)),
            'failed': sum((r['passed'] is False for r in rows)),
            'unchecked': sum((r['passed'] is None for r in rows)),
        }
        report['binding'] = binding_for(self.workspace, circuit=name, candidate_id=candidate_id, artifact_sha256=artifact_sha)
        if candidate_id:
            metadata['checks'].append(report)
            self.tools._save(directory, metadata)
        else:
            self._record_observation(report, 'combinational')
        return report

    def _record_observation(self, report, kind):
        from studio.project.history import write_json
        identifier = 'observation-' + uuid.uuid4().hex[:16]
        report.update({'id': identifier, 'kind': kind, 'revisionId': self.workspace.revision_id, 'artifactSha256': self.workspace.artifact_sha256, 'rowCount': len(report['rows'])})
        write_json(self.workspace.revision_dir / 'observations' / (identifier + '.json'), report)

    @staticmethod
    def _run_id():
        return 'run-' + uuid.uuid4().hex[:16]

    @staticmethod
    def _stimulus_sha(value):
        payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
        return hashlib.sha256(payload).hexdigest()

    @staticmethod
    def _artifact_sha(artifact):
        return hashlib.sha256(artifact.read_bytes()).hexdigest()

    @staticmethod
    def _values(values, label, allow_none=False):
        if values is None and allow_none:
            return {}
        if not isinstance(values, dict):
            raise ValueError(f'{label}必须是对象')
        for name, value in values.items():
            if not isinstance(name, str) or not name or not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 4294967295:
                raise ValueError(f'{label}必须为无符号整数')
        return values

    def trace(self, args):
        name, candidate_id = (args.get('circuit'), args.get('candidateId'))
        ticks, watches, inputs = (args.get('ticks', 16), args.get('watches', []), args.get('inputs', {}))
        if not isinstance(name, str) or type(ticks) is not int or (not 1 <= ticks <= 10000) or (not isinstance(watches, list)) or (not 1 <= len(watches) <= 24):
            raise ValueError('指定电路、1–10000 个原生时钟 tick 和 1–24 个观察端口')
        if candidate_id:
            directory, metadata = self.tools._metadata(candidate_id)
            artifact = directory / 'artifact.circ'
        else:
            with self.workspace.observation_artifact() as frozen:
                artifact = frozen
            metadata = {'artifactSha256': self.workspace.artifact_sha256}
        artifact_sha = self._artifact_sha(artifact)
        started_at = datetime.now(timezone.utc).isoformat()
        started = time.perf_counter()
        observation = self.workspace.observer.run_full(artifact, name)
        components = {c['componentId']: c for c in observation['focus']['components']}
        request = ET.Element('trace', circuit=name, ticks=str(ticks))

        def select(tag, ref, **attrs):
            component = components.get(ref.get('component'))
            if component is None:
                raise ValueError('观察端口不存在，请先 inspect_circuit 读取候选')
            return ET.SubElement(request, tag, factory=component['factoryName'], x=str(component['location']['x']), y=str(component['location']['y']), **attrs)
        seen = set()
        for watch in watches:
            label, port = (watch.get('name'), watch.get('port'))
            c = components.get(watch.get('component'))
            if not isinstance(label, str) or not 1 <= len(label) <= 80 or label in seen or (type(port) is not int) or (c is None) or (not any((e['index'] == port for e in c['ends']))):
                raise ValueError('观察名称必须唯一，端口需来自此候选的原生观察')
            seen.add(label)
            select('watch', watch, name=label, port=str(port))
        for pin, value in inputs.items():
            if type(value) is not int or not 0 <= value <= 4294967295:
                raise ValueError('输入必须为 32 位无符号整数')
            ET.SubElement(request, 'input', name=pin, value=str(value))
        program = args.get('program')
        if args.get('resetButton'):
            select('reset', {'component': args['resetButton']})
        button_events = args.get('buttonEvents', [])
        if not isinstance(button_events, list) or len(button_events) > 1000:
            raise ValueError('按钮激励需要最多 1000 个事件')
        for event in button_events:
            if not isinstance(event, dict) or type(event.get('tick')) is not int or (not 0 <= event['tick'] <= ticks) or (type(event.get('pressed')) is not bool):
                raise ValueError('按钮事件需要范围内的 tick 和布尔 pressed')
            component = components.get(event.get('component'))
            if component is None or component['factoryName'] != 'Button':
                raise ValueError('按钮激励目标必须来自当前电路的 Button')
            select('button-event', event, tick=str(event['tick']), pressed=str(event['pressed']).lower())
        input_events = args.get('inputEvents', [])
        if not isinstance(input_events, list) or len(input_events) > 1000:
            raise ValueError('输入事件需要最多 1000 个事件')
        for event in input_events:
            if not isinstance(event, dict) or type(event.get('tick')) is not int or (not 0 <= event['tick'] <= ticks):
                raise ValueError('输入事件需要范围内的 tick')
            if not isinstance(event.get('name'), str) or type(event.get('value')) is not int or (not 0 <= event['value'] <= 4294967295):
                raise ValueError('输入事件目标或数值无效')
            ET.SubElement(request, 'input-event', name=event['name'], tick=str(event['tick']), value=str(event['value']))
        if program is not None:
            words = program.get('words')
            if not isinstance(words, list) or not 1 <= len(words) <= 4096 or any((type(w) is not int or not 0 <= w <= 4294967295 for w in words)):
                raise ValueError('ROM 程序需要 1–4096 个 32 位无符号指令字')
            element = select('program', program)
            for word in words:
                ET.SubElement(element, 'word', value=str(word))
        response = self.tools._native(artifact, request)
        finished = time.perf_counter()
        rows = [{'tick': int(row.get('tick')), 'oscillating': row.get('oscillating') == 'true', 'values': {s.get('name'): int(s.get('value')) if 'value' in s.attrib else None for s in row}, 'bits': {s.get('name'): s.get('bits') for s in row}} for row in response]
        report = {
            'schema': RESULT_SCHEMA,
            'plugin': {'id': PLUGIN_ID, 'version': PLUGIN_VERSION},
            'circuit': name,
            'candidateId': candidate_id,
            'artifactSha256': artifact_sha,
            'authority': 'Logisim native clock and propagation',
            'runId': self._run_id(),
            'runtimeProfileId': self.workspace.observer.profile().get('id'),
            'runtimeProfile': self.workspace.observer.profile(),
            'stimulusSha256': self._stimulus_sha({'mode': 'trace', 'circuit': name, 'ticks': ticks, 'inputs': inputs, 'watches': watches, 'resetButton': args.get('resetButton'), 'buttonEvents': button_events, 'inputEvents': input_events, 'program': program}),
            'startedAt': started_at,
            'durationMs': round((finished - started) * 1000, 3),
            'ticks': ticks,
            'inputs': inputs,
            'watches': watches,
            'resetButton': args.get('resetButton'),
            'buttonEvents': button_events,
            'inputEvents': input_events,
            'program': program,
            'programScope': 'In-memory stimulus only; candidate ROM is unchanged' if program else 'Candidate ROM contents',
            'rows': rows,
            'note': 'Ticks are clock transitions, not necessarily CPU cycles. Samples are settled after each tick, not instruction-retirement claims.',
        }
        report['binding'] = binding_for(self.workspace, circuit=name, candidate_id=candidate_id, artifact_sha256=artifact_sha)
        if candidate_id:
            metadata.setdefault('traces', []).append(report)
            self.tools._save(directory, metadata)
        else:
            report['programScope'] = 'In-memory stimulus only; working circuit ROM is unchanged' if program else 'Working circuit ROM contents'
            self._record_observation(report, 'clock-trace')
        return report


# Kept for small local integrations while callers move to the precise name.
HarnessService = NativeCircuitRuntime
