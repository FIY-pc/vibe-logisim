"""Source adapter for editable symbols; Pin location identifies an existing port.

The runtime supplies the initial appearance, including default symbols. The
client edits a draft, never XML or runtime traversal indices. Unknown artwork
is retained unchanged. The insertion anchor remains fixed during this edit.
"""
import copy
import re
import xml.etree.ElementTree as ET

SHAPES = {'rect','ellipse','line','polyline','polygon','path','text'}
ATTRS = {'x','y','width','height','rx','ry','cx','cy','r','x1','x2','y1','y2',
         'points','d','fill','stroke','stroke-width','font-family','font-size',
         'font-weight','font-style','text-anchor','dominant-baseline'}
GEOMETRY = {'x','y','width','height','rx','ry','cx','cy','r','x1','x2','y1','y2','stroke-width','font-size'}


def number(value, *, grid=False, low=-6000, high=6000):
    if isinstance(value,bool): raise ValueError('位置或尺寸无效')
    try: result = int(value)
    except (ValueError,TypeError,OverflowError) as error: raise ValueError('位置或尺寸无效') from error
    if str(result) != str(value) and result != value: raise ValueError('位置或尺寸必须是整数')
    if not low <= result <= high or grid and result % 10: raise ValueError('端口位置需对齐 10 格网，且不能超出画布')
    return result


