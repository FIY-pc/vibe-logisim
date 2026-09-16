import icons from '../vendor/icons.js';
import {makeElement} from './dom.js';
export function icon(name) {
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  for(const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,value);
  svg.classList.add('chat-icon');
  for(const [tag,attrs] of icons[name]||[]) {
    const child=document.createElementNS(svg.namespaceURI,tag);
    for(const [key,value] of Object.entries(attrs))child.setAttribute(key,value);
    svg.append(child);
  }
  return svg;
}
export function action(label,name,handler,className='chat-action') {
  const button=makeElement('button',className);button.type='button';button.title=label;button.setAttribute('aria-label',label);
  if(name)button.append(icon(name));button.addEventListener('click',handler);return button;
}
export async function copyText(text,button,notify) {
  try {
    if(window.vibeDesktop?.copyText)await window.vibeDesktop.copyText(text);
    else await navigator.clipboard.writeText(text);
    const label=button.getAttribute('aria-label');button.dataset.copied='true';button.setAttribute('aria-label','已复制');
    setTimeout(()=>{button.removeAttribute('data-copied');button.setAttribute('aria-label',label);},1600);
  }catch(error){notify('复制未完成：'+error.message);}
}
