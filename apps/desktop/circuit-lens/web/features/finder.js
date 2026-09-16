import {componentId, componentPoint, firstDefined} from '../core/values.js';
import {makeElement} from '../core/dom.js';

export const modelDependencies = ['project'];
export const dependencies = ['selectComponent', 'focusComponents', 'showToast'];

const names = {Register:'寄存器', Tunnel:'隧道', Pin:'引脚', Probe:'探针', Clock:'时钟',
  Multiplexer:'多路选择器', Splitter:'分线器', ROM:'只读存储器', RAM:'存储器',
  Button:'按钮', Constant:'常量', Adder:'加法器', Comparator:'比较器', Text:'文字'};

export function createController({models, ui, ports}) {
  const {project} = models;
  let results = [], active = 0, binding = '', mounted = false;
  const scope = () => [project.session?.workspace?.id, project.revision, project.circuitName].join(':');

  function setActive(index) {
    active = Math.max(0, Math.min(results.length - 1, index));
    [...ui.finderResults.children].forEach((node, i) => node.setAttribute('aria-selected', String(i === active)));
    const node = ui.finderResults.children[active];
    if (node) {
      ui.finderInput.setAttribute('aria-activedescendant', node.id);
      node.scrollIntoView({block:'nearest'});
    } else ui.finderInput.removeAttribute('aria-activedescendant');
  }

  function renderResults() {
    binding = scope();
    const query = ui.finderInput.value.trim().toLocaleLowerCase();
    const tokens = query.split(/\s+/).filter(Boolean);
    const matches = (project.circuit?.components || []).map((c, index) => {
      const factory = firstDefined(c.factoryName,c.factory,c.type,'Component');
      const label = firstDefined(c.label,c.attributes?.label,c.attributes?.text,c.text,names[factory],factory);
      const searchable = `${label} ${factory} ${names[factory] || ''}`.toLocaleLowerCase();
      return {id:componentId(c,index),label,factory,point:componentPoint(c),
        matches:tokens.every(token=>searchable.includes(token)),
        rank:(String(label).toLocaleLowerCase()===query?0:String(label).toLocaleLowerCase().startsWith(query)?10:20)+(factory==='Text'?5:0)};
    }).filter(c=>c.matches).sort((a,b)=>a.rank-b.rank || a.label.localeCompare(b.label));
    results = matches.slice(0,100);
    ui.finderScope.textContent = project.circuitName || '尚未打开电路';
    ui.finderStatus.textContent = !matches.length ? '没有匹配的对象，试试信号名或元件类型'
      : `${matches.length} 个结果${matches.length>100?'，显示前 100 个，请缩小搜索范围':''}`;
    ui.finderResults.replaceChildren();
    for (const [index,item] of results.entries()) {
      const node = makeElement('div','finder-result');
      node.id = `finder-result-${index}`;
      node.setAttribute('role','option');
      node.setAttribute('aria-label',`${item.label}，${names[item.factory] || item.factory}，${item.point.x},${item.point.y}`);
      const text = makeElement('div','finder-result-text');
      text.append(makeElement('strong','',item.label));
      node.append(text,makeElement('span','finder-kind',names[item.factory] || item.factory),
        makeElement('small','finder-location',`${item.point.x}, ${item.point.y}`));
      node.addEventListener('click',()=>choose(index));
      ui.finderResults.append(node);
    }
    setActive(0);
  }

  function choose(index=active) {
    if (binding!==scope()) {
      renderResults();
      ui.finderStatus.textContent='电路已更新，结果已刷新，请重新选择';
      return;
    }
    const item=results[index];
    if (!item) return;
    ui.finderDialog.close();
    ports.selectComponent(item.id);
    ports.focusComponents([item.id]);
    const target=[...ui.componentLayer.children].find(n=>n.dataset.objectId===item.id);
    target?.focus({preventScroll:true});
  }

  function openFinder() {
    if (!project.circuit) {ports.showToast('先打开一份电路');return;}
    if (document.querySelector('dialog[open]') && !ui.finderDialog.open) return;
    renderResults();
    if (!ui.finderDialog.open) ui.finderDialog.showModal();
    ui.finderInput.focus();ui.finderInput.select();
  }

  function mountFinder() {
    if (mounted) return; mounted=true;
    ui.findObject.addEventListener('click',openFinder);
    ui.finderClose.addEventListener('click',()=>ui.finderDialog.close());
    ui.finderInput.addEventListener('input',renderResults);
    ui.finderInput.addEventListener('keydown',event=>{
      if(event.isComposing)return;
      if(['ArrowDown','ArrowUp','Enter'].includes(event.key)){
        event.preventDefault();
        if(event.key==='Enter') choose();
        else setActive(active+(event.key==='ArrowDown'?1:-1));
      }
    });
    ui.finderDialog.addEventListener('click',event=>{
      if(event.target!==ui.finderDialog)return;
      const b=ui.finderDialog.getBoundingClientRect();
      if(event.clientX<b.left || event.clientX>b.right || event.clientY<b.top || event.clientY>b.bottom)ui.finderDialog.close();
    });
  }
  return Object.freeze({mountFinder,openFinder});
}
