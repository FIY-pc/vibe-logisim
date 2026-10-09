import {makeElement} from '../core/dom.js';
import {icon} from '../core/chat-dom.js';

// AI 设置: two ways to connect (ChatGPT account, or a student's own
// OpenAI-compatible endpoint), the preflight for the latter, and the small
// status banner in the agent pane. Saved keys never return to this module.
export const modelDependencies = [];
export const dependencies = ['applyAgentState','updateAgentPreferences','openModelPicker','refreshModelOptions','loadCandidates','showToast','switchReviewTab'];

const effortLabels = {none:'关闭', low:'轻度', medium:'中', high:'高'};
const isReady = state => ['ready','busy'].includes(state.status);

export function createController({ui,ports}) {
  const presets={openai:{url:'https://api.openai.com/v1',api:'openai-responses'},deepseek:{url:'https://api.deepseek.com/v1',api:'openai-completions'},anthropic:{url:'https://api.anthropic.com',api:'anthropic-messages'},openrouter:{url:'https://openrouter.ai/api/v1',api:'openai-completions'}};
  let state = {}, reconnecting = false, accountPending = false, providerPending = false;
  let tab = 'services', formEdited = false, editingService = null, confirmation = null;
  let discovered = null, discoveredFor = null, discovering = null, discoverTimer = null, discoveryRevision = 0;
  let probe = null, listOpen = false;
  // System proxy: `network.active` = what the running AI engine was started
  // with (from agent state); `network.current` = a fresh resolution when the
  // dialog opens or the student clicks 重新检测. They differ after toggling
  // Clash/v2rayN "system proxy" — then reconnecting applies the new route.
  let network = {current:null, active:null, stale:false, checking:false, error:null};

  const busy = () => Boolean(state.busy) || providerPending || accountPending;
  const canReuseSavedKey = () => Boolean(editingService) && ui.providerBaseUrl.value.trim().replace(/\/+$/, '') === editingService.baseUrl.replace(/\/+$/, '');
  const endpointSignature = () => `${state.runtime}\n${editingService?.id||''}\n${ui.providerProtocol.value}\n${discoveryRevision}\n${ui.providerBaseUrl.value.trim()}\n${ui.providerApiKey.value ? 'typed' : canReuseSavedKey() ? 'saved:' + editingService.id + editingService.baseUrl : 'none'}`;
  const knownModels = () => discovered || (canReuseSavedKey()&&ui.providerProtocol.value===editingService?.api&&editingService?.models?.length ? editingService.models : null);

  // ---------------------------------------------------------------- dialog
  function updateAgentConnection(snapshot) {
    const runtimeChanged=snapshot.runtime && snapshot.runtime!==state.runtime;
    state = {...state, ...snapshot};
    if(runtimeChanged){formEdited=false;fillForm(state.customProvider);}
    if (snapshot && 'network' in snapshot) { network.active = snapshot.network || null; if (!network.current) network.current = network.active; network.stale = Boolean(network.current && network.active && (network.current.proxyUrl || null) !== (network.active.proxyUrl || null)); }
    ports.updateAgentPreferences(state);
    renderOverview(); renderPane(); renderForm(); renderFooter(); renderNotice();
    if (ui.connectionDialog.open) renderNetwork();
  }

  // -------------------------------------------------------------- network
  // Wording comes from the main process (system-proxy.cjs describe()); the
  // dialog only displays it.
  const routeOf = net => net?.description || {kind:'unknown', label:'正在检测网络…', sentence:''};

  async function checkNetwork() {
    if (network.checking) return;
    network.checking = true; network.error = null; renderNetwork();
    try {
      const result = await window.vibeDesktop.agent.configureProvider({action:'network', settings:{baseUrl:tab === 'api' ? ui.providerBaseUrl.value.trim() || undefined : undefined}});
      network.current = result.current || null; network.active = result.active || network.active; network.stale = Boolean(result.stale);
    } catch (error) { network.error = error.message; }
    finally { network.checking = false; renderNetwork(); renderPane(); }
  }

  function renderNetwork() {
    const row = ui.connectionNetwork;
    const route = routeOf(network.current);
    row.dataset.kind = network.checking && !network.current ? 'unknown' : network.stale ? 'stale' : route.kind;
    ui.connectionNetworkLabel.textContent = network.checking ? `${route.label === '正在检测网络…' ? '' : route.label + ' · '}正在重新检测…` : network.error ? `网络检测失败：${network.error}` : route.label;
    const detail = network.stale ? `系统代理设置已变化（当前 ${routeOf(network.current).label}，AI 运行时仍在用 ${routeOf(network.active).label}）。点「重新连接」后生效。` : route.sentence;
    ui.connectionNetworkDetail.textContent = detail; ui.connectionNetworkDetail.hidden = !detail;
    ui.connectionNetworkRefresh.disabled = network.checking;
  }


  function selectTab(name) {
    tab = name;
    ui.settingsOverview.hidden = name !== 'services';
    ui.serviceConfirm.hidden = name !== 'confirm';
    ui.settingsRuntimePane.hidden = name !== 'runtime';
    ui.connectionPaneApi.hidden = name !== 'api';
    ui.connectionPaneChatgpt.hidden = name !== 'chatgpt';
    ui.settingsBack.hidden = !['api','chatgpt'].includes(name);
    ui.connectionDialog.querySelector('.connection-footer').hidden = name !== 'services' || !isReady(state);
    for (const [button, active] of [[ui.settingsServices, name !== 'runtime'], [ui.settingsRuntime, name === 'runtime']]) {
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    }
    if (name === 'api') scheduleDiscovery(0);
    if(ui.connectionDialog.open){const panel={services:ui.settingsOverview,runtime:ui.settingsRuntimePane,api:ui.connectionPaneApi,chatgpt:ui.accountCard,confirm:ui.serviceConfirm}[name];const title=panel?.querySelector('h3,strong');if(title){title.tabIndex=-1;title.focus({preventScroll:true});}}
  }

  function openConnectionDialog(which) {
    if (document.querySelector('dialog[open]')) return;
    if (!formEdited) fillForm(state.customProvider);
    probe = null;
    selectTab(which || 'services');
    ui.connectionError.hidden = true;
    ui.connectionDialog.showModal();
    renderNetwork(); void checkNetwork();
  }

  function renderOverview() {
    const custom = state.customProvider, builtin=state.runtime==='builtin';
    ui.builtinRuntimeBadge.hidden=!builtin;ui.codexRuntimeBadge.hidden=builtin;
    ui.useBuiltinRuntime.hidden=builtin;ui.useCodexRuntime.hidden=!builtin;
    ui.useBuiltinRuntime.disabled=busy();ui.useCodexRuntime.disabled=busy();
    ui.defaultRuntime.value=state.defaultRuntime||'builtin';ui.defaultRuntime.disabled=busy();
    ui.savedServices.replaceChildren();
    if(builtin)for(const service of state.services||[]){
      const row=makeElement('div','settings-service-row saved-service');
      const info=makeElement('div'),name=makeElement('strong','',service.name||new URL(service.baseUrl).hostname);
      if(service.id===custom?.id)name.append(makeElement('span','settings-badge','此对话'));
      info.append(name,makeElement('p','',service.baseUrl),makeElement('p','',service.id===custom?.id?state.model||service.model:service.model));
      const actions=makeElement('div','service-actions');
      const edit=makeElement('button','quiet-button','编辑');edit.disabled=busy();edit.setAttribute('aria-label',`编辑 ${service.name||service.baseUrl}`);
      edit.addEventListener('click',()=>{fillForm(service);selectTab('api');renderForm();});actions.append(edit);
      if(service.id!==custom?.id||state.modelConfigurationError){
        const use=makeElement('button','quiet-button','用于此对话');use.disabled=busy()||!state.conversationId;
        use.addEventListener('click',()=>chooseService(service));actions.append(use);
      }
      row.append(info,actions);ui.savedServices.append(row);
    }
    ui.defaultServiceField.hidden=!builtin||!(state.services?.length);
    ui.defaultService.replaceChildren();
    for(const service of builtin?state.services||[]:[]){const option=makeElement('option','',`${service.name||'模型服务'} · ${new URL(service.baseUrl).host}`);option.value=service.id;ui.defaultService.append(option);}
    ui.defaultService.value=state.defaultServiceId||'';ui.defaultService.disabled=busy();
    const apiRow=ui.settingsApiName.closest('.settings-service-row'),hasServices=builtin&&state.services?.length;
    const addTarget=hasServices?ui.settingsServicesHeading:apiRow;
    if(ui.connectionTabApi.parentElement!==addTarget)addTarget.append(ui.connectionTabApi);
    apiRow.hidden=Boolean(hasServices);
    ui.settingsApiName.textContent = builtin?'API 密钥':custom?.name||'API 接口';
    ui.settingsApiSummary.textContent = builtin?'':custom?.model||'Responses API';
    ui.settingsApiSummary.hidden=builtin;
    ui.connectionTabApi.textContent = builtin?'添加服务':custom?'编辑':'添加接口';
    ui.settingsAccountSummary.textContent = builtin?'通过 Codex 运行时使用':state.signingIn?'等待浏览器登录':custom?'未启用':state.account?'已登录':state.accountMode!=='application'?'使用本机 Codex 配置':'未登录';
    ui.connectionTabApi.disabled = busy();ui.connectionTabChatgpt.textContent=builtin?'登录 ChatGPT':'管理';
  }

  function chooseService(service) {
    confirmation={kind:'bind',service,conversationId:state.conversationId};
    if(!(state.messages||[]).some(m=>m.type==='user'))return applyServiceAction();
    ui.serviceConfirmTitle.textContent='更换此对话的模型服务';
    ui.serviceConfirmDestination.replaceChildren();
    for(const [label,value]of [['当前',state.customProvider||state.conversationSelection],['改为',service]]){
      const row=makeElement('div','service-destination');row.append(makeElement('span','',label),makeElement('strong','',value?.name||value?.model||'未绑定'),makeElement('small','',value?.baseUrl||''));ui.serviceConfirmDestination.append(row);
    }
    ui.serviceConfirmImpact.textContent='已有历史将随下一次提问发送给这个服务。';
    ui.serviceConfirmApply.textContent='更换服务';selectTab('confirm');
  }
  async function applyServiceAction() {
    if(busy()||!confirmation)return;
    const pending=confirmation;providerPending='binding';ui.serviceConfirmApply.disabled=true;
    try {
      const snapshot=await window.vibeDesktop.agent.configureProvider({action:pending.kind==='remove'?'clear':'bind-conversation',settings:{...pending.service,conversationId:pending.conversationId}});
      ports.applyAgentState(snapshot);await ports.refreshModelOptions(true).catch(()=>{});
      confirmation=null;selectTab('services');
    }catch(error){ui.connectionError.textContent=error.message;ui.connectionError.hidden=false;}
    finally{providerPending=false;ui.serviceConfirmApply.disabled=false;updateAgentConnection({});}
  }
  function clearFieldErrors(){
    ui.providerForm.querySelectorAll('.field-error').forEach(node=>node.remove());
    for(const input of ui.providerForm.querySelectorAll('[aria-invalid]')){input.removeAttribute('aria-invalid');input.removeAttribute('aria-describedby');}
  }
  function fieldError(input,message){
    clearFieldErrors();const note=makeElement('span','field-error',message);note.id=input.id+'Error';note.setAttribute('role','alert');
    const field=input.closest('.field');if(field.tagName==='LABEL')field.after(note);else field.append(note);input.setAttribute('aria-invalid','true');input.setAttribute('aria-describedby',note.id);
    input.focus();note.scrollIntoView({block:'nearest'});
  }

  function renderPane() {
    const custom = state.customProvider, shared = state.accountMode !== 'application', account = state.account;
    const card = ui.accountCard;
    const setCard = (kind, title, detail) => { card.dataset.state = kind; ui.accountTitle.textContent = title; ui.accountDetail.textContent = detail; };
    if (state.signingIn) setCard('signing-in', '正在浏览器中登录…', '完成后会自动回到这里并连接。');
    else if (custom) setCard('inactive', 'ChatGPT 登录未启用', '切换到 ChatGPT 会停用当前 API 接口。');
    else if (account) setCard('signed-in', account.type === 'chatgpt' ? `已登录 ChatGPT${account.planType ? ` · ${account.planType}` : ''}` : '已通过 API 密钥连接 OpenAI', shared ? '沿用这台电脑上 Codex 的登录。' : '使用你的 ChatGPT 账号。');
    else setCard('signed-out', '未登录', shared ? '开发环境沿用本机 Codex 的登录，请在终端运行 codex login。' : '用你的 ChatGPT 账号登录，在浏览器里完成后自动回到这里。');
    ui.chatgptNote.textContent = ''; ui.chatgptNote.hidden = true;
    if(state.runtime==='builtin'){ui.accountTitle.textContent='ChatGPT 账号';ui.accountDetail.textContent='使用 ChatGPT 账号，不需要 API 密钥。';}
    const login = ui.connectionLogin;
    login.hidden = Boolean(account) && !state.signingIn && !custom;
    login.textContent = state.signingIn ? '取消登录' : state.runtime==='builtin'?'用 Codex 新建对话':custom ? '停用接口并登录 ChatGPT' : '登录 ChatGPT';
    login.className = state.signingIn || (custom&&state.runtime!=='builtin') ? 'quiet-button' : 'primary-button';
    login.disabled = busy() || reconnecting || (state.runtime!=='builtin' && shared && !custom);
    login.title = state.runtime!=='builtin' && shared && !custom ? '开发环境沿用本机 Codex 登录' : '';
    ui.connectionLogout.hidden = shared || !account || Boolean(custom) || state.signingIn;
    ui.connectionLogout.disabled = busy();
  }

  // ------------------------------------------------------------------ form
  function fillForm(custom) {
    editingService=custom||null;discoveryRevision++;discovering=null;clearTimeout(discoverTimer);clearFieldErrors();ui.providerName.value=custom?.name||'';
    ui.providerFormTitle.textContent=custom?'编辑模型服务':'添加模型服务';
    ui.providerBaseUrl.value = custom?.baseUrl || '';
    ui.providerPreset.value = Object.keys(presets).find(key=>presets[key].url===custom?.baseUrl)||(custom?'custom':'');
    ui.providerProtocol.value=custom?.api||(state.runtime==='builtin'?'openai-completions':'openai-responses');
    ui.providerVision.checked=Boolean(custom?.vision);
    ui.providerBaseUrl.closest('label').hidden = ui.providerPreset.value !== 'custom';
    ui.providerApiKey.value = '';
    ui.providerModel.value = custom?.model || '';
    ui.providerEffort.value = effortLabels[custom?.effort] ? custom.effort : state.runtime==='builtin'?'none':'medium';
    ui.providerContext.value = custom?.contextWindow && custom.contextWindow !== 256000 ? custom.contextWindow : '';
    formEdited = false; discovered = null; discoveredFor = null; probe = null; listOpen = false;
  }

  function renderForm() {
    const custom = editingService;
    const builtin=state.runtime==='builtin';
    ui.providerProtocolField.hidden=!builtin || ui.providerPreset.value!=='custom';
    ui.providerVisionField.hidden=!builtin;
    ui.providerForm.querySelector('label[for=providerModel]').textContent=builtin?'默认模型':'模型';
    ui.providerProtocolNote.textContent=builtin?'密钥保存在本机。':'需要支持 Responses API；密钥保存在本机。';
    for(const option of ui.providerPreset.options) option.hidden=!builtin&&!['','custom','openai'].includes(option.value);
    ui.providerApiKey.placeholder = canReuseSavedKey() && custom?.apiKeyHint ? `已保存 ${custom.apiKeyHint}，留空即沿用` : 'sk-…';
    for (const input of [ui.providerBaseUrl, ui.providerApiKey, ui.providerModel, ui.providerEffort, ui.providerContext, ui.providerDiscover, ui.providerPreset, ui.providerProtocol, ui.providerVision]) input.disabled = providerPending || Boolean(state.busy);
    ui.providerClear.hidden = !custom;ui.providerClear.textContent=builtin?'移除服务':'停用此接口'; ui.providerClear.disabled = busy();
    ui.providerSave.disabled = busy() || reconnecting;
    ui.providerSave.textContent = providerPending === 'test' ? '正在检测接口…' : providerPending === 'save' ? '正在连接…' : builtin?'保存服务':custom ? '保存并重新连接' : '保存并连接';
    ui.providerForm.classList.toggle('is-choosing',!ui.providerPreset.value);
    renderModelList(); renderProbe();
  }

  function renderModelList() {
    const models = knownModels(), list = ui.providerModelList, status = ui.providerModelStatus;
    const query = ui.providerModel.value.trim().toLowerCase();
    list.replaceChildren();
    const matches = models ? models.filter(id => !query || id.toLowerCase().includes(query)) : [];
    if (listOpen && models) {
      for (const id of matches.slice(0, 200)) {
        const item = makeElement('li', 'model-combo-option', id); item.id='provider-model-'+list.children.length;item.setAttribute('role', 'option'); item.dataset.model = id;
        item.setAttribute('aria-selected', String(id === ui.providerModel.value.trim()));
        item.addEventListener('mousedown', event => { event.preventDefault(); chooseModel(id); });
        list.append(item);
      }
      if (!matches.length) list.append(makeElement('li', 'model-combo-empty', query ? `列表里没有「${ui.providerModel.value.trim()}」，也可以直接用这个名称保存` : '列表为空'));
    }
    list.hidden = !(listOpen && models);
    ui.providerModel.setAttribute('aria-expanded', String(!list.hidden));
    status.dataset.kind = '';
    if (discovering) status.textContent = '正在读取接口的模型列表…';
    else if (discoveredFor?.error) { status.textContent = discoveredFor.error; status.dataset.kind = 'error'; }
    else if (discovered) status.textContent = `${discovered.length} 个模型${query && matches.length !== discovered.length ? `，匹配 ${matches.length} 个` : ''}`;
    else if (discoveredFor && !discoveredFor.error) status.textContent = '未提供模型列表，可手动输入';
    else if (models) status.textContent = `${models.length} 个模型`;
    else status.textContent = '';
    status.hidden = !status.textContent;
  }

  function chooseModel(id) {
    ui.providerModel.value = id; formEdited = true; listOpen = false; probe = null;
    renderModelList(); renderProbe(); ui.providerModel.focus();
  }

  function renderProbe() {
    const box = ui.providerProbe;
    box.hidden = !probe;
    if (!probe) { ui.providerForce.hidden = true; return; }
    box.dataset.kind = probe.kind;
    ui.providerProbeTitle.textContent = probe.title;
    ui.providerProbeHint.textContent = probe.hint || '';
    ui.providerProbeHint.hidden = !probe.hint;
    ui.providerForce.hidden = !probe.allowForce;
    ui.providerForce.disabled = busy();
    if(probe.kind==='error'&&ui.connectionDialog.open&&tab==='api')box.scrollIntoView({block:'nearest'});
  }

  function scheduleDiscovery(delay = 600) {
    clearTimeout(discoverTimer);
    discoverTimer = setTimeout(() => { void discoverModels(); }, delay);
  }

  async function discoverModels({force = false} = {}) {
    if (tab !== 'api' || !ui.connectionDialog.open || providerPending) return;
    const baseUrl = ui.providerBaseUrl.value.trim();
    const hasKey = Boolean(ui.providerApiKey.value) || canReuseSavedKey();
    if (!baseUrl || !hasKey) return;
    const signature = endpointSignature();
    if (!force && (discovering === signature || discoveredFor?.signature === signature)) return;
    discovering = signature; renderModelList();
    try {
      const result = await window.vibeDesktop.agent.configureProvider({action:'discover', settings:{id:editingService?.id,baseUrl, apiKey:ui.providerApiKey.value,api:ui.providerProtocol.value}});
      if (discovering !== signature || endpointSignature() !== signature) return;
      if (result.ok) { discovered = result.models; discoveredFor = {signature, error:null}; }
      else { discovered = null; discoveredFor = {signature, error:`${result.message}${result.hint ? `（${result.hint}）` : ''}`}; }
      if (result.ok && result.models && document.activeElement === ui.providerModel) listOpen = true;
    } catch (error) {
      if (discovering !== signature) return;
      discovered = null; discoveredFor = {signature, error:error.message};
    } finally {
      if (discovering === signature) { discovering = null; renderModelList(); }
    }
  }

  function currentSettings() {
    return {id:editingService?.id,name:ui.providerName.value.trim()||(ui.providerPreset.value==='custom'?'自定义接口':ui.providerPreset.selectedOptions[0].textContent),api:ui.providerProtocol.value,vision:ui.providerVision.checked,baseUrl:ui.providerBaseUrl.value, apiKey:ui.providerApiKey.value, model:ui.providerModel.value.trim(), effort:ui.providerEffort.value,
      contextWindow:ui.providerContext.value ? Number(ui.providerContext.value) : undefined, models:knownModels() || []};
  }

  async function saveProvider({skipTest = false} = {}) {
    if (providerPending || busy()) return;
    clearFieldErrors();
    if(!ui.providerPreset.value){fieldError(ui.providerPreset,'请选择服务');return;}
    const settings = currentSettings();
    ui.connectionError.hidden = true;
    const missing = !settings.baseUrl.trim() ? ui.providerBaseUrl : !settings.apiKey && !canReuseSavedKey() ? ui.providerApiKey : !settings.model ? ui.providerModel : null;
    if (missing) {
      fieldError(missing,missing === ui.providerBaseUrl ? '请填写接口地址' : missing === ui.providerApiKey ? '请填写 API 密钥' : '请选择或填写模型名称');return;
    }
    listOpen = false; renderModelList();
    try {
      if (!skipTest) {
        providerPending = 'test'; probe = {kind:'pending', title:`正在用 ${settings.model} 发送一条测试请求…`, hint:''}; renderForm();
        const result = await window.vibeDesktop.agent.configureProvider({action:'test', settings});
        if (!result.ok) {
          probe = {kind:'error', title:result.message, hint:result.hint || '', allowForce:result.code !== 'invalid'};
          return;
        }
      }
      providerPending = 'save'; probe = {kind:'pending', title:skipTest ? '正在保存并连接…' : `接口可用（${Math.round((probe?.elapsedMs || 0) / 100) / 10 || ''}），正在保存并连接…`.replace('（），', '，'), hint:''}; renderForm();
      const snapshot = await window.vibeDesktop.agent.configureProvider({action:'save', settings});
      const hadHistory=(state.messages||[]).some(m=>m.type==='user');
      formEdited = false; ui.providerApiKey.value = ''; probe = null;
      ports.applyAgentState(snapshot); await ports.loadCandidates(); await ports.refreshModelOptions(true).catch(() => {});
      ports.showToast(snapshot.runtime==='builtin'?'模型服务已保存':isReady(snapshot)?'已连接':'接口已保存');
      if(isReady(snapshot)&&!hadHistory)ui.connectionDialog.close();else selectTab('services');
    } catch (error) {
      probe = {kind:'error', title:providerPending === 'save' ? '保存服务未完成' : '检测没有完成', hint:error.message, allowForce:false};
    } finally {
      providerPending = false; renderForm(); updateAgentConnection({});
    }
  }

  async function clearProvider({quiet = false} = {}) {
    if (providerPending || busy()) return;
    if(state.runtime==='builtin'&&editingService){
      confirmation={kind:'remove',service:editingService};
      ui.serviceConfirmTitle.textContent='移除模型服务';ui.serviceConfirmDestination.textContent=editingService.baseUrl;
      ui.serviceConfirmImpact.textContent='使用它的对话仍会保留，继续提问前需要重新选择服务。';
      ui.serviceConfirmApply.textContent='移除服务';selectTab('confirm');return;
    }
    providerPending = 'save'; ui.connectionError.hidden = true; renderForm();
    try {
      const snapshot = await window.vibeDesktop.agent.configureProvider({action:'clear'});
      fillForm(null); ports.applyAgentState(snapshot); await ports.refreshModelOptions(true).catch(() => {});
      if (!quiet) ports.showToast('已停用自定义接口');
      return true;
    } catch (error) {
      ui.connectionError.textContent = error.message; ui.connectionError.hidden = false; ports.showToast(error.message); return false;
    } finally { providerPending = false; renderForm(); updateAgentConnection({}); }
  }

  // --------------------------------------------------------------- account
  async function accountAction(action) {
    if (accountPending) return;
    accountPending = true; ui.connectionError.hidden = true; updateAgentConnection({});
    try { ports.applyAgentState(await window.vibeDesktop.agent.account(action)); if (action === 'login') ports.showToast('已在浏览器中打开 ChatGPT 登录页'); }
    catch (error) { ui.connectionError.textContent = error.message; ui.connectionError.hidden = false; ports.showToast(error.message); }
    finally { accountPending = false; updateAgentConnection({}); }
  }

  async function loginAction() {
    if(state.runtime==='builtin'){
      if(busy())return;providerPending='runtime';updateAgentConnection({});
      try{ports.applyAgentState(await window.vibeDesktop.agent.configureProvider({action:'new-runtime',runtime:'codex'}));selectTab('chatgpt');}
      catch(error){ui.connectionError.textContent=error.message;ui.connectionError.hidden=false;}
      finally{providerPending=false;updateAgentConnection({});}
      return;
    }
    if (state.signingIn) return accountAction('cancel');
    if (state.customProvider && state.runtime!=='builtin') { if (!(await clearProvider({quiet:true}))) return; }
    return accountAction('login');
  }

  // ---------------------------------------------------------------- footer
  function connectionLabel() {
    const custom = state.customProvider;
    if (custom) return `${custom.name && custom.name !== '自定义接口' ? custom.name : '自定义接口'} · ${custom.baseUrl.replace(/^https?:\/\//, '')}`;
    if (state.accountMode === 'application') return state.account ? `ChatGPT${state.account.planType ? ` · ${state.account.planType}` : ''}` : '尚未连接';
    return `${state.providerName || 'OpenAI'} · 本机 Codex 配置`;
  }

  function renderFooter() {
    ui.connectionDialog.querySelector('.connection-footer').hidden=tab!=='services'||!isReady(state);
    const t = state.transmission;
    ui.modelConnection.textContent = connectionLabel();
    const modelIssue = state.modelConfigurationError || state.modelCatalog?.error;
    ui.modelConnectionStatus.textContent = reconnecting ? '正在重新连接…' : state.signingIn ? '等待浏览器登录' : modelIssue ? (state.modelConfigurationError ? '模型配置需要更新' : '模型目录不可用') :
      state.status === 'ready' ? '已连接' : state.status === 'busy' ? '正在处理问题' : state.status === 'auth-required' ? (state.accountMode === 'application' ? '尚未连接模型服务' : '需要登录') :
      state.status === 'starting' ? '正在启动…' : state.status === 'unavailable' ? '连接失败' : state.status === 'stopped' ? '已停止' : '尚未就绪';
    ui.connectionLight.dataset.state = reconnecting ? 'starting' : state.status || 'idle';
    ui.connectionModel.textContent = state.model ? `${state.model}${state.effort && effortLabels[state.effort] ? ` · 思考深度 ${effortLabels[state.effort]}` : ''}` : '尚未选择';
    ui.connectionChooseModel.disabled = !isReady(state) || busy();
    ui.modelReconnect.disabled = accountPending || reconnecting || state.canReconnect === false || state.signingIn;
    ui.modelReconnect.textContent = reconnecting ? '正在连接…' : t?.phase === 'retrying' ? '停止并重新连接' : '重新连接';
    ui.modelReconnect.hidden = state.status === 'auth-required' && state.accountMode === 'application' && !state.customProvider && !network.stale;
    if (modelIssue) { ui.connectionError.textContent = `${state.modelConfigurationError ? '模型配置' : '模型目录'}：${modelIssue.message}`; ui.connectionError.hidden = false; }
    else if (/^(模型配置|模型目录)：/.test(ui.connectionError.textContent)) { ui.connectionError.textContent = ''; ui.connectionError.hidden = true; }
  }

  // ---------------------------------------------------------------- notice
  function renderNotice() {
    const t = state.transmission, disconnected = ['unavailable','stopped','auth-required'].includes(state.status);
    const application = state.accountMode === 'application', custom = state.customProvider, unconnected = state.status === 'auth-required';
    const bindingIssue=state.runtime==='builtin'&&state.modelConfigurationError;
    ui.agentPane.classList.toggle('needs-connection',unconnected&&!bindingIssue);
    ui.agentBindProvider.hidden=!(bindingIssue&&state.canBindProvider);ui.agentBindProvider.disabled=busy();
    ui.agentBindProvider.title='选择此对话使用的模型服务';
    ui.agentNotice.hidden = (!t || t.phase==='interrupted') && !disconnected && !reconnecting && !bindingIssue;
    if (ui.agentNotice.hidden) return;
    ui.agentNotice.dataset.phase = t?.phase || (unconnected ? 'login' : 'disconnected');
    ui.agentNoticeTitle.textContent = state.signingIn ? '在浏览器中完成登录' : reconnecting ? '正在重新连接' : t?.phase === 'retrying' ? '连接中断，正在重试' : t?.phase === 'failed' ? '这次回答没有完成' : t?.phase === 'interrupted' ? '回答已停止' : unconnected ? (application ? '连接 AI' : '需要登录') : custom ? '接口连接失败' : '连接已断开';
    ui.agentNoticeText.textContent = state.runtime==='builtin'&&unconnected?'使用 API 密钥或 ChatGPT 账号。':state.signingIn ? '完成后这里会自动连接。你也可以继续编辑电路。' : t?.phase === 'retrying' ? '草稿和已有改动已保留，可以等待恢复。' :
      unconnected ? (application ? '登录 ChatGPT 账号，或填写自己的 API 接口（中转站、DeepSeek 等）。不连接也可以正常画图和仿真。' : '本机 Codex 登录失效，恢复后点击重新连接。') :
      custom && disconnected ? '打开 AI 设置检查接口地址、密钥和模型，保存时会先自动检测。' : '已有内容仍保留，可以继续编辑或提问。';
    ui.agentNoticeDetails.textContent = String(t?.message || state.detail || ''); ui.agentNoticeDetails.parentElement.hidden = !ui.agentNoticeDetails.textContent;
    const loginPrimary = unconnected && application && !custom;
    ui.agentReconnect.hidden = (t?.phase === 'interrupted' && !disconnected) || (unconnected && application && custom);
    if(state.runtime==='builtin'&&unconnected)ui.agentReconnect.hidden=true;
    ui.agentReconnect.textContent = accountPending ? '正在处理…' : state.signingIn ? '取消登录' : loginPrimary ? '登录 ChatGPT' : reconnecting ? '正在连接…' : t?.phase === 'retrying' ? '停止并重新连接' : '重新连接';
    ui.agentReconnect.disabled = accountPending || reconnecting || (loginPrimary ? Boolean(state.busy) : state.canReconnect === false);
    ui.agentConfigureApi.hidden = state.signingIn || !(unconnected || (disconnected && custom));
    ui.agentConfigureApi.textContent = custom ? '模型服务设置' : '连接 AI';
    ui.agentConfigureApi.disabled = busy();
    ui.agentReviewChanges.hidden = true;
    // Only real failures invite a report; the first-run "not connected yet" state is not one.
    ui.agentReportIssue.hidden = Boolean(state.signingIn) || reconnecting || unconnected || !(t?.phase === 'failed' || ['unavailable','stopped'].includes(state.status));
    ui.agentStatusText.textContent = unconnected ? (state.signingIn ? '等待登录完成' : application ? '尚未连接 AI' : '未登录') : reconnecting ? '正在连接' : t?.phase === 'retrying' ? '等待连接恢复' : disconnected ? '连接需要处理' : state.busy ? '正在结束回答' : '可以继续提问';
    if(bindingIssue){
      ui.agentNoticeTitle.textContent='选择这条会话的模型服务';
      ui.agentNoticeText.textContent=bindingIssue.message;
      ui.agentNoticeDetails.parentElement.hidden=true;ui.agentReconnect.hidden=true;
      ui.agentConfigureApi.hidden=Boolean(state.canBindProvider);ui.agentConfigureApi.textContent='添加服务';
      ui.agentReviewChanges.hidden=true;ui.agentReportIssue.hidden=true;ui.agentStatusText.textContent='等待选择模型服务';
    }
    if (t?.phase === 'retrying' || disconnected) { const light = unconnected ? 'idle' : 'unavailable'; ui.agentStatusLight.dataset.state = light; ui.agentTabLight.dataset.state = light; }
  }

  async function reconnectAgent() {
    if(state.runtime==='builtin'&&!state.customProvider){openConnectionDialog('services');return;}
    if (state.accountMode === 'application' && !state.customProvider && (state.signingIn || state.status === 'auth-required')) return loginAction();
    if (reconnecting) return; reconnecting = true; ui.connectionError.hidden = true; updateAgentConnection({});
    try {
      ports.applyAgentState(await window.vibeDesktop.agent.reconnect()); await ports.loadCandidates();
      network.stale = false; if (ui.connectionDialog.open) void checkNetwork();
      ports.showToast('连接已恢复，可以继续提问'); if (ui.modelDialog.open || ui.effortMenu.matches(':popover-open')) await ports.refreshModelOptions(true);
    } catch (error) { const snapshot = await window.vibeDesktop.agent.getState().catch(() => ({status:'unavailable'})); ports.applyAgentState({...snapshot, detail:error.message}); ui.connectionError.textContent = error.message; ui.connectionError.hidden = false; ports.showToast('重新连接未完成：' + error.message); }
    finally { reconnecting = false; updateAgentConnection({}); }
  }

  // ----------------------------------------------------------------- mount
  function mountAgentConnection() {
    if (!window.vibeDesktop?.agent) return;
    ui.connectionClose.replaceChildren(icon('X')); ui.providerDiscover.replaceChildren(icon('RefreshCw'));
    ui.agentBindProvider.addEventListener('click',()=>openConnectionDialog('services'));
    ui.agentSettings.addEventListener('click', () => openConnectionDialog());
    ui.agentConfigureApi.addEventListener('click', () => { ui.connectionDialog.open && ui.connectionDialog.close(); openConnectionDialog('services'); });
    ui.connectionClose.addEventListener('click', () => ui.connectionDialog.close());
    ui.connectionDialog.addEventListener('close', () => { listOpen = false; clearTimeout(discoverTimer); renderModelList(); });
    ui.settingsServices.addEventListener('click', () => selectTab('services'));
    ui.settingsRuntime.addEventListener('click', () => selectTab('runtime'));
    for(const [button,runtime] of [[ui.useBuiltinRuntime,'builtin'],[ui.useCodexRuntime,'codex']]) button.addEventListener('click',async()=>{
      if(busy())return;providerPending='runtime';renderForm();renderOverview();
      try {const next=await window.vibeDesktop.agent.configureProvider({action:'new-runtime',runtime});ports.applyAgentState(next);formEdited=false;fillForm(next.customProvider);await ports.refreshModelOptions(true).catch(()=>{});}
      catch(error){ui.connectionError.textContent=error.message;ui.connectionError.hidden=false;}
      finally{providerPending=false;updateAgentConnection({});}
    });
    ui.defaultRuntime.addEventListener('change',async()=>{
      try{ports.applyAgentState(await window.vibeDesktop.agent.configureProvider({action:'default-runtime',runtime:ui.defaultRuntime.value}));}
      catch(error){ports.showToast(error.message);renderOverview();}
    });
    ui.defaultService.addEventListener('change',async()=>{
      try{ports.applyAgentState(await window.vibeDesktop.agent.configureProvider({action:'default-service',settings:{id:ui.defaultService.value}}));}
      catch(error){ports.showToast(error.message);renderOverview();}
    });
    ui.serviceConfirmCancel.addEventListener('click',()=>{confirmation=null;selectTab('services');});
    ui.serviceConfirmApply.addEventListener('click',applyServiceAction);
    ui.settingsBack.addEventListener('click', () => selectTab('services'));
    for (const [button, name] of [[ui.connectionTabChatgpt, 'chatgpt'], [ui.connectionTabApi, 'api']]) button.addEventListener('click', () => {if(name==='api'){fillForm(state.runtime==='builtin'?null:state.customProvider);renderForm();}selectTab(name);});
    ui.providerPreset.addEventListener('change', () => {
      const preset=presets[ui.providerPreset.value];
      ui.providerBaseUrl.closest('label').hidden=Boolean(preset);
      if(preset){if(ui.providerBaseUrl.value!==preset.url)ui.providerApiKey.value='';ui.providerBaseUrl.value=preset.url;ui.providerProtocol.value=preset.api;}
      discoveryRevision++;clearFieldErrors();formEdited = true; probe = null; discovered = null; discoveredFor = null;
      renderForm(); scheduleDiscovery();
    });
    ui.connectionLogin.addEventListener('click', loginAction);
    ui.connectionLogout.addEventListener('click', () => accountAction('logout'));
    ui.connectionChooseModel.addEventListener('click', () => { ui.connectionDialog.close(); ports.openModelPicker(); });
    ui.modelReconnect.addEventListener('click', reconnectAgent); ui.agentReconnect.addEventListener('click', reconnectAgent);
    ui.connectionNetworkRefresh.addEventListener('click', () => { void checkNetwork(); });
    ui.agentReviewChanges.addEventListener('click', () => { ports.loadCandidates(); ports.switchReviewTab('proposal'); });
    ui.providerForm.addEventListener('submit', event => { event.preventDefault(); void saveProvider(); });
    ui.providerForce.addEventListener('click', () => saveProvider({skipTest:true}));
    ui.providerClear.addEventListener('click', () => clearProvider());
    ui.providerDiscover.addEventListener('click', () => { listOpen = true; void discoverModels({force:true}); });
    for (const input of [ui.providerBaseUrl, ui.providerApiKey]) input.addEventListener('input', () => { discoveryRevision++;clearFieldErrors();formEdited = true; probe = null; discovered = null; discoveredFor = null; renderForm(); scheduleDiscovery(); });
    for (const input of [ui.providerName, ui.providerEffort, ui.providerContext, ui.providerProtocol, ui.providerVision]) input.addEventListener('change', () => { formEdited = true; probe = null; renderProbe(); });
    ui.providerProtocol.addEventListener('change',()=>{discoveryRevision++;discovered=null;discoveredFor=null;renderModelList();scheduleDiscovery();});
    ui.providerModel.addEventListener('input', () => { clearFieldErrors(); formEdited = true; probe = null; listOpen = true; renderModelList(); renderProbe(); });
    ui.providerModel.addEventListener('focus', () => { listOpen = true; renderModelList(); void discoverModels(); });
    ui.providerModel.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ui.providerModel) { listOpen = false; renderModelList(); } }, 120));
    ui.providerModel.addEventListener('keydown', event => {
      const options = [...ui.providerModelList.querySelectorAll('[role=option]')];
      const active = options.findIndex(option => option.classList.contains('is-active'));
      if (event.key === 'Escape' && listOpen) { event.preventDefault(); event.stopPropagation(); listOpen = false; renderModelList(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); if (!listOpen) { listOpen = true; renderModelList(); return; }
        if (!options.length) return;
        const next = event.key === 'ArrowDown' ? (active + 1) % options.length : (active <= 0 ? options.length : active) - 1;
        options.forEach((option, index) => option.classList.toggle('is-active', index === next)); options[next].scrollIntoView({block:'nearest'});
        ui.providerModel.setAttribute('aria-activedescendant', options[next].id || ''); return;
      }
      if (event.key === 'Enter') { event.preventDefault(); if (listOpen && active >= 0) chooseModel(options[active].dataset.model); else void saveProvider(); }
    });
  }

  const reportAgentError = message => updateAgentConnection({transmission:{phase:'failed', message}});
  return {mountAgentConnection, updateAgentConnection, reportAgentError, openConnectionDialog};
}
