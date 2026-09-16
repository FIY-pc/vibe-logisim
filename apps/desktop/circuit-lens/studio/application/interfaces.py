"""One symbol/interface edit, including all direct parent instances.

Draft preparation never switches the active project. Native correspondence and
connection checks precede the single history publication. The UI and optional
callers use this same application boundary.
"""
import copy
import hashlib
import json
import threading
import uuid
import xml.etree.ElementTree as ET
from studio.project.symbol_document import read_symbol, write_symbol, assert_artwork
from studio.domain.port_relocation import reconnect, assert_connections, assert_isolated


def component_key(c):
    return c['factory'],c['location']['x'],c['location']['y']


def use_key(u):return u['circuit'],u['x'],u['y']


def correspondences(scene,after,before_symbol,after_symbol,name,circuit,detached):
    old_uses={use_key(u):u for u in before_symbol['uses']}
    new_uses={use_key(u):u for u in after_symbol['uses']}
    components=copy.deepcopy(after['components'])
    lookup={component_key(c):c for c in components}
    # New terminals must not borrow a net observed from still-unadjusted wires.
    for c in components:
        for e in c['ends']:
            e['netBits']=[{'bit':i,'netId':f"new:{c['componentId']}:{e['index']}:{i}"} for i in range(e.get('width') or 0)]
    pairs=[];changes={}
    after_lookup={component_key(c):c for c in after['components']}
    for old in scene['components']:
        key=component_key(old);new=lookup.get(key);actual=after_lookup.get(key)
        use=old_uses.get((circuit,key[1],key[2])) if key[0]==name else None
        old_ports={p['index']:pin for pin,p in use['ports'].items()} if use else {}
        following=new_uses.get(use_key(use)) if use else None
        for end in old['ends']:
            index=end['index']; pin=old_ports.get(index)
            if circuit==name and old['factory']=='Pin':pin=f'{key[1]},{key[2]}'
            target_index=following['ports'].get(pin,{}).get('index') if use and following else index
            target=next((e for e in new['ends'] if e['index']==target_index),None) if new else None
            if target is None or pin in detached:
                changes[(old['componentId'],index)]=None;continue
            real=next(e for e in actual['ends'] if e['index']==target_index)
            pairs.append((end,real))
            old_bits={b['bit']:b for b in end['netBits']}
            target['netBits']=[copy.deepcopy(old_bits.get(b['bit'],b)) for b in target['netBits']]
            position=(target['location']['x'],target['location']['y'])
            if target['location']!=end['location']:changes[(old['componentId'],index)]=position
    return components,changes,pairs


