import {makeSvg} from './dom.js';

// Show the real component artwork under the pointer, not only empty hit boxes.
export function showMovePreview(ui, circuit, ids, dx, dy) {
  ui.interactionLayer.querySelector('.move-preview')?.remove();
  if (!circuit.render) return;
  const group = makeSvg('g', {class:'move-preview','pointer-events':'none',transform:`translate(${dx},${dy})`});
  const clip = makeSvg('clipPath', {id:'movingComponentClip',clipPathUnits:'userSpaceOnUse'});
  for (const component of circuit.components) {
    if (!ids.includes(component.componentId)) continue;
    const b = component.bounds;
    clip.append(makeSvg('rect',{x:b.x-3,y:b.y-3,width:b.width+6,height:b.height+6}));
  }
  const defs=makeSvg('defs',{});defs.append(clip);group.append(defs);
  group.append(makeSvg('image',{href:circuit.render.url,...circuit.render.bounds,'clip-path':'url(#movingComponentClip)'}));
  const detail = ui.detailLayer?.querySelector('image');
  if (detail) {const copy = detail.cloneNode(); copy.setAttribute('clip-path','url(#movingComponentClip)'); group.append(copy);}
  ui.interactionLayer.append(group);
}

export function clearMovePreview(ui) {
  ui.interactionLayer.querySelector('.move-preview')?.remove();
  ui.runtimeLayer.style.opacity='';
  if (ui.nativeArtwork) ui.nativeArtwork.style.opacity='';
  ui.componentLayer.querySelectorAll('.circuit-component').forEach(node=>{node.style.transform='';});
}
