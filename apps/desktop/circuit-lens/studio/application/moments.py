"""User-kept runtime moments, independent of the live session and project history."""
import copy
import json
import re
from datetime import datetime, timezone
from studio.domain.references import object_link
from studio.project.history import write_json




class Moments:
    def __init__(self, workspace):
        self.w = workspace

    def directory(self, project):
        allowed = set((self.w.folder or {}).get('documentIds', []))
        if self.w.history.record:
            allowed.add(self.w.history.record['id'])
        if not isinstance(project, str) or not re.fullmatch(r'project-[a-f0-9]{16}', project) or project not in allowed:
            raise ValueError('这些观察属于另一份工程')
        return self.w.state_root / 'moments' / project

    def path(self, project, id):
        if not isinstance(id,str) or not re.fullmatch(r'live-[a-f0-9]{16}',id):
            raise ValueError('观察引用无效')
        return self.directory(project) / (id + '.json')

    def read(self, project, id):
        path = self.path(project,id)
        if not path.is_file(): raise ValueError('未找到这份留存观察')
        result = json.loads(path.read_text(encoding="utf-8"))
        if result['projectId'] != project: raise ValueError('观察不属于当前工程')
        return result

    @staticmethod
    def summary(moment):
        return {k:v for k,v in moment.items() if k not in {'render','sample'}}

    def list(self, project):
        items = [json.loads(p.read_text(encoding="utf-8")) for p in self.directory(project).glob('live-*.json')]
        return [self.summary(m) for m in sorted(items,key=lambda m:m['createdAt'],reverse=True) if not m.get('archived')]

    def capture(self, body):
        self.w.application._revision(body)
        project,id = body['projectId'],body.get('observationId')
        path = self.path(project,id)
        if path.is_file():
            result = self.read(project,id);result['archived']=False
        else:
            sample = self.w.simulation.observation(body['revisionId'],id)
            render = self.w.simulation.frame_image(id, body.get('render'))
            scene = self.w.circuit_view(sample['circuit'])['circuit']
            components = {c['componentId']:c for c in scene['components']}
            keys = body.get('signals',[])
            if not isinstance(keys,list) or len(keys)>24 or any(not isinstance(k,str) for k in keys):
                raise ValueError('一次可以保留最多 24 个信号')
            available = {f"{c['componentId']}:{p['index']}":(c,p) for c in sample['components'] for p in c['ports']}
            if not keys:
                keys = [k for k,(c,p) in available.items() if c['label'] and p['index']==0 and c['factory'] in {'Pin','Register','Probe','Clock','Button'}][:24]
            signals=[]
            for key in dict.fromkeys(keys):
                if key not in available: raise ValueError('信号已变化，请重新选择')
                c,p = available[key];shape=components[c['componentId']]
                signals.append({'key':key,'componentId':c['componentId'],'factory':c['factory'],
                    'label':c['label'] or c['factory'],'location':shape['location'], 'portIndex':p['index'],
                    **{k:p.get(k) for k in ['bits','width','value','name']},
                    'reference':object_link(project,body['revisionId'],sample['circuit'],c['componentId'],sample)})
            result={k:copy.deepcopy(sample[k]) for k in ['id','projectId','revisionId','sessionId','rootCircuit','circuit','instancePath','ticks','sequence','pending','oscillating']}
            result.update(title=f"{sample['circuit']} · 时刻 {len(list(self.directory(project).glob('live-*.json'))) + 1}",createdAt=datetime.now(timezone.utc).isoformat(),
                signals=signals,render=render,sample=sample,archived=False)
        write_json(path,result)
        return result

    def inspect(self, args):
        m=self.read(args.get('projectId') or (self.w.history.record or {}).get('id'),args.get('observationId'))
        components=m['sample']['components']
        ids=args.get('componentIds') or []
        if not isinstance(ids,list) or len(ids)>16 or any(not isinstance(id,str) for id in ids):raise ValueError('一次读取最多 16 个元件')
        if ids:components=[c for c in components if c['componentId'] in ids]
        offset,limit=args.get('offset',0),args.get('limit',8)
        if not isinstance(offset,int) or offset<0 or not isinstance(limit,int) or not 1<=limit<=16:raise ValueError('观察分页无效')
        page=copy.deepcopy(components[offset:offset+limit])
        for c in page:c['reference']=object_link(m['projectId'],m['revisionId'],m['circuit'],c['componentId'],m)
        return {**self.summary(m),'currentRevisionId':self.w.revision_id,'components':page,
                'totalComponents':len(components),'offset':offset,'nextOffset':offset+limit if offset+limit<len(components) else None,
                'note':'Frozen kept observation. Values and component IDs belong to its recorded revision and instance, not necessarily the current circuit. Unobserved intervals are unknown.'}

    def action(self, body):
        with self.w.lock:
            if body.get('action')=='capture':return self.capture(body)
            result=self.read(body.get('projectId'),body.get('id'))
            if body.get('action')=='rename':
                title=body.get('title')
                if not isinstance(title,str) or not title.strip() or len(title)>80:raise ValueError('名称需要 1–80 个字符')
                result['title']=title.strip()
            elif body.get('action')=='archive':result['archived']=True
            else:raise ValueError('未知观察操作')
            write_json(self.path(result['projectId'],result['id']),result)
            return self.summary(result)
