import {createReferenceDrop} from './reference-drop.js';
import {makeElement} from '../core/dom.js';
import {icon,action} from '../core/chat-dom.js';

// File references belong to a folder conversation. Preview is read-only and
// never imports a second copy or executes file content in the renderer.
export const modelDependencies=['project'];
export const dependencies=['draftReceipt','draftReady','draftReferences','setDraftReferences','followCircuitReference','showToast','openReviewPanel','switchReviewTab'];
const key=ref=>JSON.stringify([ref.id,ref.pathVersion,ref.page,ref.quote]);
const sizeLabel=n=>n>=1024*1024?`${(n/1024/1024).toFixed(1)} MB`:`${Math.max(1,Math.ceil(n/1024))} KB`;

export function createController({models,ui,ports}) {
  const api=window.vibeDesktop?.folder;
  let folderId=null,epoch=0,selected=null,preview=null,mode='image',returnFocus=null,loading=false;
  const current=()=>models.project.folder?.id;
  function canonical(ref){
    const moves=models.project.folder?.moves||[];let id=ref.id;
    for(const move of moves.slice(ref.pathVersion||0))if(id===move.from||id.startsWith(move.from+'/'))id=move.to+id.slice(move.from.length);
    return {...ref,id,name:id===ref.id?ref.name:id.split('/').at(-1),pathVersion:moves.length};
  }
  const refs=()=>ports.draftReferences('materials').map(canonical);
  const request=extra=>({folderId,...extra});
  function error(value){ui.materialsError.textContent=String(value?.message||value||'').replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,'');ui.materialsError.hidden=!value;}
  function updateMaterialState(){ui.materialQuote.disabled=loading||!preview||!ports.draftReady()||refs().length>=8;}
  function renderAttachments(){
    ui.materialAttachments.replaceChildren();ui.materialAttachments.hidden=!refs().length;
    for(const ref of refs()){
      const chip=makeElement('span','material-chip'),open=makeElement('button','material-chip-label');open.type='button';open.title=ref.quote||ref.id;
      open.append(makeElement('span','',ref.name));if(ref.page||ref.quote)open.append(makeElement('small','',[ref.page?'第 '+ref.page+' 页':'',ref.quote?'摘录':''].filter(Boolean).join(' · ')));
      open.addEventListener('click',()=>openWorkspaceFile(ref.id,ref.page||1,ref.pathVersion??0));
      const close=action('取消引用 '+ref.name,'X',()=>{ports.setDraftReferences('materials',refs().filter(r=>key(r)!==key(ref)));renderAttachments();updateMaterialState();});
      chip.append(icon('FileText'),open,close);ui.materialAttachments.append(chip);
    }
  }
  function renderPreview(){
    ui.materialsPreview.replaceChildren();ui.materialsFooter.hidden=!preview;
    if(!preview){ui.materialsPreview.append(makeElement('p','material-empty','正在读取文件…'));return;}
    const {item}=preview;
    ui.materialsName.textContent=item.name;ui.materialsMeta.textContent=sizeLabel(item.size)+' · '+preview.note;
    if(preview.data&&(preview.kind==='image'||mode!=='text')){const img=makeElement('img','material-image');img.src=preview.data;img.alt=item.name+(preview.kind==='pdf'?' 第 '+preview.page+' 页':'');ui.materialsPreview.append(img);}
    else ui.materialsPreview.append(makeElement(preview.kind==='unsupported'?'p':'pre',preview.kind==='unsupported'?'material-empty':'material-text',preview.kind==='unsupported'?preview.note:preview.text||(preview.kind==='pdf'?'此页没有可提取文字，可以引用整页。':'（空文件）')));
    ui.materialPage.textContent=preview.pages>1?`${preview.page} / ${preview.pages}`:preview.kind==='pdf'?'1 / 1':'';
    ui.materialPrev.hidden=ui.materialNext.hidden=preview.pages<=1;
    ui.materialPrev.disabled=preview.page<=1;ui.materialNext.disabled=preview.page>=preview.pages;
    ui.materialImageMode.hidden=ui.materialTextMode.hidden=preview.kind!=='pdf';
    ui.materialImageMode.setAttribute('aria-pressed',String(mode==='image'));ui.materialTextMode.setAttribute('aria-pressed',String(mode==='text'));
    ui.materialQuote.textContent=preview.kind==='pdf'?'引用这一页':'引用到问题';updateMaterialState();
  }
  async function load(id,page,pathVersion=(models.project.folder?.moves||[]).length){
    const token=++epoch;loading=true;preview=null;selected=id;error('');updateMaterialState();renderPreview();
    ui.materialsName.textContent=id.split('/').pop();ui.materialsMeta.textContent='';
    try{const result=await api.preview(request({id,page,pathVersion}));if(token!==epoch||!ui.materialsDialog.open)return;preview=result;selected=preview.item.id;renderPreview();}
    catch(e){if(token!==epoch)return;error(e);ui.materialsPreview.replaceChildren(makeElement('p','material-empty','暂时无法预览。'));
      const retry=makeElement('button','quiet-button','重试');retry.type='button';retry.addEventListener('click',()=>load(id,page));ui.materialsPreview.append(retry);
    }finally{if(token===epoch){loading=false;updateMaterialState();}}
  }
  async function openWorkspaceFile(id,page=1,pathVersion=(models.project.folder?.moves||[]).length){
    if(!api||!folderId)return;
    if(document.querySelector('dialog[open]')&&!ui.materialsDialog.open)return;
    if(!ui.materialsDialog.open){returnFocus=document.activeElement;mode='image';ui.materialsDialog.showModal();}
    await load(id,page,pathVersion);
  }
  function quote(){
    if(!preview||!ports.draftReady())return;
    const selection=window.getSelection(),text=selection?.rangeCount&&ui.materialsPreview.contains(selection.anchorNode)&&ui.materialsPreview.contains(selection.focusNode)?selection.toString().trim():'';
    if(text.length>2000){error('请选取 2000 字以内的摘录，或直接引用文件');return;}
    const ref={id:preview.item.id,name:preview.item.name,pathVersion:preview.item.pathVersion,page:preview.kind==='pdf'?preview.page:null,quote:text};
    if(!refs().some(r=>key(r)===key(ref)))ports.setDraftReferences('materials',[...refs(),ref]);
    renderAttachments();ui.materialsDialog.close();ports.switchReviewTab('agent');ports.openReviewPanel();ui.questionInput.focus();
  }
  function materialsProjectChanged(){
    if(folderId===current()){renderAttachments();return;}
    folderId=current();epoch++;selected=null;preview=null;loading=false;ui.materialsDialog.close();renderAttachments();updateMaterialState();
  }
  function appendMaterialReferences(node,context){
    for(const ref of context?.materials||[]){const button=makeElement('button','material-message-link',ref.name+(ref.page?' · 第 '+ref.page+' 页':''));button.type='button';button.title=ref.quote||'查看文件';button.addEventListener('click',()=>{
      if((context.folderId||context.projectId)!==current()&&!models.project.folder?.documentIds?.includes(context.projectId)){ports.showToast('文件属于另一工作区');return;}
      openWorkspaceFile(ref.id,ref.page||1,ref.pathVersion??0);
    });node.append(button);}
  }
  function followConversationReference(value){
    if(!value.startsWith('workspace://')&&!value.startsWith('material://'))return ports.followCircuitReference(value);
    try{const url=new URL(value),legacy=url.protocol==='material:',owner=url.searchParams.get(legacy?'projectId':'folderId');
      if(url.hostname!=='file'||(owner!==current()&&!(legacy&&models.project.folder?.documentIds?.includes(owner))))throw new Error('文件属于另一工作区');
      const page=Number(url.searchParams.get('page')||1),id=url.searchParams.get(legacy?'id':'path');if(!id||!Number.isInteger(page)||page<1)throw new Error('文件引用无效');
      return openWorkspaceFile(id,page,Number(url.searchParams.get('pathVersion')||0));
    }catch(e){ports.showToast(e.message);}
  }
  async function attachWorkspaceFiles(references,owner=folderId,draft=ports.draftReceipt()){
    if(!draft||!ports.draftReady())throw new Error('对话正在加载，请稍后再拖入');
    const bound=()=>owner===current()&&ports.draftReceipt()?.entry===draft.entry;
    if(!bound())throw new Error('对话已切换，请在当前对话重新添加文件');
    if(references.length>8)throw new Error('每条问题最多引用 8 处文件');
    const response=await api.reference({folderId:owner,refs:references});
    if(!bound())throw new Error('对话已切换，文件未添加到其他对话，请重新拖入');
    const next=refs();
    for(const item of response.items){const ref={id:item.id,name:item.name,pathVersion:item.pathVersion,page:null,quote:''};if(!next.some(r=>key(r)===key(ref)))next.push(ref);}
    if(next.length>8)throw new Error('每条问题最多引用 8 处文件');
    ports.setDraftReferences('materials',next);renderAttachments();updateMaterialState();
    ports.switchReviewTab('agent');ports.openReviewPanel();ui.questionInput.focus();
  }
  function mountMaterials(){
    if(api)createReferenceDrop({element:document.getElementById('reviewPanel'),folder:()=>models.project.folder,ready:()=>ports.draftReady(),receipt:()=>ports.draftReceipt(),count:()=>refs().length,api,attach:attachWorkspaceFiles,fail:e=>ports.showToast(String(e.message||e).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,''))});
    for(const [button,name] of [[ui.materialsClose,'X'],[ui.materialPrev,'ChevronLeft'],[ui.materialNext,'ChevronRight']])button.replaceChildren(icon(name));
    document.getElementById('filePreviewExternal').addEventListener('click',()=>api['open-system'](request({path:preview?.item.path||selected})).then(message=>{if(message)error(message);}).catch(error));
    ui.materialsClose.addEventListener('click',()=>ui.materialsDialog.close());
    ui.materialsDialog.addEventListener('close',()=>{epoch++;loading=false;returnFocus?.focus();});
    ui.materialPrev.addEventListener('click',()=>load(selected,preview.page-1));ui.materialNext.addEventListener('click',()=>load(selected,preview.page+1));
    ui.materialImageMode.addEventListener('click',()=>{mode='image';renderPreview();});ui.materialTextMode.addEventListener('click',()=>{mode='text';renderPreview();});
    ui.materialQuote.addEventListener('pointerdown',e=>{if(e.button===0)e.preventDefault();});ui.materialQuote.addEventListener('click',quote);updateMaterialState();
  }
  return {attachWorkspaceFiles,openWorkspaceFile,mountMaterials,materialsProjectChanged,updateMaterialState,appendMaterialReferences,followConversationReference,
    materialAttachments:()=>({projectId:folderId,refs:refs().map(({token,...ref})=>ref)}),renderMaterialAttachments:renderAttachments};
}
