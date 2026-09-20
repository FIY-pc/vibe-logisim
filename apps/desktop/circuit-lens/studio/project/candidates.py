from __future__ import annotations


import hashlib
import copy
import io
import json
import re
import uuid
import xml.etree.ElementTree as ET
import zipfile
from studio.domain.candidate_access import CandidateAccess
from studio.domain.tool_errors import CircuitToolError

class CandidateService:
    def __init__(self, workspace, tools):
        self.workspace = workspace
        self.tools = tools

    def _access(self):
        record = self.workspace.history.record or {}
        return CandidateAccess(
            record.get('id'), self.workspace.revision_id,
            frozenset(e['candidateId'] for e in record.get('history', []) if e.get('candidateId')),
        )

    def _missing_candidate(self, candidate_id):
        # Offer explicit choices from this project/version. Never resolve a
        # mistyped identifier to a candidate, especially before applying it.
        pending = self.list()
        available = [{'id': item['id'], 'title': item.get('title', '')[:120]}
                     for item in pending[:5]]
        choices = '；'.join(f"{item['id']}（{item['title']}）" for item in available)
        message = f'找不到候选 {str(candidate_id)[:120]}。'
        message += f'当前版本可用候选：{choices}。' if available else '当前版本没有可用候选。'
        return CircuitToolError('CANDIDATE_NOT_FOUND', message,
            hint='从原始工具结果或 availableCandidates 选择完整 id；重复同一个无效编号不会恢复候选。',
            context={'requestedCandidateId': candidate_id, 'availableCandidates': available,
                     'availableCount': len(pending), 'truncated': len(pending) > len(available)})

    def _metadata(self, candidate_id, allow_applied=False):
        if not isinstance(candidate_id, str) or not re.fullmatch('candidate-[0-9a-f]{16}', candidate_id):
            raise self._missing_candidate(candidate_id)
        directory = self.workspace.state_root / 'candidates' / candidate_id
        try:
            metadata = json.loads((directory / 'candidate.json').read_text())
        except FileNotFoundError as error:
            raise self._missing_candidate(candidate_id) from error
        self._access().require(metadata, allow_applied=allow_applied)
        if hashlib.sha256((directory / 'artifact.circ').read_bytes()).hexdigest() != metadata['artifactSha256']:
            raise ValueError('候选电路已被外部修改')
        for dep in metadata['dependencies']:
            if hashlib.sha256((directory / dep['name']).read_bytes()).hexdigest() != dep['sha256']:
                raise ValueError('候选组件库已被外部修改')
        return (directory, metadata)

    def diff(self, candidate_id):
        directory, metadata = self._metadata(candidate_id, allow_applied=True)
        if not metadata.get('diffVersion'):
            if metadata['baseRevisionId'] != self.workspace.revision_id:
                raise ValueError('旧历史改动没有保存图上差异，请使用历史对照')
            from studio.project.changes import attach_diff
            attach_diff(self, directory, metadata)
            self._save(directory, metadata)
        access = self._access()
        return {**metadata, 'access': {
            'canApply': access.is_pending(metadata),
            'appliedPreviously': candidate_id in access.applied_ids,
        }}

    def list(self):
        result = []
        access = self._access()
        for file in (self.workspace.state_root / 'candidates').glob('*/candidate.json'):
            try:
                metadata = json.loads(file.read_text())
            except (OSError, ValueError):
                continue
            if isinstance(metadata, dict) and access.is_pending(metadata):
                result.append(metadata)
        return sorted(result, key=lambda c: c['createdAt'], reverse=True)

    def build(self, args):
        from datetime import datetime, timezone
        modules = args.get('modules')
        if not isinstance(modules, list) or not 1 <= len(modules) <= 4:
            raise ValueError('每个候选需要 1–4 个待补全模块')
        if len({m.get('circuit') for m in modules}) != len(modules):
            raise ValueError('候选不能重复定义模块')
        candidate_id = 'candidate-' + uuid.uuid4().hex[:16]
        directory = self.workspace.state_root / 'candidates' / candidate_id
        directory.mkdir(parents=True)
        with self.workspace.observation_artifact() as original:
            before = original.read_bytes()
        artifact = directory / 'artifact.circ'
        artifact.write_bytes(before)
        for name, data in self.workspace.package.contents.items():
            (directory / name).write_bytes(data)
        changes = []
        for module in modules:
            name, expressions = (module.get('circuit'), module.get('expressions'))
            if not isinstance(name, str) or not isinstance(expressions, dict) or (not expressions):
                raise ValueError('模块必须指定电路名称与输出表达式')
            request = ET.Element('build', circuit=name)
            for output, expression in expressions.items():
                if not isinstance(expression, str) or not 1 <= len(expression) <= 12000:
                    raise ValueError('输出表达式长度应为 1–12000')
                ET.SubElement(request, 'expression', output=output).text = expression
            generated = directory / 'native-output.circ'
            self.tools._native(artifact, request, generated)
            source_bytes = artifact.read_bytes()
            source_root, generated_root = (ET.fromstring(source_bytes), ET.fromstring(generated.read_bytes()))
            generated_circuit = next((c for c in generated_root.findall('circuit') if c.get('name') == name))
            libraries = {c.get('desc'): c.get('name') for c in source_root.findall('lib')}
            library_ids = {c.get('name'): libraries.get(c.get('desc')) for c in generated_root.findall('lib')}
            for component in generated_circuit.findall('comp'):
                if component.get('lib'):
                    mapped = library_ids.get(component.get('lib'))
                    if mapped is None:
                        raise ValueError('生成器引用了工程中不存在的组件库')
                    component.set('lib', mapped)
            matches = list(re.finditer(b'<circuit\\b[^>]*>.*?</circuit>', source_bytes, re.S))
            match = next((m for m in matches if ET.fromstring(m.group()).get('name') == name))
            source_circuit = ET.fromstring(match.group())

            def pin_label(pin):
                return next((a.get('val') for a in pin.findall('a') if a.get('name') == 'label'), None)
            original_pins = {pin_label(p): p for p in source_circuit.findall('comp') if p.get('name') == 'Pin'}
            relocated = {pin_label(p): p for p in generated_circuit.findall('comp') if p.get('name') == 'Pin'}
            if set(original_pins) != set(relocated):
                raise ValueError('生成器改变了引脚集合')
            pin_locations = {p.get('loc').strip('()'): relocated[label].get('loc').strip('()') for label, p in original_pins.items()}
            for label, pin in relocated.items():
                preserved = copy.deepcopy(original_pins[label])
                preserved.set('loc', pin.get('loc'))
                generated_circuit.remove(pin)
                generated_circuit.append(preserved)
            for child in list(generated_circuit):
                if child.tag not in {'comp', 'wire'}:
                    generated_circuit.remove(child)
            for index, child in enumerate((c for c in source_circuit if c.tag not in {'comp', 'wire'})):
                preserved = copy.deepcopy(child)
                for port in preserved.iter():
                    if 'pin' in port.attrib:
                        if port.get('pin').strip('()') not in pin_locations:
                            raise ValueError('自定义封装引用了未知引脚')
                        port.set('pin', pin_locations[port.get('pin').strip('()')])
                generated_circuit.insert(index, preserved)
            replacement = ET.tostring(generated_circuit, encoding='utf-8')
            artifact.write_bytes(source_bytes[:match.start()] + replacement + source_bytes[match.end():])
            changes.append({'circuit': name, 'expressions': expressions, 'componentsBefore': len(ET.fromstring(match.group()).findall('comp')), 'componentsAfter': len(generated_circuit.findall('comp')), 'wiresAfter': len(generated_circuit.findall('wire'))})
        metadata = {'id': candidate_id, 'projectId': self.workspace.history.record['id'], 'baseRevisionId': self.workspace.revision_id, 'artifactSha256': hashlib.sha256(artifact.read_bytes()).hexdigest(), 'title': str(args.get('title') or '补全组合逻辑')[:120], 'changes': changes, 'createdAt': datetime.now(timezone.utc).isoformat(), 'checks': [], 'dependencies': [{'name': d['name'], 'sha256': d['sha256']} for d in self.workspace.package.dependencies], 'interfacePreserved': True, 'sourceUnchanged': True, 'verification': 'native-synthesis-and-port-footprint-only'}
        for change in changes:
            self.tools._native(self.workspace.frozen_path, ET.Element('check-interface', circuit=change['circuit']), artifact)
            observation = self.workspace.observer.run_full(artifact, change['circuit'], directory / (hashlib.sha256(change['circuit'].encode()).hexdigest() + '.png'))
            change['render'] = observation['render']
            change['coverage'] = observation.get('coverage')
            if any(((change['coverage'] or {}).get(k, 0) for k in ('unknownWidthEnds', 'invalidBundleEnds', 'widthIncompatibilities'))):
                raise ValueError('候选存在未知位宽或电气连接冲突，未发布')
        self._save(directory, metadata)
        return metadata

    @staticmethod
    def _save(directory, metadata):
        temporary = directory / ('.candidate-' + uuid.uuid4().hex + '.tmp')
        temporary.write_text(json.dumps(metadata, ensure_ascii=False, indent=2))
        temporary.replace(directory / 'candidate.json')

    def archive(self, candidate_id):
        directory, metadata = self._metadata(candidate_id, allow_applied=True)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.write(directory / 'artifact.circ', 'candidate.circ')
            for dep in metadata['dependencies']:
                archive.write(directory / dep['name'], dep['name'])
            for review in metadata.get('executionReviews', []):
                filename = review.get('reportFile', '')
                if re.fullmatch('instruction-review-[0-9a-f]{16}\\.json', filename):
                    archive.write(directory / filename, filename)
            archive.writestr('candidate.json', json.dumps(metadata, ensure_ascii=False, indent=2))
        return buffer.getvalue()

    def working_copy(self, revision, candidate_id):
        with self.workspace.lock:
            if revision != self.workspace.revision_id:
                raise ValueError('候选所属工程已切换')
            source, metadata = self._metadata(candidate_id)
            runtime = self.workspace.package.runtime(self.workspace.repo_root)
            root = self.workspace.state_root / 'working-copies' / (candidate_id + '-' + uuid.uuid4().hex[:8])
            project = root / 'project'
            project.mkdir(parents=True)
            (project / 'candidate.circ').write_bytes((source / 'artifact.circ').read_bytes())
            for dependency in metadata['dependencies']:
                (project / dependency['name']).write_bytes((source / dependency['name']).read_bytes())
            for resource in self.workspace.package.resources:
                destination = project / resource['name'] if resource['id'] == 'control-workbook' else root / 'RISC-V指令集手册' / resource['name']
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(self.workspace.package.resource_contents[resource['id']])
            (root / 'origin.json').write_text(json.dumps({'candidateId': candidate_id, 'candidateTitle': metadata['title'], 'baseRevisionId': revision, 'artifactSha256': metadata['artifactSha256'], 'sourcePath': str(self.workspace.source_path) if self.workspace.source_path else None}, ensure_ascii=False, indent=2), encoding='utf-8')
            return {'path': str(project / 'candidate.circ'), 'runtimeJar': str(runtime)}


