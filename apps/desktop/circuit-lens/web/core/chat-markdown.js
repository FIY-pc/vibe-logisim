import {marked} from '../vendor/marked.js';
import DOMPurify from '../vendor/purify.js';
import {makeElement} from './dom.js';
import {action,copyText} from './chat-dom.js';

// One renderer for restored and streaming answers. Source markup cannot create
// controls, load remote media, or navigate the Electron window.
export function renderMarkdown(target,text,{followReference,notify}) {
  const fragment=DOMPurify.sanitize(marked.parse(text,{gfm:true,breaks:false,async:false}),{
    RETURN_DOM_FRAGMENT:true,
    ALLOWED_TAGS:['p','br','hr','strong','em','del','blockquote','ul','ol','li','h1','h2','h3','h4','h5','h6','pre','code','table','thead','tbody','tr','th','td','a'],
    ALLOWED_ATTR:['href','title','start','class'],
    ALLOWED_URI_REGEXP:/^(?:https?:\/\/|circuit:\/\/object\?|material:\/\/file\?)/i,
    ALLOW_DATA_ATTR:false,
  });
  for(const node of fragment.querySelectorAll('[class]')) {
    if(node.tagName!=='CODE'||!/^language-[a-zA-Z0-9_+-]+$/.test(node.className))node.removeAttribute('class');
  }
  for(const link of fragment.querySelectorAll('a')) {
    const href=link.getAttribute('href')||'';
    if(href.startsWith('circuit://object?')||href.startsWith('material://file?')) {
      const material=href.startsWith('material:');
      const button=makeElement('button',material?'material-reference':'circuit-reference',link.textContent);button.type='button';button.title=material?'查看引用资料':'在电路中定位';
      button.addEventListener('click',()=>followReference(href));link.replaceWith(button);
    }else if(/^https?:\/\//i.test(href)) {
      link.title=href;link.addEventListener('click',e=>{
        e.preventDefault();
        if(window.vibeDesktop?.openWebLink)window.vibeDesktop.openWebLink(href).catch(error=>notify(error.message));
        else window.open(href,'_blank','noopener,noreferrer');
      });
    }else link.replaceWith(document.createTextNode(link.textContent));
  }
  for(const table of fragment.querySelectorAll('table')) {
    const wrapper=makeElement('div','message-table');wrapper.tabIndex=0;wrapper.setAttribute('aria-label','回答中的表格，可横向滚动');table.replaceWith(wrapper);wrapper.append(table);
  }
  for(const pre of fragment.querySelectorAll('pre')) {
    const code=pre.querySelector('code'),value=code?.textContent||pre.textContent;
    const wrapper=makeElement('section','chat-code'),header=makeElement('div','chat-code-header');
    const language=code?.className.replace(/^language-/,'')||'代码';
    const button=action('复制代码','Copy',()=>copyText(value,button,notify));
    header.append(makeElement('span','',language),button);pre.replaceWith(wrapper);wrapper.append(header,pre);
  }
  target.replaceChildren(fragment);
}
