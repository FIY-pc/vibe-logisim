// One binding per command. Contextual gestures (confirm, cancel, temporary pan,
// text editing and navigation) stay fixed and cannot be shadowed by a binding.
export const shortcutCommands = [
  {id:'select',label:'选择',group:'工具',key:'1',targets:['selectTool']},
  {id:'wire',label:'布线',group:'工具',key:'2',targets:['wireTool'],hint:'拖动松手落线；点击拐弯，Enter 完成，Esc 取消'},
  {id:'poke',label:'操作输入',group:'工具',key:'3',targets:['pokeTool'],hint:'首次点击自动启动仿真'},
  {id:'pan',label:'平移',group:'工具',key:'4',targets:['panTool'],hint:'按住空格可临时平移'},
  {id:'components',label:'添加元件',group:'工具',key:'A',targets:['componentsTab']},
  {id:'rotate',label:'旋转待放置元件',group:'工具',key:'R'},
  {id:'save',label:'保存',group:'编辑与视图',key:'Mod+S',targets:['saveButton']},
  {id:'undo',label:'撤销',group:'编辑与视图',key:'Mod+Z',targets:['undoButton']},
  {id:'find',label:'查找元件',group:'编辑与视图',key:'Mod+F',targets:['findObject']},
  {id:'circuitSearch',label:'查找电路',group:'编辑与视图',key:'/',targets:['circuitSearch']},
  {id:'fit',label:'适合窗口',group:'编辑与视图',key:'F',targets:['fitButton']},
  {id:'grid',label:'显示 / 隐藏网格',group:'编辑与视图',key:'G',targets:['gridToggle']},
  {id:'rail',label:'展开 / 收起项目栏',group:'编辑与视图',key:'Mod+B',targets:['toggleCircuits']},
  {id:'review',label:'展开 / 收起工作栏',group:'编辑与视图',key:'Mod+Alt+B',targets:['toggleReview']},
  {id:'clock',label:'运行 / 暂停时钟',group:'仿真',key:'Mod+K',targets:['simulationPlay','simulationQuickPlay']},
  {id:'tick',label:'时钟一步',group:'仿真',key:'Mod+T',targets:['simulationTick','simulationQuickTick']},
  {id:'propagation',label:'启用 / 暂停传播',group:'仿真',key:'Mod+E',targets:['simulationAutomatic']},
  {id:'step',label:'传播一步',group:'仿真',key:'Mod+I',targets:['simulationStep']},
  {id:'reset',label:'复位仿真',group:'仿真',key:'Mod+R',targets:['simulationReset','simulationQuickReset']},
  {id:'capture',label:'记录仿真时刻',group:'仿真',key:'F6',targets:['momentCapture']},
];

export const defaultBindings = Object.fromEntries(shortcutCommands.map(c=>[c.id,c.key]));
const punctuation = {Comma:',',Period:'.',Slash:'/',Semicolon:';',Quote:"'",BracketLeft:'[',BracketRight:']',Backslash:'\\',Minus:'-',Equal:'=',Backquote:'`'};
const modifiers = ['Mod','Ctrl','Meta','Alt','Shift'];
const fixed = new Map([
  ['Mod+,','快捷键设置'],['Mod+C','复制'],['Mod+X','剪切'],['Mod+V','粘贴'],['Mod+A','全选'],
  ['Mod+Shift+V','粘贴'],['Mod+Shift+Z','重做'],['Mod+Y','重做'],
  ['Mod+Shift+O','新对话'],['Mod+Shift+N','新建文件夹'],['Alt+ArrowLeft','返回上个位置'],
  ['F5','刷新'],['Mod+W','关闭窗口'],['Mod+Q','退出应用'],['Alt+F4','关闭窗口'],
  ['Mod+L','地址栏'],['Mod+N','新建窗口'],['Mod+O','打开文件'],['Mod+Shift+I','开发者工具'],
]);
const navigation = new Set(['Escape','Enter','Tab','Space','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown']);

export function normalizeBinding(value) {
  if(value===null)return null;
  if(typeof value!=='string')return undefined;
  const parts=value.split('+'), key=parts.pop(), mods=parts.filter(p=>modifiers.includes(p));
  if(!key||mods.length!==parts.length||new Set(mods).size!==mods.length)return undefined;
  if(!/^[A-Z0-9,./;'\[\]\\=\x60-]$/.test(key)&&!/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key)&&!navigation.has(key))return undefined;
  if(mods.includes('Mod')&&(mods.includes('Ctrl')||mods.includes('Meta')))return undefined;
  return [...modifiers.filter(m=>mods.includes(m)),key].join('+');
}

export function eventBinding(event, mac=false) {
  if(event.isComposing||event.keyCode===229||event.getModifierState?.('AltGraph'))return null;
  if(['Control','Meta','Alt','Shift','Dead','Unidentified'].includes(event.key))return null;
  const key=event.code?.startsWith('Digit')?event.code.slice(5):mac&&event.altKey&&event.code?.startsWith('Key')?event.code.slice(3):punctuation[event.code]||
    (event.key===' '?'Space':event.key.length===1?event.key.toUpperCase():event.key);
  const mods=[];
  if(mac?event.metaKey:event.ctrlKey)mods.push('Mod');
  if(mac?event.ctrlKey:event.metaKey)mods.push(mac?'Ctrl':'Meta');
  if(event.altKey)mods.push('Alt');
  if(event.shiftKey)mods.push('Shift');
  return normalizeBinding([...mods,key].join('+'))||null;
}

export function bindingLabel(binding, mac=false) {
  return binding?.split('+').map(key=>key==='Mod'?(mac?'⌘':'Ctrl'):key==='Meta'?'⌘':key==='Alt'&&mac?'⌥':key).join('+')||'未设置';
}

export function bindingProblem(id, binding, bindings) {
  if(binding===null)return null;
  if(typeof binding!=='string'||normalizeBinding(binding)!==binding)return '不支持这个组合键';
  const key=binding.split('+').at(-1);
  if(navigation.has(key))return '此键保留用于确认、取消、导航或删除';
  if(fixed.has(binding))return `此快捷键保留用于「${fixed.get(binding)}」`;
  const other=shortcutCommands.find(c=>c.id!==id&&bindings[c.id]===binding);
  return other?`已用于「${other.label}」，请选择其他键`:null;
}

export function resolveBindings(overrides) {
  if(!overrides||typeof overrides!=='object'||Array.isArray(overrides))throw new Error('快捷键配置格式无效');
  const bindings={...defaultBindings};
  for(const c of shortcutCommands)if(Object.hasOwn(overrides,c.id))bindings[c.id]=normalizeBinding(overrides[c.id]);
  for(const c of shortcutCommands){const error=bindingProblem(c.id,bindings[c.id],bindings);if(error)throw new Error(`${c.label}：${error}`);}
  return bindings;
}

export function bindingOverrides(bindings) {
  return Object.fromEntries(shortcutCommands.filter(c=>bindings[c.id]!==c.key).map(c=>[c.id,bindings[c.id]]));
}
