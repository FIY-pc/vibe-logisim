import {icon} from '../core/chat-dom.js';

export const modelDependencies = [];
export const dependencies = ['applyAgentState','updateAgentPreferences','openModelPicker','refreshModelOptions','loadCandidates','showToast','switchReviewTab'];

export function createController({ui,ports}) {
  let state = {}, reconnecting = false, accountPending = false;
  function updateAgentConnection(snapshot) {
    state = {...state, ...snapshot};
    ports.updateAgentPreferences(state);
    const modelIssue = state.modelCatalog?.error;
    ui.modelConnection.textContent=`${state.providerName||'本机 Codex'} · ${state.account?.type==='chatgpt'?'ChatGPT 登录':state.account?.type==='apiKey'?'API 连接':'本机配置'}`;
    ui.modelConnectionStatus.textContent=modelIssue?'模型目录不可用':state.status==='ready'?'已连接':state.status==='busy'?'正在处理问题':state.status==='auth-required'?'需要登录':'连接尚未就绪';
    ui.connectionModel.textContent=state.model||'尚未选择';
    ui.connectionPreference.textContent=state.modelSelection?'本应用单独设置':state.accountMode==='application'?'默认设置':'跟随本机配置';
    ui.connectionHelp.textContent=state.accountMode==='application'?'登录后即可和 AI 一起构建电路。登录保存在本应用中；未登录也可以编辑和仿真。':'当前开发环境沿用本机 Codex 的服务配置与登录。模型偏好、对话和电路保存在 Vibe Logisim 中。';
    ui.connectionLogout.hidden=state.accountMode!=='application'||!state.account;
    ui.connectionLogout.disabled=accountPending||state.busy;
    ui.modelReconnect.disabled=accountPending||reconnecting||state.canReconnect===false;
    if(modelIssue){ui.connectionError.textContent=`模型目录：${modelIssue.message}`;ui.connectionError.hidden=false;}
    else if(ui.connectionError.textContent.startsWith('模型目录：')){ui.connectionError.textContent='';ui.connectionError.hidden=true;}
    ui.modelReconnect.textContent=accountPending?'正在处理…':state.signingIn?'取消登录':state.status==='auth-required'&&state.accountMode==='application'?'登录 ChatGPT':reconnecting?'正在连接…':state.transmission?.phase==='retrying'?'停止并重新连接':'重新连接';
    renderNotice();
  }
  function renderNotice() {
    const t=state.transmission,disconnected=['unavailable','stopped','auth-required'].includes(state.status);
    ui.agentNotice.hidden=!t&&!disconnected&&!reconnecting;
    if(ui.agentNotice.hidden)return;
    ui.agentNotice.dataset.phase=t?.phase||(state.status==='auth-required'?'login':'disconnected');
    ui.agentNoticeTitle.textContent=state.signingIn?'在浏览器中完成登录':reconnecting?'正在重新连接':t?.phase==='retrying'?'连接中断，正在重试':t?.phase==='failed'?'这次回答没有完成':t?.phase==='interrupted'?'回答已停止':state.status==='auth-required'?'和 AI 一起构建电路':'连接已断开';
    ui.agentNoticeText.textContent=state.signingIn?'完成后这里会自动连接。你也可以继续编辑电路。':t?.phase==='retrying'?'草稿和已有改动已保留，可以等待恢复。':state.status==='auth-required'?(state.accountMode==='application'?'登录你的 ChatGPT 账户即可开始。':'本机 Codex 登录失效，恢复后点击重新连接。'):'已有内容仍保留，可以继续编辑或提问。';
    ui.agentNoticeDetails.textContent=String(t?.message||state.detail||'');ui.agentNoticeDetails.parentElement.hidden=!ui.agentNoticeDetails.textContent;
    ui.agentReconnect.disabled=ui.modelReconnect.disabled;ui.agentReconnect.textContent=ui.modelReconnect.textContent;
    ui.agentReconnect.hidden=t?.phase==='interrupted'&&!disconnected;
    ui.agentReviewChanges.hidden=!t||state.status==='auth-required';
    ui.agentStatusText.textContent=state.status==='auth-required'?(state.signingIn?'等待登录完成':'未登录'):reconnecting?'正在连接':t?.phase==='retrying'?'等待连接恢复':disconnected?'连接需要处理':state.busy?'正在结束回答':'可以继续提问';
    if(t?.phase==='retrying'||disconnected){const light=state.status==='auth-required'?'idle':'unavailable';ui.agentStatusLight.dataset.state=light;ui.agentTabLight.dataset.state=light;}
  }
  async function reconnectAgent() {
    if(state.accountMode==='application'&&(state.signingIn||state.status==='auth-required'))return accountAction(state.signingIn?'cancel':'login');
    if(reconnecting)return;reconnecting=true;ui.connectionError.hidden=true;updateAgentConnection({});
    try {
      ports.applyAgentState(await window.vibeDesktop.agent.reconnect());await ports.loadCandidates();
      ports.showToast('连接已恢复，可以继续提问');if(ui.modelDialog.open||ui.effortMenu.matches(':popover-open'))await ports.refreshModelOptions(true);
    }catch(error){const snapshot=await window.vibeDesktop.agent.getState().catch(()=>({status:'unavailable'}));ports.applyAgentState({...snapshot,detail:error.message});ui.connectionError.textContent=error.message;ui.connectionError.hidden=false;ports.showToast('重新连接未完成：'+error.message);}
    finally{reconnecting=false;updateAgentConnection({});}
  }
  async function accountAction(action) {
    if(accountPending)return;
    accountPending=true;ui.connectionError.hidden=true;updateAgentConnection({});
    try {ports.applyAgentState(await window.vibeDesktop.agent.account(action));}
    catch(error){ui.connectionError.textContent=error.message;ui.connectionError.hidden=false;ports.showToast(error.message);}
    finally{accountPending=false;updateAgentConnection({});}
  }
  function mountAgentConnection() {
    if(!window.vibeDesktop?.agent)return;
    ui.connectionClose.replaceChildren(icon('X'));
    ui.connectionChooseModel.addEventListener('click',()=>{ui.connectionDialog.close();ports.openModelPicker();});
    ui.agentSettings.addEventListener('click',()=>{if(!document.querySelector('dialog[open]'))ui.connectionDialog.showModal();});
    ui.connectionClose.addEventListener('click',()=>ui.connectionDialog.close());
    ui.modelReconnect.addEventListener('click',reconnectAgent);ui.agentReconnect.addEventListener('click',reconnectAgent);
    ui.connectionLogout.addEventListener('click',()=>accountAction('logout'));
    ui.agentReviewChanges.addEventListener('click',()=>{ports.loadCandidates();ports.switchReviewTab('proposal');});
  }
  const reportAgentError=message=>updateAgentConnection({transmission:{phase:'failed',message}});
  return {mountAgentConnection,updateAgentConnection,reportAgentError};
}
