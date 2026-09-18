import {ConversationDraft} from '../core/conversation-draft.js';

export const modelDependencies=['project'];
export const dependencies=['ensureConversations','conversationBinding','selectionSnapshot','restoreDraftSelection','renderMaterialAttachments','renderMomentAttachments','resizeQuestion','updateComposerState','showToast'];

export function createController({models,ui,ports}) {
  const api=window.vibeDesktop?.drafts,entries=new Map();
  let active=null,epoch=0,loading=false,loadError='';
  const projectId=()=>models.project.folder?.id||models.project.session?.workspace?.id||null;
  const scopeKey=()=>projectId()+':'+(ports.conversationBinding().id||'legacy');
  const available=()=>Boolean(active&&active.key===scopeKey()&&!loading&&!ports.conversationBinding().busy);
  const failedEntry=()=>active?.error?active:[...entries.values()].find(entry=>entry.error);
  const message=error=>String(error?.message||error).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,'');
  function renderError() {
    const failure=failedEntry(),problem=loadError||failure?.error;
    ui.draftError.hidden=!problem;ui.draftErrorText.textContent=problem?(failure&&failure!==active?`「${failure.name}」：${problem}`:problem):'';
    ui.draftCopy.hidden=Boolean(loadError);
    ui.draftCopy.textContent=failure&&failure!==active?'复制未保留的草稿':'复制草稿';
  }
  function render() {
    ui.questionInput.dataset.workspaceId=active?.projectId||'';
    ui.questionInput.dataset.conversationId=active?.conversationId||'';
    ui.questionInput.value=active?.key===scopeKey()&&!loading?active.model.value.text:'';
    ports.renderMaterialAttachments();ports.renderMomentAttachments();
    ports.resizeQuestion();renderError();ports.updateComposerState();
  }
  async function persist(entry) {
    const sequence=++entry.sequence;
    renderError();
    if(!api){entry.saved=sequence;return;}
    try {
      await api.save({projectId:entry.projectId,conversationId:entry.conversationId,writer:entry.writer,sequence,draft:entry.model.value});
      entry.saved=Math.max(entry.saved,sequence);
      if(entry.sequence===sequence)entry.error='';
    }catch(error){if(entry.sequence===sequence)entry.error=message(error);}
    renderError();
  }
  function changed({captureFocus=true}={}) {
    if(!available())return;
    if(captureFocus&&models.project.circuit)active.model.value.focus=active.model.hasContent?ports.selectionSnapshot():null;
    persist(active);renderError();ports.updateComposerState();
  }
  async function openDraftProject({retry=false}={}) {
    const expectedProject=projectId();
    await ports.ensureConversations();
    if(expectedProject!==projectId())return null;
    const id=projectId(),conversationId=ports.conversationBinding().id||'legacy',key=scopeKey();
    if(!retry&&key===active?.key)return structuredClone(active.model.value.focus);
    const token=++epoch;loading=Boolean(id);loadError='';active=null;render();
    if(!id){loading=false;render();return null;}
    let entry=entries.get(key);
    if(!entry) {
      try {
        const result=api?await api.open({projectId:id,conversationId}):{};
        if(token!==epoch||key!==scopeKey())return null;
        entry={key,projectId:id,conversationId,name:models.project.folder?.name||models.project.session?.workspace?.name||'另一份工程',writer:result.writer,model:new ConversationDraft(result.draft),sequence:0,saved:0,error:''};
        entries.set(key,entry);
      }catch(error){if(token===epoch){loading=false;loadError=message(error);render();}return null;}
    }
    if(token!==epoch||key!==scopeKey())return null;
    active=entry;loading=false;render();return structuredClone(entry.model.value.focus);
  }
  function draftReferences(kind){return available()?structuredClone(active.model.value[kind]):[];}
  function setDraftReferences(kind,refs){
    if(!available())return;
    active.model.references(kind,refs);changed();
  }
  function appendDraftText(text) {
    if(!available())return;
    const next=active.model.value.text?active.model.value.text+'\n\n'+text:text;
    if(next.length>ui.questionInput.maxLength){ports.showToast('内容较长，可以复制后选取需要的部分');return;}
    active.model.text(next);changed();render();ui.questionInput.focus();
  }
  function replaceDraftText(text) {
    if(!available())return;
    const next=String(text ?? '');
    if(next.length>ui.questionInput.maxLength){ports.showToast('内容较长，可以复制后选取需要的部分');return;}
    active.model.text(next);changed();render();ui.questionInput.focus();ui.questionInput.setSelectionRange(0,next.length);
  }
  function draftReceipt(){return available()?{entry:active,snapshot:active.model.snapshot()}:null;}
  function acknowledgeDraft(receipt) {
    if(!receipt)return;
    const {entry,snapshot}=receipt;entry.model.acknowledge(snapshot);
    persist(entry);if(entry===active){render();}
  }
  function restoreDraftFocus(focus) {
    if(!focus||!available()||!active.model.hasContent)return;
    if(!focus.rectangle&&![focus.componentIds,focus.netIds,focus.wireIds].some(ids=>ids?.length))return;
    if(!ports.restoreDraftSelection(focus))ports.showToast('草稿已恢复；电路已变化，请重新选择要讨论的部分');
  }
  function mountDraft() {
    ui.questionInput.addEventListener('input',()=>{
      if(available()&&active.model.text(ui.questionInput.value))changed();
    });
    ui.draftRetry.addEventListener('click',async()=>{
      if(loadError)await openDraftProject({retry:true});
      else {
        const failed=[...entries.values()].filter(entry=>entry.error);
        await Promise.all((failed.length?failed:active?[active]:[]).map(persist));
      }
    });
    ui.draftCopy.addEventListener('click',async()=>{
      const value=(failedEntry()||active)?.model.value;
      if(!value)return;
      try {await window.vibeDesktop.copyText([value.text,...value.materials.map(r=>`资料：${r.name}${r.page?' · 第 '+r.page+' 页':''}\n${r.quote}`),...value.moments.map(r=>'观察：'+r.title)].join('\n\n'));ports.showToast('草稿已复制');}
      catch(error){ports.showToast(message(error));}
    });
    api?.onError(error=>{
      const entry=entries.get(error.projectId+':'+(error.conversationId||'legacy'));
      if(entry)entry.error=message(error);
      renderError();ports.showToast('草稿尚未保留，窗口继续保持打开。可重试或复制内容。');
    });
    renderError();
  }
  return Object.freeze({mountDraft,openDraftProject,draftReady:available,draftReferences,setDraftReferences,appendDraftText,replaceDraftText,draftReceipt,acknowledgeDraft,restoreDraftFocus});
}
