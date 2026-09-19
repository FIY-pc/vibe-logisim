from __future__ import annotations


from datetime import datetime, timezone
import hashlib
import json
import time
import uuid
import xml.etree.ElementTree as ET
from studio.domain.tool_errors import CircuitToolError
from studio.domain.plugin import PLUGIN_ID, PLUGIN_VERSION, RESULT_SCHEMA, binding_for, result_envelope
from studio.project.package import ProjectPackage
from studio.runtime.evaluation import EvaluationService
from studio.domain.evaluation import compare_sample

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
        failures = [{**row, 'rowIndex': index} for index, row in enumerate(rows) if row.get('passed') is False]
        unknown = [{**row, 'rowIndex': index} for index, row in enumerate(rows)
                   if row.get('oscillating') or row.get('status') == 'unknown']
        targets = [{'kind': 'component', 'component': watch.get('component'), 'componentId': watch.get('component'), 'port': watch.get('port'), 'name': watch.get('name')} for watch in args.get('watches', []) if isinstance(watch, dict)]
        connectivity = None
        if args.get('candidateId'):
            _, metadata = self.tools._metadata(args['candidateId'])
            proofs = [change['wiringProof'] for change in metadata.get('changes', []) if change.get('wiringProof')]
            if proofs:
                connectivity = proofs
        checked = [row for row in rows if row.get('passed') is not None]
        status = 'failed' if failures else 'unknown' if unknown else (
            'passed' if checked and len(checked) == len(rows) and all(row.get('passed') is True for row in checked)
            else 'observed'
        )
        feedback = {
            'status': status,
            'rowCount': len(rows),
            'checkedCount': len(checked),
            'failureCount': len(failures),
            'unknownCount': len(unknown),
            'targets': targets,
            'connectivity': connectivity,
            'firstFailure': failures[0] if failures else None,
            'firstUnknown': unknown[0] if unknown else None,
            'nextActions': ['inspect_circuit 查看相关端口和位网', 'harness_run 以更窄的输入或观察点重跑', 'submit_circuit 刷新修复后的当前文件'],
            'note': 'Harness 提供真实运行反馈，不规定下一步必须验证还是继续构建。',
        }
        artifact_sha = report.get('artifactSha256') or self.workspace.artifact_sha256
        binding = binding_for(self.workspace, circuit=args.get('circuit'), candidate_id=args.get('candidateId'), artifact_sha256=artifact_sha, runtime_profile=report.get('runtimeProfile'))
        run = {
            'id': report.get('runId'),
            'label': '原生运行观察',
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
        inspected = self.tools.inspect({'circuit': name, 'candidateId': candidate_id} if candidate_id else {'circuit': name})
        available = [item.get('label') for item in inspected.get('stimulusSchema') or [] if item.get('label')]
        request = ET.Element('simulate', circuit=name)
        for vector in vectors:
            row = ET.SubElement(request, 'vector')
            inputs = self._values(vector.get('inputs', {}), '输入')
            self._assert_known_inputs(inputs, available)
            for pin, value in inputs.items():
                ET.SubElement(row, 'input', name=pin, value=str(value))
            self._values(vector.get('expected'), '期望输出', allow_none=True)
        response = self.tools._native(artifact, request)
        profile = self.workspace.observer.profile(response.get('runtimeVersion'))
        finished = time.perf_counter()
        rows = []
        for i, row in enumerate(response):
            outputs = {o.get('name'): int(o.get('value')) if 'value' in o.attrib else None for o in row}
            expected = vectors[i].get('expected')
            oscillating = row.get('oscillating') == 'true'
            status, reason = compare_sample(outputs, expected, oscillating=oscillating) if expected else ('observed', None)
            passed = {'passed': True, 'failed': False}.get(status)
            rows.append({'inputs': vectors[i]['inputs'], 'outputs': outputs, 'bits': {o.get('name'): o.get('bits') for o in row},
                         'expected': expected, 'passed': passed, 'status': status, 'oscillating': oscillating,
                         **({'reason': reason} if reason else {})})
        report = {
            'schema': RESULT_SCHEMA,
            'plugin': {'id': PLUGIN_ID, 'version': PLUGIN_VERSION},
            'circuit': name,
            'candidateId': candidate_id,
            'artifactSha256': artifact_sha,
            'authority': 'Logisim native propagation',
            'runId': self._run_id(),
            'runtimeProfileId': profile['id'],
            'runtimeProfile': profile,
            'execution': dict(response.attrib),
            'stimulusSha256': self._stimulus_sha({'mode': 'simulate', 'circuit': name, 'vectors': vectors}),
            'startedAt': started_at,
            'durationMs': round((finished - started) * 1000, 3),
            'rows': rows,
            'passed': sum((r['passed'] is True for r in rows)),
            'failed': sum((r['passed'] is False for r in rows)),
            'unchecked': sum((r['passed'] is None for r in rows)),
        }
        report['binding'] = binding_for(self.workspace, circuit=name, candidate_id=candidate_id, artifact_sha256=artifact_sha, runtime_profile=profile)
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
    def _input_labels(components):
        labels = []
        for component in components.values() if isinstance(components, dict) else components:
            if component.get('factoryName') != 'Pin':
                continue
            ends = component.get('ends') or []
            if not any(end.get('direction') == 'output' for end in ends):
                continue
            selector = component.get('selector') or {}
            label = selector.get('label') or component.get('label')
            if isinstance(label, str) and label.strip():
                labels.append(label)
        return sorted(set(labels))

    @staticmethod
    def _assert_known_inputs(values, available):
        if not available:
            return
        unknown = sorted(name for name in values if name not in available)
        if unknown:
            shown = ', '.join(available[:24])
            suffix = ' …' if len(available) > 24 else ''
            raise CircuitToolError(
                'UNKNOWN_INPUT',
                f'找不到输入引脚 {", ".join(unknown)}；当前可用输入：{shown}{suffix}。',
                hint='使用当前 inspect_circuit 返回的 stimulusSchema.label 作为 inputs 或 inputEvents 的 name。',
                available_inputs=available,
            )

    @staticmethod
    def _values(values, label, allow_none=False):
        if values is None and allow_none:
            return {}
        if not isinstance(values, dict):
            raise ValueError(f'{label}必须是对象')
        for name, value in values.items():
            if not isinstance(name, str) or not name.strip():
                raise ValueError(f'{label}的输入名不能为空，请使用 inspect_circuit 返回的引脚标签')
            if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 4294967295:
                raise ValueError(f'{label}“{name}”必须为 32 位无符号整数')
        return values

    def trace(self, args):
        name, candidate_id = (args.get('circuit'), args.get('candidateId') or None)
        ticks, watches, inputs = (args.get('ticks', 16), args.get('watches', []), args.get('inputs', {}))
        if candidate_id:
            directory, metadata = self.tools._metadata(candidate_id)
            artifact = directory / 'artifact.circ'
            runtime_jar = self.workspace.observer.runtime_jar
        else:
            with self.workspace.observation_artifact() as frozen:
                artifact = frozen
            metadata = None
            runtime_jar = self.workspace.observer.runtime_jar
        artifact_sha = self._artifact_sha(artifact)
        report = self._trace_artifact(args, artifact, artifact_sha, runtime_jar, candidate_id=candidate_id)
        if candidate_id:
            metadata.setdefault('traces', []).append(report)
            self.tools._save(directory, metadata)
        else:
            report['programScope'] = 'In-memory stimulus only; working circuit ROM is unchanged' if args.get('program') else 'Working circuit ROM contents'
            self._record_observation(report, 'clock-trace')
        return report

    def _trace_artifact(self, args, artifact, artifact_sha, runtime_jar, *, candidate_id=None):
        """Trace one immutable artifact without changing the active workspace.

        The public trace tool binds to the current revision or candidate. The
        comparison tool reuses this path for an owned historical snapshot, so
        both sides receive exactly the same native stimulus and observation
        rules.
        """
        name, candidate_id = (args.get('circuit'), candidate_id or None)
        ticks, watches, inputs = (args.get('ticks', 16), args.get('watches', []), args.get('inputs', {}))
        if not isinstance(name, str) or type(ticks) is not int or (not 1 <= ticks <= 10000) or (not isinstance(watches, list)) or (not 1 <= len(watches) <= 24):
            raise ValueError('指定电路、1–10000 个原生时钟 tick 和 1–24 个观察端口')
        started_at = datetime.now(timezone.utc).isoformat()
        started = time.perf_counter()
        observation = self.workspace.observer.run_full(artifact, name, runtime_jar=runtime_jar)
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
        normalized_inputs = self._values(inputs, '输入')
        self._assert_known_inputs(normalized_inputs, self._input_labels(observation['focus']['components']))
        for pin, value in normalized_inputs.items():
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
            if not isinstance(event.get('name'), str) or not event['name'].strip() or type(event.get('value')) is not int or (not 0 <= event['value'] <= 4294967295):
                raise ValueError('输入事件目标或数值无效')
            self._assert_known_inputs({event['name']: event['value']}, self._input_labels(observation['focus']['components']))
            ET.SubElement(request, 'input-event', name=event['name'], tick=str(event['tick']), value=str(event['value']))
        if program is not None:
            words = program.get('words')
            if not isinstance(words, list) or not 1 <= len(words) <= 4096 or any((type(w) is not int or not 0 <= w <= 4294967295 for w in words)):
                raise ValueError('ROM 程序需要 1–4096 个 32 位无符号指令字')
            element = select('program', program)
            for word in words:
                ET.SubElement(element, 'word', value=str(word))
        response = self.tools._native(artifact, request, runtime_jar=runtime_jar)
        profile = self.workspace.observer.profile(response.get('runtimeVersion'), runtime_jar=runtime_jar)
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
            'runtimeProfileId': profile['id'],
            'runtimeProfile': profile,
            'execution': dict(response.attrib),
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
            'note': 'Each call starts fresh. A native tick follows Clock high/low durations and need not be a transition or cycle. Sample 0 follows initialization and tick-0 events; later samples follow native tick/settling, input events, then button events. Each event settles in list order; values persist. Pins used as clocks require input events.',
        }
        report['binding'] = binding_for(self.workspace, circuit=name, candidate_id=candidate_id, artifact_sha256=artifact_sha, runtime_profile=profile)
        return report

    def _historical_reference(self, args):
        """Resolve an owned previous revision for an explicit comparison."""
        record = self.workspace.history.record
        if not record:
            raise ValueError('当前工程没有历史版本')
        requested = args.get('referenceRevisionId')
        reference_kind = args.get('reference', 'previous_revision')
        if reference_kind not in {'previous_revision', 'revision'}:
            raise ValueError('reference 必须为 previous_revision 或 revision')
        if reference_kind == 'revision' and not requested:
            raise ValueError('reference=revision 必须提供 referenceRevisionId')
        entries = record.get('history', [])
        allowed = {entry.get('revisionId') for entry in entries} | {self.workspace.revision_id}
        if requested:
            if requested not in allowed:
                raise ValueError('referenceRevisionId 不属于当前工程历史')
            revision_id = requested
            entry = next((item for item in reversed(entries) if item.get('revisionId') == revision_id), None)
            title = entry.get('title') if entry else '指定历史版本'
        else:
            entry = next((item for item in reversed(entries)
                          if item.get('revisionId') == self.workspace.revision_id and item.get('beforeRevisionId')), None)
            if not entry:
                raise ValueError('当前工程没有可比较的上一版本；请提供 referenceRevisionId')
            revision_id = entry['beforeRevisionId']
            title = entry.get('title') or '上一版本'
        if revision_id == self.workspace.revision_id:
            raise ValueError('referenceRevisionId 必须指向当前版本之前的历史版本')
        directory = self.workspace.state_root / 'revisions' / revision_id
        if not (directory / 'artifact.circ').is_file():
            raise ValueError('历史版本快照不存在，无法进行原生对照')
        package = ProjectPackage.from_snapshot(directory, None)
        package.verify_frozen(directory)
        return {
            'revisionId': revision_id,
            'title': title,
            'directory': directory,
            'artifact': directory / 'artifact.circ',
            'artifactSha256': package.artifact_sha256,
            'runtimeJar': package.runtime(self.workspace.repo_root),
        }

    def compare_circuit(self, args):
        """Compare current native behavior with an owned historical revision.

        This is deliberately a regression observation. Equality means that the
        selected behavior stayed equal under the supplied experiment; it does
        not mean the circuit meets an external course specification.
        """
        if not isinstance(args, dict) or args.get('mode', 'trace') != 'trace':
            raise ValueError('历史对照目前只支持 trace 模式')
        reference = self._historical_reference(args)
        current_artifact = self.workspace.frozen_path
        current_sha = self._artifact_sha(current_artifact)
        current = self._trace_artifact(args, current_artifact, current_sha, self.workspace.observer.runtime_jar)
        previous = self._trace_artifact(args, reference['artifact'], reference['artifactSha256'], reference['runtimeJar'])
        current_rows = {row.get('tick'): row for row in current.get('rows', [])}
        previous_rows = {row.get('tick'): row for row in previous.get('rows', [])}
        names = [watch.get('name') for watch in args.get('watches', [])]
        cases = []
        for tick in sorted(set(current_rows) | set(previous_rows)):
            left, right = current_rows.get(tick), previous_rows.get(tick)
            if not left or not right or left.get('oscillating') or right.get('oscillating'):
                cases.append({'tick': tick, 'status': 'unknown', 'current': left, 'reference': right})
                continue
            for name in names:
                actual = (left.get('values') or {}).get(name)
                expected = (right.get('values') or {}).get(name)
                if actual is None or expected is None:
                    status = 'unknown'
                else:
                    status = 'passed' if actual == expected else 'failed'
                cases.append({'tick': tick, 'signal': name, 'status': status, 'current': actual, 'reference': expected})
        failed = [case for case in cases if case['status'] == 'failed']
        unknown = [case for case in cases if case['status'] == 'unknown']
        status = 'failed' if failed else ('unknown' if unknown else 'passed')
        first_difference = failed[0] if failed else None
        feedback = {
            'status': status,
            'rowCount': len(current.get('rows', [])),
            'checkedCount': sum(case['status'] == 'passed' for case in cases),
            'failureCount': len(failed),
            'unknownCount': len(unknown),
            'firstDifference': first_difference,
            'note': '历史对照只说明两版在本次输入、时钟和观察点下是否一致；通过不等于满足外部课程测试，差异也不自动代表错误。',
        }
        binding = binding_for(self.workspace, circuit=args.get('circuit'), artifact_sha256=current_sha, runtime_profile=current.get('runtimeProfile'))
        run = {
            'id': self._run_id(),
            'label': '历史版本对照',
            'kind': 'comparison',
            'status': 'completed',
            'authority': 'Logisim native clock and propagation',
            'runtimeProfileId': current.get('runtimeProfileId'),
            'rowCount': len(current.get('rows', [])),
        }
        observation = {
            'mode': 'trace',
            'circuit': args.get('circuit'),
            'current': {'revisionId': self.workspace.revision_id, 'artifactSha256': current_sha,
                        'execution': current.get('execution'),
                        'runId': current.get('runId'), 'rowCount': len(current.get('rows', [])),
                        'oscillating': sum(row.get('oscillating', False) for row in current.get('rows', []))},
            'reference': {'revisionId': reference['revisionId'], 'title': reference['title'],
                          'execution': previous.get('execution'),
                          'artifactSha256': reference['artifactSha256'], 'runId': previous.get('runId'),
                          'rowCount': len(previous.get('rows', [])),
                          'oscillating': sum(row.get('oscillating', False) for row in previous.get('rows', []))},
            'stimulusSha256': current.get('stimulusSha256'),
            'signals': names,
            'ticks': args.get('ticks', 16),
        }
        envelope = result_envelope(binding=binding, run=run, observation=observation, feedback=feedback)
        envelope['comparison'] = {'status': status, 'cases': cases[:256], 'caseCount': len(cases), 'casesTruncated': len(cases) > 256}
        envelope['session'] = {'revisionId': self.workspace.revision_id, 'circuit': args.get('circuit'),
                               'artifactSha256': current_sha, 'mode': 'comparison',
                               'authority': 'Logisim native clock and propagation'}
        return envelope


# Kept for small local integrations while callers move to the precise name.
HarnessService = NativeCircuitRuntime