class InterfaceService:
    def __init__(self,workspace,inspect_snapshot):
        self.w=workspace;self.inspect=inspect_snapshot
        self.prepared={};self.preparing=threading.Lock()

    def native(self,path,name):
        return read_symbol(self.w.workbench._native(path,ET.Element('interface',circuit=name)))

    def read(self,args):
        w=self.w
        with w.lock:
            w.application._revision(args);name=args.get('circuit')
            scene=w.circuit_view(name)['circuit']
            data=self.native(w.frozen_path,name)
            bounds=scene['bounds']
            return {**data,'projectId':args['projectId'],'revisionId':args['revisionId'],'circuit':name,
                    'newPinLocation':{'x':100,'y':((bounds['y']+bounds['height'])//10+6)*10}}

    def freeze(self,root):
        w=self.w;data=ET.tostring(root,encoding='utf-8',xml_declaration=True)
        package=copy.deepcopy(w.package);package.replace_artifact(data)
        return w.project_store.freeze(data,w.source_mode,w.source_name,w.source_path,package=package)

    def prepare(self,args):
        with self.preparing:return self._prepare(args)

    def _prepare(self,args):
        w=self.w;name=args.get('circuit')
        with w.lock:
            w.application._revision(args)
            if w.history.disk_status()['changed']:raise ValueError('磁盘工程已改变，请先处理外部改动')
            before=self.native(w.frozen_path,name)
            if args.get('draft')=={k:before[k] for k in ('ports','shapes')}:
                return self.remember(args,None,[],len(before['ports']),0,0)
            root=ET.fromstring(w.frozen_path.read_bytes())
            updated=write_symbol(root,name,before,args.get('draft'))
            detached={p['id'] for p in before['ports'] if p['id'] not in updated or updated[p['id']].get('disconnect')}
            names=list(dict.fromkeys([name,*(u['circuit'] for u in before['uses'])]))
            scenes={n:copy.deepcopy(w.circuit_view(n)) for n in names}
            initial=self.freeze(root)
        proposed=self.native(initial.frozen_path,name)
        impacts=[]
        for n in names:
            old=scenes[n]['circuit'];loaded=self.inspect(initial,n)
            components,changes,_=correspondences(old,loaded,before,proposed,name,n,detached)
            try:
                if changes:
                    segments=reconnect(old,components,changes)
                    circuit=next(c for c in root.findall('circuit') if c.get('name')==n)
                    for wire in list(circuit.findall('wire')):circuit.remove(wire)
                    for a,b in segments:
                        ET.SubElement(circuit,'wire',{'from':f'({a[0]},{a[1]})','to':f'({b[0]},{b[1]})'})
                self.check_collision(old,components)
            except ValueError as error:raise ValueError(f'{n}：{error}') from error
            impacts.append({'circuit':n,'instances':sum(u['circuit']==n for u in before['uses']),
                            'movedPorts':sum(p is not None for p in changes.values()),
                            'detachedPorts':sum(p is None for p in changes.values())})
        with w.lock:
            w.application._revision(args);final=self.freeze(root)
        for n in names:
            loaded=self.inspect(final,n)
            _,_,pairs=correspondences(scenes[n]['circuit'],loaded,before,proposed,name,n,detached)
            try:
                for key in ('invalidBundleEnds','widthIncompatibilities'):
                    if loaded.get('coverage',{}).get(key,0)>scenes[n].get('coverage',{}).get(key,0):
                        raise ValueError('接线位宽不再匹配；请同步调整电路，或为更改的端口选择「断开接线」')
                assert_connections(pairs)
                self.check_detached(loaded,before,proposed,name,n,detached)
            except ValueError as error:raise ValueError(f'{n}：{error}') from error
        # Native placement must accept the intended appearance, not silently
        # discard an invalid port or restore an old default symbol.
        accepted=self.native(final.frozen_path,name)
        assert_artwork(args['draft'],accepted)
        actual={p['id']:p for p in accepted['ports']}
        for p in updated.values():
            key=f"{p['internalX']},{p['internalY']}";target=actual.get(key)
            if not target or any(p[k]!=target[k] for k in ('label','direction','width','x','y')):
                raise ValueError('原生运行时未接受端口定义或位置')
        old_ids={p['id'] for p in before['ports']}
        return self.remember(args,final,impacts,len(updated),len(updated.keys()-old_ids),len(old_ids-updated.keys()))

    def remember(self,args,snapshot,impacts,count,added,removed):
        w=self.w;token='interface-'+uuid.uuid4().hex
        result={'previewId':token,'projectId':args['projectId'],'revisionId':args['revisionId'],
                'circuit':args['circuit'],'impacts':impacts,'ports':count,'addedPorts':added,
                'removedPorts':removed,'changed':snapshot is not None and snapshot.revision_id!=args['revisionId']}
        with w.lock:
            w.application._revision(args)
            self.prepared[token]={'result':result,'snapshot':snapshot,'digest':self.digest(args.get('draft'))}
            while len(self.prepared)>6:del self.prepared[next(iter(self.prepared))]
        return result

    @staticmethod
    def check_detached(scene,before,after,name,circuit,detached):
        disconnected={p['id'] for p in after['ports']}-{p['id'] for p in before['ports']}|detached
        uses={use_key(u):u for u in after['uses']};terminals=set()
        for c in scene['components']:
            key=component_key(c)
            if circuit==name and c['factory']=='Pin' and f'{key[1]},{key[2]}' in disconnected:
                terminals.update((c['componentId'],e['index']) for e in c['ends'])
            use=uses.get((circuit,key[1],key[2])) if c['factory']==name else None
            if use:terminals.update((c['componentId'],p['index']) for pin,p in use['ports'].items() if pin in disconnected)
        assert_isolated(scene,terminals)

    def apply(self,args):
        w=self.w
        with w.lock:
            w.application._revision(args)
            if w.history.disk_status()['changed']:raise ValueError('磁盘工程已改变，请先处理外部改动')
            item=self.prepared.get(args.get('previewId'))
        if item is None:
            result=self.prepare(args)
            with w.lock:item=self.prepared[result['previewId']]
        with w.lock:
            w.application._revision(args)
            if w.history.disk_status()['changed']:raise ValueError('磁盘工程已改变，请先处理外部改动')
            result=item['result']
            if any(result[k]!=args.get(k) for k in ('projectId','revisionId','circuit')) or item['digest']!=self.digest(args.get('draft')):
                raise ValueError('封装草稿或工程已经改变，请重新预览')
            if not result['changed']:return w.session()
            return w.history.advance('interface',f"{args['circuit']} · 封装与接口",item['snapshot'].revision_id,
                                     circuits=[i['circuit'] for i in result['impacts']],interfaceImpact=result['impacts'])

    @staticmethod
    def digest(draft):return hashlib.sha256(json.dumps(draft,sort_keys=True).encode()).hexdigest()

    @staticmethod
    def check_collision(before,after):
        old={component_key(c):c for c in before['components']}
        def area(a,b):
            return max(0,min(a['x']+a['width'],b['x']+b['width'])-max(a['x'],b['x']))*max(0,min(a['y']+a['height'],b['y']+b['height'])-max(a['y'],b['y']))
        for i,a in enumerate(after):
            original=old.get(component_key(a))
            if original and original['bounds']==a['bounds']:continue
            if a['factory']=='Text':continue
            for j,b in enumerate(after):
                if i==j or b['factory'] in ('Text','Tunnel'):continue
                prior=old.get(component_key(b))
                previous=area(original['bounds'],prior['bounds']) if original and prior else 0
                if area(a['bounds'],b['bounds'])>previous:raise ValueError('封装或新增引脚与其他元件重叠，请调整位置或尺寸')
