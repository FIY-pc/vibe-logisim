"""Resolve revision-local instance paths without conflating identical definitions."""
from collections import OrderedDict
import uuid
import xml.etree.ElementTree as ET


class InstanceViews:
    def __init__(self, workspace, root):
        self.w = workspace
        self.root = root
        self.scenes = {}
        self.registry = OrderedDict()
        self.current = self.prepare([])

    def scene(self, circuit):
        if circuit not in self.scenes:
            view = self.w.circuit_view(circuit)
            if view.get('observerError'):
                raise ValueError('这个模块暂时无法进行原生观察')
            self.scenes[circuit] = view['circuit']
        return self.scenes[circuit]

    def prepare(self, path):
        if not isinstance(path, list) or len(path) > 64:
            raise ValueError('运行实例路径无效')
        name = self.root
        resolved = []
        for entry in path:
            if not isinstance(entry, dict): raise ValueError('运行实例路径无效')
            scene = self.scene(name)
            component = next((c for c in scene['components'] if c['componentId'] == entry.get('componentId')), None)
            instance = next((i for i in scene['instances'] if component and i['location'] == component['location'] and i['target'] == component['factory']), None)
            if not instance: raise ValueError('运行实例路径已失效，请从父图重新进入')
            resolved.append({'componentId':component['componentId'], 'parentCircuit':name,
                             'circuit':instance['target'], 'label':component.get('label') or instance['target'],
                             'location':dict(component['location'])})
            name = instance['target']
        result = {'id':'view-' + uuid.uuid4().hex[:16], 'rootCircuit':self.root, 'circuit':name,
                  'instancePath':resolved, 'scope':'nested-instance' if resolved else 'standalone-root-instance'}
        self.scene(name)
        self.registry[result['id']] = result
        while len(self.registry) > 32: self.registry.popitem(last=False)
        return result

    def components(self, view):
        return {c['componentId']:c for c in self.scene(view['circuit'])['components']}

    def request(self, tag, view):
        request = ET.Element(tag, circuit=view['circuit'], viewId=view['id'])
        for entry in view['instancePath']:
            ET.SubElement(request, 'instance', factory=entry['circuit'], **{k:str(v) for k,v in entry['location'].items()})
        for id,c in self.components(view).items():
            ET.SubElement(request, 'component', id=id, factory=c['factory'], **{k:str(v) for k,v in c['location'].items()})
        return request