def read_symbol(native):
    symbol = native.find('symbol')
    appearance = symbol.find('appear')
    ports = {p.get('pin'):p for p in appearance.findall('circ-port')}
    pins = []
    for pin in symbol.findall('pin'):
        visual = ports.get(pin.get('id'))
        if visual is None: raise ValueError('封装中存在未映射的引脚，请先在 Logisim 中修复')
        pins.append({'id':pin.get('id'),'label':pin.get('label'),'direction':pin.get('direction'),
                     'width':int(pin.get('width')),'internalX':int(pin.get('x')),'internalY':int(pin.get('y')),
                     'x':int(visual.get('x'))+int(visual.get('width'))//2,
                     'y':int(visual.get('y'))+int(visual.get('height'))//2,'disconnect':False})
    shapes = [{'id':f'shape-{i}','tag':shape.tag,'attrs':dict(shape.attrib),'text':shape.text or '',
               'editable':shape.tag in SHAPES} for i,shape in enumerate(appearance) if not shape.tag.startswith('circ-')]
    anchor = appearance.find('circ-anchor')
    if anchor is None: raise ValueError('封装缺少放置基点')
    uses = [{'circuit':u.get('circuit'),'x':int(u.get('x')),'y':int(u.get('y')),'facing':u.get('facing'),
             'ports':{p.get('pin'):{'index':int(p.get('index')),'x':int(p.get('x')),'y':int(p.get('y'))} for p in u.findall('port')}}
            for u in symbol.findall('use')]
    return {'ports':sorted(pins,key=lambda p:(p['y'],p['x'])), 'shapes':shapes,
            'anchor':dict(anchor.attrib),'default':symbol.get('default')=='true','uses':uses}


def write_symbol(root, name, baseline, draft):
    if not isinstance(draft,dict) or not isinstance(draft.get('ports'),list) or not isinstance(draft.get('shapes'),list):
        raise ValueError('封装草稿无效')
    if len(draft['ports']) > 128 or len(draft['shapes']) > 512: raise ValueError('封装对象过多')
    circuit=next(c for c in root.findall('circuit') if c.get('name')==name)
    old={p['id']:p for p in baseline['ports']}; updated={}; occupied=set()
    for value in draft['ports']:
        p=copy.deepcopy(value); key=p.get('id')
        if not isinstance(key,str) or key in updated or key not in old and not re.fullmatch(r'new-[\w-]{1,60}',key):
            raise ValueError('端口标识无效或重复')
        if not isinstance(p.get('label'),str) or len(p['label'])>120: raise ValueError('端口名称过长')
        if p.get('direction') not in ('input','output'): raise ValueError('请选择输入或输出')
        p['width']=number(p.get('width'),low=1,high=32)
        for k in ('x','y'): p[k]=number(p.get(k),grid=True)
        if (p['x'],p['y']) in occupied: raise ValueError('两个端口不能放在同一位置')
        occupied.add((p['x'],p['y']))
        if key in old:
            p.update({k:old[key][k] for k in ('internalX','internalY')})
        else:
            for k in ('internalX','internalY'): p[k]=number(p.get(k),grid=True,low=0)
        updated[key]=p
    appearance=ET.Element('appear')
    old_shapes={s['id']:s for s in baseline['shapes']}; shape_ids=set()
    for s in draft['shapes']:
        if not isinstance(s,dict) or not isinstance(s.get('id'),str) or s['id'] in shape_ids: raise ValueError('图形对象标识无效')
        shape_ids.add(s['id'])
        if s.get('tag') not in SHAPES:
            if s != old_shapes.get(s['id']): raise ValueError('此图形暂不能编辑')
        elif not isinstance(s.get('attrs'),dict) or not s['attrs'].keys() <= ATTRS:
            raise ValueError('封装图形属性无效')
        attrs={k:str(v) for k,v in s['attrs'].items()}
        if any(len(v)>10000 for v in attrs.values()) or any('url(' in v.lower() for v in attrs.values()):
            raise ValueError('封装图形属性无效')
        if len(str(s.get('text','')))>2000: raise ValueError('封装文字过长')
        for key in GEOMETRY & attrs.keys():
            low=1 if key in ('width','height','rx','ry','r','font-size') else 0 if key=='stroke-width' else -6000
            number(attrs[key],low=low)
        ET.SubElement(appearance,s['tag'],attrs).text=str(s.get('text',''))
    for key,p in updated.items():
        radius=4 if p['direction']=='input' else 5
        ET.SubElement(appearance,'circ-port',{'pin':f"{p['internalX']},{p['internalY']}",'x':str(p['x']-radius),
            'y':str(p['y']-radius),'width':str(radius*2),'height':str(radius*2)})
    ET.SubElement(appearance,'circ-anchor',baseline['anchor'])
    previous=circuit.find('appear')
    if previous is not None:circuit.remove(previous)
    circuit.insert(0,appearance)
    wiring=next((lib.get('name') for lib in root.findall('lib') if lib.get('desc')=='#Wiring'),None)
    if wiring is None:raise ValueError('工程未包含原生 Wiring 库')
    for key in old:
        targets=[c for c in circuit.findall('comp') if c.get('name')=='Pin' and c.get('loc')==f'({key})']
        if len(targets)!=1:raise ValueError('内部引脚无法唯一对应')
        if key not in updated:circuit.remove(targets[0]);continue
        _pin_attributes(targets[0],updated[key])
    for key,p in updated.items():
        if key in old:continue
        loc=f"({p['internalX']},{p['internalY']})"
        if any(c.get('loc')==loc for c in circuit.findall('comp')): raise ValueError('新增引脚的位置已被占用')
        node=ET.SubElement(circuit,'comp',{'name':'Pin','lib':wiring,'loc':loc})
        _pin_attributes(node,p)
        ET.SubElement(node,'a',name='tristate',val='false')
        ET.SubElement(node,'a',name='facing',val='east' if p['direction']=='input' else 'west')
    return updated


def assert_artwork(draft,accepted):
    if len(draft['shapes'])!=len(accepted['shapes']):raise ValueError('原生运行时未接受全部封装图形')
    for requested,actual in zip(draft['shapes'],accepted['shapes']):
        if requested['tag']!=actual['tag'] or str(requested.get('text',''))!=actual['text']:
            raise ValueError('原生运行时未接受封装图形或文字')
        for key in GEOMETRY & requested['attrs'].keys():
            if key not in actual['attrs'] or float(requested['attrs'][key])!=float(actual['attrs'][key]):
                raise ValueError('原生运行时未接受封装图形尺寸或位置')


def _pin_attributes(node,pin):
    for key,value in {'label':pin['label'],'width':str(pin['width']),'output':str(pin['direction']=='output').lower()}.items():
        attr=next((a for a in node.findall('a') if a.get('name')==key),None)
        if attr is None:attr=ET.SubElement(node,'a',name=key)
        attr.set('val',value)
