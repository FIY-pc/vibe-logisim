import {icon} from '../core/chat-dom.js';

export const modelDependencies = [];
export const dependencies = ['applyAgentState','updateAgentPreferences','openModelPicker','refreshModelOptions','loadCandidates','showToast','switchReviewTab'];

export function createController({ui,ports}) {
  let state = {}, reconnecting = false;
  function updateAgentConnection(snapshot) {
    state = {...state, ...snapshot};
    ports.updateAgentPreferences(state);
    ui.modelConnection.textContent=`${state.providerName||'本机 Codex'} · ${state.account?.type==='chatgpt'?'ChatGPT 登录':state.account?.type==='apiKey'?'API 连接':'本机配置'}`;
    ui.modelConnectionStatus.textContent=state.status==='ready'?'已连接':state.status==='busy'?'正在处理问题':state.status==='auth-required'?'需要登录':'连接尚未就绪';
    ui.connectionModel.textContent=state.model||'尚未选择';
    ui.connectionPreference.textContent=state.modelSelection?'本应用单独设置':'跟随本机配置';
    ui.modelReconnect.disabled=reconnecting||state.canReconnect===false;
    ui.modelReconnect.textContent=reconnecting?'正在连接…':state.transmission?.phase==='retrying'?'停止并重新连接':'重新连接';
    renderNotice();
  }
  function renderNotice() {
    const t=state.transmission,disconnected=['unavailable','stopped','auth-required'].includes(state.status);
    ui.agentNotice.hidden=!t&&!disconnected&&!reconnecting;
    if(ui.agentNotice.hidden)return;
    ui.agentNotice.dataset.phase=t?.phase||'disconnected';
    ui.agentNoticeTitle.textContent=reconnecting?'正在重新连接':t?.phase==='retrying'?'连接中断，正在重试':t?.phase==='failed'?'这次回答没有完成':t?.phase==='interrupted'?'回答已停止':state.status==='auth-required'?'需要登录 Codex':'连接已断开';
    ui.agentNoticeText.textContent=t?.phase==='retrying'?'草稿和已有改动已保留，可以等待恢复。':state.status==='auth-required'?'在 AI 设置中查看登录方式，完成后重新连接。':'已有内容仍保留，可以继续编辑或提问。';
    ui.agentNoticeDetails.textContent=String(t?.message||state.detail||'');ui.agentNoticeDetails.parentElement.hidden=!ui.agentNoticeDetails.textContent;
    ui.agentReconnect.disabled=ui.modelReconnect.disabled;ui.agentReconnect.textContent=ui.modelReconnect.textContent;
    ui.agentReconnect.hidden=t?.phase==='interrupted'&&!disconnected;
    ui.agentStatusText.textContent=reconnecting?'正在连接':t?.phase==='retrying'?'等待连接恢复':disconnected?'连接需要处理':state.busy?'正在结束回答':'可以继续提问';
    if(t?.phase==='retrying'||disconnected){ui.agentStatusLight.dataset.state='unavailable';ui.agentTabLight.dataset.state='unavailable';}
  }
  async function reconnectAgent() {
    if(reconnecting)return;reconnecting=true;ui.connectionError.hidden=true;updateAgentConnection({});
    try {
      ports.applyAgentState(await window.vibeDesktop.agent.reconnect());await ports.loadCandidates();
      ports.showToast('连接已恢复，可以继续提问');if(ui.modelDialog.open||ui.effortMenu.matches(':popover-open'))await ports.refreshModelOptions(true);
    }catch(error){const snapshot=await window.vibeDesktop.agent.getState().catch(()=>({status:'unavailable'}));ports.applyAgentState({...snapshot,detail:error.message});ui.connectionError.textContent=error.message;ui.connectionError.hidden=false;ports.showToast('重新连接未完成：'+error.message);}
    finally{reconnecting=false;updateAgentConnection({});}
  }
  function mountAgentConnection() {
    if(!window.vibeDesktop?.agent)return;
    ui.connectionClose.replaceChildren(icon('X'));
    ui.connectionChooseModel.addEventListener('click',()=>{ui.connectionDialog.close();ports.openModelPicker();});
    ui.agentSettings.addEventListener('click',()=>{if(!document.querySelector('dialog[open]'))ui.connectionDialog.showModal();});
    ui.connectionClose.addEventListener('click',()=>ui.connectionDialog.close());
    ui.modelReconnect.addEventListener('click',reconnectAgent);ui.agentReconnect.addEventListener('click',reconnectAgent);
    ui.agentReviewChanges.addEventListener('click',()=>{ports.loadCandidates();ports.switchReviewTab('proposal');});
  }
  const reportAgentError=message=>updateAgentConnection({transmission:{phase:'failed',message}});
  return {mountAgentConnection,updateAgentConnection,reportAgentError};
}
