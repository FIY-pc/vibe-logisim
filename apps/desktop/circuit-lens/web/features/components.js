import {makeElement} from '../core/dom.js';
import {icon} from '../core/chat-dom.js';
import {componentLabels,groupLabels} from '../core/component-labels.js';

export const modelDependencies=['project'];
export const dependencies=['startPlacement','cancelPlacement','setWorkspacePanel'];

export function createController({models,client,ports}) {
  const node=id=>document.getElementById(id),project=models.project;
  let tab='files',catalog=null,binding='',epoch=0,selected='',loading=false;
  const expanded=new Set(['Wiring','Gates','Subcircuits']);
  function chooseTab(value,{focus=false}={}) {
    tab=value;node('fileExplorer').dataset.resource=value;
    for(const name of ['files','components']) {
      const active=tab===name;node(name+'Tab').setAttribute('aria-selected',String(active));node(name+'Tab').tabIndex=active?0:-1;node(name+'Pane').hidden=!active;
    }
    node('addComponentTool').setAttribute('aria-expanded',String(tab==='components'));
    if(value==='components') {
      if(node('collapseFiles').getAttribute('aria-expanded')==='false')node('collapseFiles').click();
      load();if(focus)node('componentSearch').focus();
    }
  }
  function openComponents(){ports.setWorkspacePanel('rail',true);chooseTab('components',{focus:true});}
  function componentsContextChanged() {
    if (!project.circuit && tab === 'components') chooseTab('files');
    const current=[project.session?.workspace?.id,project.session?.componentCatalogId||project.revision,project.circuitName].join(':');
    node('addComponentTool').disabled=!project.circuit||project.sourceChanged||project.projectBusy;
    if(binding!==current){binding=current;epoch++;catalog=null;loading=false;}
    if(tab==='components'&&!catalog&&!loading)load();
  }
  async function load() {
    if(catalog||loading)return;
    const list=node('componentLibrary');list.replaceChildren();
    if(!project.circuit){list.append(makeElement('p','library-empty','先从文件中打开或新建一份电路。'));return;}
    const token=++epoch;loading=true;list.append(makeElement('p','library-empty','正在读取元件库…'));
    try {
      const result=await client.request('/api/components/catalog',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:project.session.workspace.id,revisionId:project.revision,circuit:project.circuitName})});
      if(token!==epoch)return;catalog=result;render();
    } catch(error) {
      if(token!==epoch)return;list.replaceChildren(makeElement('p','library-empty',error.message));
      const retry=makeElement('button','quiet-button library-retry','重新读取');retry.addEventListener('click',()=>load());list.append(retry);
    } finally {if(token===epoch)loading=false;}
  }
  function tools(group) {
    return group.tools.flatMap(tool=>tool.factory==='Pin'?[
      {...tool,label:'输入引脚',preset:{output:'false'},variant:'input'},
      {...tool,label:'输出引脚',preset:{output:'true',facing:'west'},variant:'output'},
    ]:[{...tool,label:group.id===''?tool.name:componentLabels[tool.factory]||tool.label,preset:{},variant:''}])
      .map(tool=>({...tool,library:group.id,key:JSON.stringify([group.id,tool.name,tool.variant])}));
  }
  function render() {
    if(!catalog)return;
    const list=node('componentLibrary'),query=node('componentSearch').value.trim().toLocaleLowerCase();list.replaceChildren();let count=0;
    for(const group of catalog.groups) {
      const title=groupLabels[group.name]||group.label;
      const items=tools(group).filter(tool=>[tool.label,tool.name,tool.factory,title].join(' ').toLocaleLowerCase().includes(query));
      if(!items.length)continue;count+=items.length;
      const section=makeElement('section','component-group'),head=makeElement('button','component-group-title');head.type='button';
      const open=!!query||expanded.has(group.name);head.setAttribute('aria-expanded',String(open));head.append(icon(open?'ChevronDown':'ChevronRight'),makeElement('span','',title));
      head.addEventListener('click',()=>{expanded.has(group.name)?expanded.delete(group.name):expanded.add(group.name);render();});section.append(head);
      if(open)for(const tool of items) {
        const button=makeElement('button','component-tool');button.type='button';button.dataset.key=tool.key;button.dataset.factory=tool.factory;button.setAttribute('aria-label',tool.label);button.title=tool.disabled||tool.name;button.disabled=!!tool.disabled;
        button.setAttribute('aria-pressed',String(selected===tool.key));
        if(tool.icon){const img=makeElement('img');img.src=tool.icon;img.alt='';button.append(img);}else button.append(icon('Cpu'));
        button.append(makeElement('span','',tool.label));
        button.addEventListener('click',()=>{if(project.projectBusy)return;selected=tool.key;selectPaletteTool(selected);ports.startPlacement(tool);});section.append(button);
      }
      list.append(section);
    }
    if(!count)list.append(makeElement('p','library-empty','没有找到这个元件'));
  }
  function selectPaletteTool(key) {
    selected=key||'';for(const button of node('componentLibrary').querySelectorAll('.component-tool'))button.setAttribute('aria-pressed',String(button.dataset.key===selected));
  }
  function mountComponents() {
    node('filesTab').addEventListener('click',()=>chooseTab('files'));node('componentsTab').addEventListener('click',openComponents);
    node('addComponentTool').addEventListener('click',openComponents);
    node('componentSearch').addEventListener('input',render);
    node('componentSearch').addEventListener('keydown',event=>{if(event.key==='ArrowDown'){event.preventDefault();node('componentLibrary').querySelector('.component-tool:not(:disabled)')?.focus();}else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(event.target.value){event.target.value='';render();}else node('circuitCanvas').focus();}});
    node('resourceTabs').addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();chooseTab(event.key==='Home'?'files':event.key==='End'?'components':tab==='files'?'components':'files');node(tab+'Tab').focus();}});
    node('componentLibrary').addEventListener('keydown',event=>{
      const buttons=[...event.currentTarget.querySelectorAll('button:not(:disabled)')],index=buttons.indexOf(document.activeElement);
      if(['ArrowUp','ArrowDown','Home','End'].includes(event.key)){event.preventDefault();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:Math.max(0,Math.min(buttons.length-1,index+(event.key==='ArrowDown'?1:-1)))]?.focus();}
      else if(event.key==='Escape'){ports.cancelPlacement();node('circuitCanvas').focus();}
      if(!event.ctrlKey&&!event.metaKey||['z','delete'].includes(event.key.toLowerCase()))event.stopPropagation();
    });
    document.addEventListener('keydown',event=>{
      if(event.defaultPrevented||event.isComposing||event.ctrlKey||event.metaKey||event.altKey||event.target.closest('input,textarea,select,[contenteditable]')||document.querySelector('dialog[open],:popover-open'))return;
      if(event.key.toLowerCase()==='a'&&!node('addComponentTool').disabled){event.preventDefault();openComponents();}
    });
  }
  return {mountComponents,openComponents,componentsContextChanged,selectPaletteTool};
}
