from __future__ import annotations


"""Persistent project identity and current state, independent of source bytes.

Snapshots remain immutable. Applying/restoring advances the project head;
saving is a separate, conflict-checked write to the existing source file.
"""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET
import zipfile
from studio.project.package import ProjectPackage

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, ensure_ascii=False, indent=2).encode()
    fd, temporary = tempfile.mkstemp(prefix='.project-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

class ProjectHistory:

    def __init__(self, workspace):
        self.workspace = workspace
        self.directory = workspace.state_root / 'projects'
        self.record = None

    def known_path(self, source):
        return self.workspace.project_store.known_path(source)

    def open(self, source, data, filename):
        w = self.workspace
        record = self.known_path(source) if source else None
        if record:
            snapshot = w.project_store.prepare_revision(record, record['currentRevisionId'])
        else:
            snapshot = w.project_store.freeze(data, 'path' if source else 'upload', filename, source)
            identity = 'path:' + str(source) if source else 'revision:' + snapshot.revision_id
            record = {'id': 'project-' + uuid.uuid4().hex[:16], 'conversationKey': hashlib.sha256(('circuit-tools-v2:' + identity).encode()).hexdigest(), 'name': Path(filename).stem, 'sourceName': filename, 'sourcePath': str(source) if source else None, 'currentRevisionId': snapshot.revision_id, 'savedRevisionId': snapshot.revision_id if source else None, 'diskRevisionId': snapshot.revision_id if source else None, 'history': [self._entry('open', '打开工程', None, snapshot.revision_id)]}
        self._commit(record, snapshot)
        w.simulation.close('已切换工程，运行状态已结束' if w.simulation.record else None)
        return w.session()

    def _commit(self, record, snapshot):
        self.workspace.project_store.commit(record, snapshot)
        self.record = record
        self.workspace.project_store.refresh_pointer()

    def _entry(self, kind, title, before, after, **extra):
        return {'id': 'change-' + uuid.uuid4().hex[:16], 'kind': kind, 'title': title, 'beforeRevisionId': before, 'revisionId': after, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), **extra}

    def summary(self):
        if not self.record:
            return None
        r = self.record
        return {k: r[k] for k in ('id', 'name', 'conversationKey', 'currentRevisionId', 'savedRevisionId')} | {'dirty': r['currentRevisionId'] != r['savedRevisionId'], 'history': list(reversed(r['history'])), 'canSave': bool(r['sourcePath']), 'canUndo': self._undo_target() is not None}

    def _undo_target(self):
        if not self.record:
            return None
        undone = {entry.get('undoneFrom') for entry in self.record['history'] if entry['kind'] == 'undo'}
        return next((entry for entry in reversed(self.record['history']) if entry['kind'] != 'undo' and entry.get('beforeRevisionId') and (entry['id'] not in undone)), None)

    def _check(self, project_id, revision):
        if not self.record or project_id != self.record['id'] or revision != self.record['currentRevisionId']:
            raise ValueError('工程状态已经变化，请读取当前状态后重试')

    def disk_status(self):
        if not self.record or not self.record['sourcePath']:
            return {'canReload': False, 'exists': None, 'changed': False, 'stale': False}
        source = Path(self.record['sourcePath'])
        try:
            # A status read compares bytes with the saved manifest. It does not
            # need to parse the whole circuit and rebuild a ProjectPackage.
            directory = self.workspace.state_root / 'revisions' / self.record['diskRevisionId']
            expected = json.loads((directory / 'metadata.json').read_text())
            current_sha = hashlib.sha256(source.read_bytes()).hexdigest()
            changed = current_sha != expected['artifactSha256']
            for item in expected.get('dependencies', []):
                file = source.parent / item['name']
                if file.resolve().parent != source.parent.resolve() or hashlib.sha256(file.read_bytes()).hexdigest() != item['sha256']:
                    changed = True
            if not changed:
                version = expected.get('sourceVersion')
                if version is None:
                    with (directory / 'artifact.circ').open('rb') as stream:
                        version = next(ET.iterparse(stream, events=('start',)))[1].get('source', '')
                resources = []
                for resource_id, file in ProjectPackage.reference_paths(source, version).items():
                    if file.is_file() and not file.is_symlink() and file.stat().st_size <= 4 * 1024 * 1024:
                        resources.append((resource_id, hashlib.sha256(file.read_bytes()).hexdigest()))
                changed = resources != [(r['id'], r['sha256']) for r in expected.get('resources', [])]
            return {'canReload': changed, 'exists': True, 'changed': changed, 'stale': changed, 'currentSha256': current_sha, 'reason': '磁盘工程已改变，保存前需要处理外部改动。' if changed else '磁盘工程未被外部修改。'}
        except Exception as error:
            return {'canReload': source.is_file(), 'exists': source.is_file(), 'changed': True, 'stale': True, 'reason': '无法确认磁盘工程：' + str(error)}

    def advance(self, kind, title, revision, *, saved_revision=None, prepared=None, **extra):
        record = copy.deepcopy(self.record)
        before = record['currentRevisionId']
        if before == revision and saved_revision is None:
            return self.workspace.session()
        if prepared is not None and (prepared.revision_id != revision or prepared.source_path != self.workspace.source_path):
            raise ValueError('待提交快照不属于当前修改')
        snapshot = prepared or self.workspace.project_store.prepare_revision(record, revision)
        record['currentRevisionId'] = revision
        if before != revision:
            record['history'].append(self._entry(kind, title, before, revision, **extra))
        if saved_revision is not None:
            record['savedRevisionId'] = record['diskRevisionId'] = saved_revision
        self._commit(record, snapshot)
        simulation = self.workspace.simulation
        simulation.close('电路已修改，运行状态已结束。重新启动将建立全新状态。' if simulation.record else None)
        return self.workspace.session()

    def undo(self, project_id, revision):
        self._check(project_id, revision)
        target = self._undo_target()
        if target is None:
            return self.workspace.session()
        return self.advance('undo', '撤销：' + target['title'], target['beforeRevisionId'], undoneFrom=target['id'])

    def apply(self, project_id, revision, candidate_id):
        self._check(project_id, revision)
        w = self.workspace
        directory, candidate = w.workbench._metadata(candidate_id)
        if self.disk_status()['changed']:
            raise ValueError('磁盘工程已改变，请先读取外部改动，再重新生成改动')
        package = copy.deepcopy(w.package)
        package.replace_artifact((directory / 'artifact.circ').read_bytes())
        snapshot = w.project_store.freeze((directory / 'artifact.circ').read_bytes(), w.source_mode, w.source_name, w.source_path, package=package)
        target = snapshot.revision_id
        return self.advance('apply', candidate['title'], target, candidateId=candidate_id, circuits=[c['circuit'] for c in candidate['changes']])

    def restore(self, project_id, revision, change_id):
        self._check(project_id, revision)
        entry = next((e for e in self.record['history'] if e['id'] == change_id), None)
        if not entry:
            raise ValueError('这个历史节点不属于当前工程')
        return self.advance('restore', '恢复：' + entry['title'], entry['revisionId'], restoredFrom=change_id)

    def _historical(self, project_id, change_id):
        if not self.record or project_id != self.record['id']:
            raise ValueError('工程已切换，请重新打开历史')
        entry = next((e for e in self.record['history'] if e['id'] == change_id), None)
        if not entry:
            raise ValueError('这个历史节点不属于当前工程')
        directory = self.workspace.state_root / 'revisions' / entry['revisionId']
        package = ProjectPackage.from_snapshot(directory, None)
        return (entry, directory, package)

    def review(self, project_id, change_id):
        entry, directory, package = self._historical(project_id, change_id)
        historical = {c.get('name'): c for c in ET.fromstring((directory / 'artifact.circ').read_bytes()).findall('circuit')}
        current = {c.get('name'): c for c in ET.fromstring(self.workspace.frozen_path.read_bytes()).findall('circuit')}

        def signature(node):
            return None if node is None else (node.tag, sorted(node.attrib.items()), (node.text or '').strip(), tuple((signature(c) for c in node)))

        def counts(node):
            return None if node is None else {'components': len(node.findall('comp')), 'wires': len(node.findall('wire'))}
        circuits = [{'name': name, 'different': signature(historical.get(name)) != signature(current.get(name)), 'historical': counts(historical.get(name)), 'current': counts(current.get(name))} for name in dict.fromkeys([*historical, *current])]
        evidence = None
        applied = next((e for e in reversed(self.record['history']) if e['revisionId'] == entry['revisionId'] and e.get('candidateId')), None)
        if applied:
            file = self.workspace.state_root / 'candidates' / applied['candidateId'] / 'candidate.json'
            if file.is_file():
                candidate = json.loads(file.read_text())
                if candidate.get('artifactSha256') == package.artifact_sha256:
                    evidence = {'candidateId': candidate['id'], 'checks': candidate.get('checks', []), 'executionReviews': candidate.get('executionReviews', [])}
        return {'entry': entry, 'currentRevisionId': self.record['currentRevisionId'], 'circuits': circuits, 'evidence': evidence, 'observations': self.observation_summaries(directory), 'countScope': 'serialized-components-and-wire-segments'}

    def observation_summaries(self, directory):
        summaries = []
        for file in sorted((directory / 'observations').glob('*.json')):
            report = json.loads(file.read_text())
            summaries.append({k: report[k] for k in ('id', 'kind', 'circuit', 'authority', 'ticks', 'passed', 'failed', 'rowCount') if k in report})
        return summaries

    def archive(self, project_id, revision):
        self._check(project_id, revision)
        w = self.workspace
        if not w.package.supported:
            raise ValueError('组件库未完整冻结，暂不能导出完整工程包：' + ' '.join(w.package.errors))
        w.package.verify_frozen(w.revision_dir)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.write(w.frozen_path, 'project/' + self.record['sourceName'])
            for name, payload in w.package.contents.items():
                archive.writestr('project/' + name, payload)
            for resource in w.package.resources:
                folder = 'project/' if resource['id'] == 'control-workbook' else 'RISC-V指令集手册/'
                archive.writestr(folder + resource['name'], w.package.resource_contents[resource['id']])
            for file in (w.revision_dir / 'observations').glob('*.json'):
                archive.write(file, 'observations/' + file.name)
            proof = self.review(project_id, self.record['history'][-1]['id'])['evidence']
            if proof:
                archive.writestr('evidence.json', json.dumps(proof, ensure_ascii=False))
                candidate_dir = w.state_root / 'candidates' / proof['candidateId']
                candidate = json.loads((candidate_dir / 'candidate.json').read_text())
                if candidate['artifactSha256'] != w.artifact_sha256:
                    raise ValueError('候选观察记录与导出版本不匹配')
                for dep in candidate.get('dependencies', []):
                    dep.pop('sourcePath', None)
                archive.writestr('evidence/candidate.json', json.dumps(candidate, ensure_ascii=False))
                for review in proof['executionReviews']:
                    filename = review.get('reportFile', '')
                    if re.fullmatch('instruction-review-[0-9a-f]{16}\\.json', filename):
                        archive.write(candidate_dir / filename, 'evidence/' + filename)
            archive.writestr('project-version.json', json.dumps({'revisionId': revision, 'artifactSha256': w.package.artifact_sha256, 'name': self.record['name']}, ensure_ascii=False))
        return buffer.getvalue()

    def render(self, project_id, change_id, name):
        _, directory, package = self._historical(project_id, change_id)
        root = ET.fromstring((directory / 'artifact.circ').read_bytes())
        if not any((c.get('name') == name for c in root.findall('circuit'))):
            raise ValueError('这个历史版本中没有该电路')
        if not package.supported:
            raise ValueError('此历史版本的组件库暂不支持原生预览')
        package.verify_frozen(directory)
        observer = type(self.workspace.observer)(self.workspace.repo_root, self.workspace.state_root)
        try:
            observer.runtime_jar = package.runtime(self.workspace.repo_root)
            profile = observer.profile()
            image = directory / 'exact' / profile['id'] / (hashlib.sha256(name.encode()).hexdigest() + '.png')
            if not image.is_file():
                document = observer.run_full(directory / 'artifact.circ', name, image)
                if document.get('revision', {}).get('artifactSha256') != package.artifact_sha256:
                    raise ValueError('历史预览与快照不匹配')
            return image.read_bytes()
        finally:
            observer.close()

    def reload(self):
        if not self.record or not self.record['sourcePath']:
            raise ValueError('当前工程没有磁盘源文件，请导出工程包')
        w = self.workspace
        source = Path(self.record['sourcePath'])
        data = source.read_bytes()
        target = w.project_store.freeze(data, 'path', source.name, source).revision_id
        return self.advance('import', '读取磁盘版本', target, saved_revision=target)

    def save(self, project_id, revision):
        self._check(project_id, revision)
        if not self.record['sourcePath']:
            raise ValueError('请导出工程包，为上传的工程选择保存位置')
        if self.disk_status()['changed']:
            raise ValueError('磁盘工程已改变，未覆盖文件。请先读取磁盘版本；当前改动仍在历史中。')
        w = self.workspace
        source = Path(self.record['sourcePath'])
        if source.is_symlink():
            raise ValueError('源文件已被替换为链接，已停止保存，请重新确认保存位置')
        current = w.package
        disk = json.loads((w.state_root / 'revisions' / self.record['diskRevisionId'] / 'metadata.json').read_text())
        if [(d['name'], d['sha256']) for d in current.dependencies] != [(d['name'], d['sha256']) for d in disk.get('dependencies', [])] or [(r['id'], r['sha256']) for r in current.resources] != [(r['id'], r['sha256']) for r in disk.get('resources', [])]:
            raise ValueError('当前版本的组件库或资料与磁盘不同，请导出完整工程包')
        payload = w.frozen_path.read_bytes()
        fd, temporary = tempfile.mkstemp(prefix='.vibe-save-', dir=source.parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, source.stat().st_mode & 511)
            if self.disk_status()['changed']:
                raise ValueError('保存期间磁盘工程发生变化，已停止保存')
            os.replace(temporary, source)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        record = copy.deepcopy(self.record)
        record['savedRevisionId'] = record['diskRevisionId'] = revision
        try:
            self._commit(record, w.project_store.state)
        except OSError as error:
            raise ValueError('电路文件已写入，但工作区保存状态未能记录。请读取磁盘版本恢复保存状态；当前改动仍保留。') from error
        return w.session()

