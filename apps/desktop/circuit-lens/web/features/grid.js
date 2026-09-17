import {icon} from '../core/chat-dom.js';

export const modelDependencies=[];
export const dependencies=[];

// View-only guides. The origin and minimum spacing match Logisim's placement
// coordinates; zoom changes visible density, never the circuit's snap interval.
export function createController({ui}) {
  const button=document.getElementById('gridToggle');
  const minor=document.getElementById('minorGrid'),major=document.getElementById('majorGrid');
  const api=window.vibeDesktop?.canvasPreferences;
  let visible=false,edited=false,writes=Promise.resolve();

  function gridViewportChanged() {
    if(!visible)return;
    const matrix=ui.circuitCanvas.getScreenCTM(),rect=ui.circuitCanvas.getBoundingClientRect();
    if(!matrix||!rect.width||!rect.height)return;
    const scale=Math.hypot(matrix.a,matrix.b);
    if(!Number.isFinite(scale)||scale<=0)return;
    let step=10;
    while(step*scale<8)step*=5;
    for(const [pattern,spacing] of [[minor,step],[major,step*5]]) {
      pattern.setAttribute('width',spacing);pattern.setAttribute('height',spacing);
      const line=pattern.querySelector('path');
      line.setAttribute('d',`M${spacing} 0H0V${spacing}`);
      line.setAttribute('stroke-width',1/scale);
    }
    const tile=major.querySelector('rect');
    tile.setAttribute('width',step*5);tile.setAttribute('height',step*5);
    // Cover the visible SVG, including letterboxing after a sidebar resize.
    // Patterns stay anchored at world (0,0), even beyond old ±10000 bounds.
    const inverse=matrix.inverse();
    const from=new DOMPoint(rect.left,rect.top).matrixTransform(inverse);
    const to=new DOMPoint(rect.right,rect.bottom).matrixTransform(inverse);
    for(const [key,value] of Object.entries({x:from.x-step,y:from.y-step,width:to.x-from.x+2*step,height:to.y-from.y+2*step}))ui.gridPlane.setAttribute(key,value);
  }

  function render() {
    ui.circuitCanvas.classList.toggle('has-grid',visible);
    button.setAttribute('aria-pressed',String(visible));
    button.title=(visible?'隐藏网格':'显示网格')+'（G）';
    gridViewportChanged();
  }
  function toggle() {
    visible=!visible;edited=true;render();
    const value={gridVisible:visible};
    writes=writes.catch(()=>{}).then(()=>api?api.write(value):localStorage.setItem('vibe.canvas.preferences',JSON.stringify(value)));
    writes.catch(()=>{}); // A view preference must not block circuit work.
  }
  function mountGrid() {
    button.replaceChildren(icon('Grid3X3'));
    button.addEventListener('click',toggle);
    document.addEventListener('keydown',event=>{
      if(event.defaultPrevented||event.isComposing||event.repeat||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||event.key.toLowerCase()!=='g')return;
      if(event.target.closest?.('input,textarea,select,[contenteditable]')||document.querySelector('dialog[open],:popover-open'))return;
      event.preventDefault();toggle();
    });
    new ResizeObserver(gridViewportChanged).observe(ui.circuitCanvas);
    render();
    Promise.resolve().then(()=>api?api.read():JSON.parse(localStorage.getItem('vibe.canvas.preferences')||'null')).then(value=>{
      if(!edited){visible=value?.gridVisible===true;render();}
    }).catch(()=>{});
  }
  return {mountGrid,gridViewportChanged};
}
