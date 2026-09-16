"""One read-only comparison contract for candidates and human edit history.

Resolve owned snapshots first. Native observations are lazy per definition,
cached with their runtime, and never temporarily become the current project.
"""
import copy
import hashlib
import threading
from pathlib import Path
from urllib.parse import urlencode
import xml.etree.ElementTree as ET

from studio.infrastructure.files import read_json, atomic_write_json
from studio.project.package import ProjectPackage
from studio.project.changes import signature
from studio.project.comparison import describe_changes
from studio.runtime.observer import ObserverRuntime
from studio.runtime.rendering import RenderInput, viewport
from studio.infrastructure.files import sha256_file


class ComparisonService:
    def __init__(self, workspace):
        self.w = workspace
        self._native_lock = threading.Lock()

    def _snapshot(self, revision):
        directory = self.w.state_root/'revisions'/revision
        package = ProjectPackage.from_snapshot(directory, None)
        package.verify_frozen(directory)
        return directory, package

    def _resolve(self, args):
        w = self.w
        w.application._revision(args)
        kind = args.get('kind')
        if kind == 'candidate':
            directory, candidate = w.workbench._metadata(args.get('id'), allow_applied=True)
            before = self._snapshot(candidate['baseRevisionId'])
            package = copy.deepcopy(before[1]); package.replace_artifact((directory/'artifact.circ').read_bytes())
            package.verify_frozen(directory)
            after = directory, package
            identity = {'title':candidate['title'], 'canApply':w.workbench.candidate._access().is_pending(candidate),
                        'canRestore':False, 'candidateId':candidate['id'], 'beforeLabel':'修改前', 'afterLabel':'修改后'}
        elif kind == 'history':
            entry, directory, package = w.history._historical(args['projectId'], args.get('id'))
            change_mode = bool(entry.get('beforeRevisionId')) and args.get('mode') != 'current'
            before = self._snapshot(entry['beforeRevisionId']) if change_mode else (directory, package)
            after = (directory, package) if change_mode else self._snapshot(w.revision_id)
            applied = next((e for e in reversed(w.history.record['history'])
                            if e['revisionId']==entry['revisionId'] and e.get('candidateId')),None)
            identity = {'title':entry['title'], 'canApply':False, 'canRestore':entry['revisionId']!=w.revision_id,
                        'candidateId':applied['candidateId'] if applied else None,
                        'changeId':entry['id'], 'canCompareChange':bool(entry.get('beforeRevisionId')),
                        'restoreSide':'after' if change_mode else 'before',
                        'beforeLabel':'修改前' if change_mode else '所选历史版本', 'afterLabel':'修改后' if change_mode else '当前工程'}
        else: raise ValueError('未知改动来源')
        return before, after, identity

    def _native(self, snapshot, name):
        # Concurrent image/detail requests share the same frozen cache entry.
        with self._native_lock:
            return self._read_native(snapshot, name)

    def _read_native(self, snapshot, name):
        directory, package = snapshot
        if not package.supported: raise ValueError('该版本的组件库不能精确加载')
        observer = ObserverRuntime(self.w.repo_root, self.w.state_root)
        try:
            observer.runtime_jar = package.runtime(self.w.repo_root)
            profile = observer.profile()
            cache = directory/'comparison-native'/profile['id']/(hashlib.sha256(name.encode()).hexdigest()+'.json')
            document = read_json(cache)
            if not document or not cache.with_suffix('.png').is_file():
                document = observer.run_full(directory/'artifact.circ', name, cache.with_suffix('.png'))
                atomic_write_json(cache, document)
            if document['revision']['artifactSha256'] != package.artifact_sha256 or document['runtime']['jarSha256'] != profile['runtimeJarSha256']:
                raise ValueError('对照图与冻结版本不匹配')
            focus = document['focus']
            components = [{**c, 'factory':c['factoryName'], 'label':c.get('selector',{}).get('label'),
                'attributes':{a['name']:a.get('standard') for a in c['attributes']}} for c in focus['components']]
            # Keep the response focused on drawing and port relationships.
            compact = [{k:c.get(k) for k in ('componentId','factory','label','location','bounds','attributes','ends','subcircuit')} for c in components]
            return {'components':compact, 'coverage':document.get('coverage',{}), 'render':document['render'], 'runtimeSha':profile['runtimeJarSha256'], 'png':cache.with_suffix('.png')}
        finally: observer.close()

    def describe(self, args):
        with self.w.lock:
            before, after, identity = self._resolve(args)
            roots = [ET.fromstring((d/'artifact.circ').read_bytes()) for d,p in (before,after)]
            definitions = [{c.get('name'):c for c in root.findall('circuit')} for root in roots]
            names = list(dict.fromkeys([*definitions[0], *definitions[1]]))
            circuits = [{'name':n, 'different':signature(definitions[0].get(n))!=signature(definitions[1].get(n)),
                'status':'added' if n not in definitions[0] else 'removed' if n not in definitions[1] else 'modified'} for n in names]
            settings = lambda root: (sorted(root.attrib.items()), tuple(signature(c) for c in root if c.tag!='circuit'))
            result = {**identity, 'kind':args['kind'], 'id':args['id'], 'projectId':args['projectId'],
                'revisionId':args['revisionId'], 'circuits':circuits, 'settingsChanged':settings(roots[0])!=settings(roots[1]),
                'sides':{side:{'revisionId':p.revision_id, 'artifactSha256':p.artifact_sha256,
                               'current':p.revision_id==self.w.revision_id} for side,(d,p) in zip(('before','after'),(before,after))}}
            name = args.get('circuit')
            if name is None: return result
            if name not in names: raise ValueError('对照中没有这个电路')
            # Capture immutable snapshots under the project lock, then observe
            # outside it so viewing old work does not block editing current work.
        views, errors = [], []
        for index, snapshot in enumerate((before,after)):
            if name not in definitions[index]: views.append(None); continue
            try: views.append(self._native(snapshot,name))
            except Exception as error: views.append(None); errors.append(str(error))
        comparable = not errors and (not all(views) or views[0]['runtimeSha']==views[1]['runtimeSha'])
        diff = describe_changes(definitions[0].get(name), definitions[1].get(name), *views, native_comparable=comparable)
        render = {}
        for side, view in zip(('before','after'),views):
            if view: render[side] = {**view['render'], 'url':'/api/comparison/render?'+urlencode({**args,'side':side})}
        parents = {}
        for side, root in zip(('before','after'),roots):
            parents[side] = [{'circuit':c.get('name'), 'count':sum(p.get('name')==name and p.get('lib') is None for p in c.findall('comp'))}
                for c in root.findall('circuit') if any(p.get('name')==name and p.get('lib') is None for p in c.findall('comp'))]
        with self.w.lock:
            self._resolve(args)  # Reject a result arriving after an edit or switch.
        return {**result, 'circuit':name, 'diff':diff, 'render':render, 'parents':parents, 'errors':errors}

    def render(self, args):
        with self.w.lock:
            before, after, _ = self._resolve(args)
            if args.get('side') not in ('before','after'): raise ValueError('未知对照版本')
            snapshot = before if args['side']=='before' else after
        if 'scale' in args:
            directory, package = snapshot
            runtime = package.runtime(self.w.repo_root)
            data = self.w.renderer.render(RenderInput(directory/'artifact.circ', package.artifact_sha256, runtime,
                sha256_file(runtime)), args.get('circuit'), viewport(args))
        else:
            view = self._native(snapshot, args.get('circuit'))
            data = view['png'].read_bytes()
        with self.w.lock: self._resolve(args)
        return data
