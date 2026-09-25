import {makeElement} from '../core/dom.js';
import {icon} from '../core/chat-dom.js';

// AI 设置: two ways to connect (ChatGPT account, or a student's own
// OpenAI-compatible endpoint), the preflight for the latter, and the small
// status banner in the agent pane. The key never reaches this module.
export const modelDependencies = [];
export const dependencies = ['applyAgentState','updateAgentPreferences','openModelPicker','refreshModelOptions','loadCandidates','showToast','switchReviewTab'];

const effortLabels = {none:'关闭', low:'轻度', medium:'中', high:'高'};
const isReady = state => ['ready','busy'].includes(state.status);

export function createController({ui,ports}) {
  let state = {}, reconnecting = false, accountPending = false, providerPending = false;
  let tab = 'chatgpt', tabChosen = false, formEdited = false;
  let discovered = null, discoveredFor = null, discovering = null, discoverTimer = null;
  let probe = null, listOpen = false;
  // System proxy: `network.active` = what the running AI engine was started
  // with (from agent state); `network.current` = a fresh resolution when the
  // dialog opens or the student clicks 重新检测. They differ after toggling
  // Clash/v2rayN "system proxy" — then reconnecting applies the new route.
  let network = {current:null, active:null, stale:false, checking:false, error:null};

  const busy = () => Boolean(state.busy) || providerPending || accountPending;
  const endpointSignature = () => `${ui.providerBaseUrl.value.trim()}\n${ui.providerApiKey.value ? 'typed' : state.customProvider ? 'saved:' + state.customProvider.baseUrl : 'none'}`;
  const knownModels = () => discovered || (state.customProvider?.models?.length ? state.customProvider.models : null);

  // ---------------------------------------------------------------- dialog
  function updateAgentConnection(snapshot) {
    state = {...state, ...snapshot};
    if (snapshot && 'network' in snapshot) { network.active = snapshot.network || null; if (!network.current) network.current = network.active; network.stale = Boolean(network.current && network.active && (network.current.proxyUrl || null) !== (network.active.proxyUrl || null)); }
    ports.updateAgentPreferences(state);
    renderPane(); renderForm(); renderFooter(); renderNotice();
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
    const detail = network.stale ? `系统代理设置已变化（当前 ${routeOf(network.current).label}，AI 引擎仍在用 ${routeOf(network.active).label}）。点「重新连接」后生效。` : route.sentence;
    ui.connectionNetworkDetail.textContent = detail; ui.connectionNetworkDetail.hidden = !detail;
    ui.connectionNetworkRefresh.disabled = network.checking;
  }


  function selectTab(name, {byUser = false} = {}) {
    tab = name; if (byUser) tabChosen = true;
    for (const [button, pane, id] of [[ui.connectionTabChatgpt, ui.connectionPaneChatgpt, 'chatgpt'], [ui.connectionTabApi, ui.connectionPaneApi, 'api']]) {
      button.setAttribute('aria-selected', String(id === name)); button.tabIndex = id === name ? 0 : -1; pane.hidden = id !== name;
    }
    if (name === 'api') scheduleDiscovery(0);
  }

  function openConnectionDialog(which) {
    if (document.querySelector('dialog[open]')) return;
    if (!formEdited) fillForm(state.customProvider);
    probe = null;
    selectTab(which || (tabChosen ? tab : state.customProvider ? 'api' : state.account && state.accountMode === 'application' ? 'chatgpt' : 'api'));
    ui.connectionError.hidden = true;
    ui.connectionDialog.showModal();
    renderNetwork(); void checkNetwork();
    if (tab === 'api') (ui.providerBaseUrl.value ? ui.providerSave : ui.providerBaseUrl).focus();
  }

  function renderPane() {
    const custom = state.customProvider, shared = state.accountMode !== 'application', account = state.account;
    const card = ui.accountCard;
    const setCard = (kind, title, detail) => { card.dataset.state = kind; ui.accountTitle.textContent = title; ui.accountDetail.textContent = detail; };
    if (state.signingIn) setCard('signing-in', '正在浏览器中登录…', '完成后会自动回到这里并连接。');
    else if (custom) setCard('inactive', 'ChatGPT 登录未启用', `当前使用自定义接口 ${custom.baseUrl}。切换到 ChatGPT 会停用这个接口。`);
    else if (account) setCard('signed-in', account.type === 'chatgpt' ? `已登录 ChatGPT${account.planType ? ` · ${account.planType}` : ''}` : '已通过 API 密钥连接 OpenAI', shared ? '沿用这台电脑上 Codex 的登录。' : '模型由 OpenAI 提供，AI 的改动会直接写进你打开的文件夹。');
    else setCard('signed-out', '未登录', shared ? '开发环境沿用本机 Codex 的登录，请在终端运行 codex login。' : '用你的 ChatGPT 账号登录，在浏览器里完成后自动回到这里。');
    const route = routeOf(network.current);
    const routeLine = route.kind === 'proxy' ? `访问 chatgpt.com 会经过${route.label}。` : route.kind === 'unsupported' ? route.sentence : route.kind === 'direct' && !account ? '未检测到系统代理：能直接打开 chatgpt.com 的网络才能登录成功，否则先在代理软件里开启「系统代理」，再点右下角「重新检测」。' : '';
    ui.chatgptNote.textContent = custom ? '只有 ChatGPT 账号（Plus/Pro/Team 或免费额度）能走这条路；没有账号的话请留在「自定义接口」。' : `模型由 OpenAI 提供，不需要填写任何密钥。${routeLine}没有账号或无法访问时，用旁边的「自定义接口」。`;
    const login = ui.connectionLogin;
    login.hidden = Boolean(account) && !state.signingIn && !custom;
    login.textContent = state.signingIn ? '取消登录' : custom ? '停用接口并登录 ChatGPT' : '登录 ChatGPT';
    login.className = state.signingIn || custom ? 'quiet-button' : 'primary-button';
    login.disabled = busy() || reconnecting || (shared && !custom);
    login.title = shared && !custom ? '开发环境沿用本机 Codex 登录' : '';
    ui.connectionLogout.hidden = shared || !account || Boolean(custom) || state.signingIn;
    ui.connectionLogout.disabled = busy();
  }

  // ------------------------------------------------------------------ form
  function fillForm(custom) {
    ui.providerBaseUrl.value = custom?.baseUrl || '';
    ui.providerApiKey.value = '';
    ui.providerModel.value = custom?.model || '';
    ui.providerEffort.value = effortLabels[custom?.effort] ? custom.effort : 'medium';
    ui.providerContext.value = custom?.contextWindow && custom.contextWindow !== 256000 ? custom.contextWindow : '';
    formEdited = false; discovered = null; discoveredFor = null; probe = null; listOpen = false;
  }

  function renderForm() {
    const custom = state.customProvider;
    ui.providerApiKey.placeholder = custom?.apiKeyHint ? `已保存 ${custom.apiKeyHint}，留空即沿用` : 'sk-…';
    for (const input of [ui.providerBaseUrl, ui.providerApiKey, ui.providerModel, ui.providerEffort, ui.providerContext, ui.providerDiscover]) input.disabled = providerPending || Boolean(state.busy);
    ui.providerClear.hidden = !custom; ui.providerClear.disabled = busy();
    ui.providerSave.disabled = busy() || reconnecting;
    ui.providerSave.textContent = providerPending === 'test' ? '正在检测接口…' : providerPending === 'save' ? '正在连接…' : custom ? '保存并重新连接' : '保存并连接';
    renderModelList(); renderProbe();
  }

  function renderModelList() {
    const models = knownModels(), list = ui.providerModelList, status = ui.providerModelStatus;
    const query = ui.providerModel.value.trim().toLowerCase();
    list.replaceChildren();
    const matches = models ? models.filter(id => !query || id.toLowerCase().includes(query)) : [];
    if (listOpen && models) {
      for (const id of matches.slice(0, 200)) {
        const item = makeElement('li', 'model-combo-option', id); item.setAttribute('role', 'option'); item.dataset.model = id;
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
    else if (discovered) status.textContent = `接口提供 ${discovered.length} 个模型${query && matches.length !== discovered.length ? `，匹配 ${matches.length} 个` : ''}；点击输入框选择，或直接输入`;
    else if (discoveredFor && !discoveredFor.error) status.textContent = '这个接口没有提供模型列表，请手动填写模型名称';
    else if (models) status.textContent = `上次保存时读到 ${models.length} 个模型；点击输入框选择`;
    else status.textContent = '填好地址和密钥后会自动读取模型列表';
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
  }

  function scheduleDiscovery(delay = 600) {
    clearTimeout(discoverTimer);
    discoverTimer = setTimeout(() => { void discoverModels(); }, delay);
  }

  async function discoverModels({force = false} = {}) {
    if (tab !== 'api' || !ui.connectionDialog.open || providerPending) return;
    const baseUrl = ui.providerBaseUrl.value.trim();
    const hasKey = Boolean(ui.providerApiKey.value) || Boolean(state.customProvider);
    if (!baseUrl || !hasKey) return;
    const signature = endpointSignature();
    if (!force && (discovering === signature || discoveredFor?.signature === signature)) return;
    discovering = signature; renderModelList();
    try {
      const result = await window.vibeDesktop.agent.configureProvider({action:'discover', settings:{baseUrl, apiKey:ui.providerApiKey.value}});
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
    return {baseUrl:ui.providerBaseUrl.value, apiKey:ui.providerApiKey.value, model:ui.providerModel.value.trim(), effort:ui.providerEffort.value,
      contextWindow:ui.providerContext.value ? Number(ui.providerContext.value) : undefined, models:knownModels() || []};
  }

  async function saveProvider({skipTest = false} = {}) {
    if (providerPending || busy()) return;
    const settings = currentSettings();
    ui.connectionError.hidden = true;
    const missing = !settings.baseUrl.trim() ? ui.providerBaseUrl : !settings.apiKey && !state.customProvider ? ui.providerApiKey : !settings.model ? ui.providerModel : null;
    if (missing) {
      probe = {kind:'error', title:missing === ui.providerBaseUrl ? '请填写接口地址' : missing === ui.providerApiKey ? '请填写 API 密钥' : '请选择或填写模型名称', hint:missing === ui.providerModel && discovered?.length ? '点击模型输入框可以从列表里选。' : ''};
      renderProbe(); missing.focus(); return;
    }
    listOpen = false; renderModelList();
    try {
      if (!skipTest) {
        providerPending = 'test'; probe = {kind:'pending', title:`正在用 ${settings.model} 发送一条测试请求…`, hint:'确认地址、密钥和模型都能用后再保存。'}; renderForm();
        const result = await window.vibeDesktop.agent.configureProvider({action:'test', settings});
        if (!result.ok) {
          probe = {kind:'error', title:result.message, hint:result.hint || '', allowForce:result.code !== 'invalid'};
          return;
        }
      }
      providerPending = 'save'; probe = {kind:'pending', title:skipTest ? '正在保存并连接…' : `接口可用（${Math.round((probe?.elapsedMs || 0) / 100) / 10 || ''}），正在保存并连接…`.replace('（），', '，'), hint:''}; renderForm();
      const snapshot = await window.vibeDesktop.agent.configureProvider({action:'save', settings});
      formEdited = false; ui.providerApiKey.value = ''; probe = null;
      ports.applyAgentState(snapshot); await ports.loadCandidates(); await ports.refreshModelOptions(true).catch(() => {});
      ports.showToast(isReady(snapshot) ? `已连接 ${snapshot.customProvider?.model || '自定义接口'}` : '接口已保存');
      if (isReady(snapshot)) ui.connectionDialog.close();
    } catch (error) {
      probe = {kind:'error', title:providerPending === 'save' ? '接口设置已保存，但连接没有建立' : '检测没有完成', hint:error.message, allowForce:false};
    } finally {
      providerPending = false; renderForm(); updateAgentConnection({});
    }
  }

  async function clearProvider({quiet = false} = {}) {
    if (providerPending || busy()) return;
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
    if (state.signingIn) return accountAction('cancel');
    if (state.customProvider) { if (!(await clearProvider({quiet:true}))) return; }
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
    const t = state.transmission;
    ui.modelConnection.textContent = connectionLabel();
    const modelIssue = state.modelConfigurationError || state.modelCatalog?.error;
    ui.modelConnectionStatus.textContent = reconnecting ? '正在重新连接…' : state.signingIn ? '等待浏览器登录' : modelIssue ? (state.modelConfigurationError ? '模型配置需要更新' : '模型目录不可用') :
      state.status === 'ready' ? '已连接' : state.status === 'busy' ? '正在处理问题' : state.status === 'auth-required' ? (state.accountMode === 'application' ? '选择上面任一方式开始' : '需要登录') :
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
    ui.agentNotice.hidden = !t && !disconnected && !reconnecting;
    if (ui.agentNotice.hidden) return;
    ui.agentNotice.dataset.phase = t?.phase || (unconnected ? 'login' : 'disconnected');
    ui.agentNoticeTitle.textContent = state.signingIn ? '在浏览器中完成登录' : reconnecting ? '正在重新连接' : t?.phase === 'retrying' ? '连接中断，正在重试' : t?.phase === 'failed' ? '这次回答没有完成' : t?.phase === 'interrupted' ? '回答已停止' : unconnected ? (application ? '连接 AI，一起做电路' : '需要登录') : custom ? '接口连接失败' : '连接已断开';
    ui.agentNoticeText.textContent = state.signingIn ? '完成后这里会自动连接。你也可以继续编辑电路。' : t?.phase === 'retrying' ? '草稿和已有改动已保留，可以等待恢复。' :
      unconnected ? (application ? '登录 ChatGPT 账号，或填写自己的 API 接口（中转站、DeepSeek 等）。不连接也可以正常画图和仿真。' : '本机 Codex 登录失效，恢复后点击重新连接。') :
      custom && disconnected ? '打开 AI 设置检查接口地址、密钥和模型，保存时会先自动检测。' : '已有内容仍保留，可以继续编辑或提问。';
    ui.agentNoticeDetails.textContent = String(t?.message || state.detail || ''); ui.agentNoticeDetails.parentElement.hidden = !ui.agentNoticeDetails.textContent;
    const loginPrimary = unconnected && application && !custom;
    ui.agentReconnect.hidden = (t?.phase === 'interrupted' && !disconnected) || (unconnected && application && custom);
    ui.agentReconnect.textContent = accountPending ? '正在处理…' : state.signingIn ? '取消登录' : loginPrimary ? '登录 ChatGPT' : reconnecting ? '正在连接…' : t?.phase === 'retrying' ? '停止并重新连接' : '重新连接';
    ui.agentReconnect.disabled = accountPending || reconnecting || (loginPrimary ? Boolean(state.busy) : state.canReconnect === false);
    ui.agentConfigureApi.hidden = state.signingIn || !(unconnected || (disconnected && custom));
    ui.agentConfigureApi.textContent = custom ? '检查 API 接口设置' : '填写 API 接口';
    ui.agentConfigureApi.disabled = busy();
    ui.agentReviewChanges.hidden = !t || unconnected;
    ui.agentStatusText.textContent = unconnected ? (state.signingIn ? '等待登录完成' : application ? '尚未连接 AI' : '未登录') : reconnecting ? '正在连接' : t?.phase === 'retrying' ? '等待连接恢复' : disconnected ? '连接需要处理' : state.busy ? '正在结束回答' : '可以继续提问';
    if (t?.phase === 'retrying' || disconnected) { const light = unconnected ? 'idle' : 'unavailable'; ui.agentStatusLight.dataset.state = light; ui.agentTabLight.dataset.state = light; }
  }

  async function reconnectAgent() {
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
    ui.agentSettings.addEventListener('click', () => openConnectionDialog());
    ui.agentConfigureApi.addEventListener('click', () => { ui.connectionDialog.open && ui.connectionDialog.close(); openConnectionDialog('api'); });
    ui.connectionClose.addEventListener('click', () => ui.connectionDialog.close());
    ui.connectionDialog.addEventListener('close', () => { listOpen = false; clearTimeout(discoverTimer); renderModelList(); });
    for (const [button, name] of [[ui.connectionTabChatgpt, 'chatgpt'], [ui.connectionTabApi, 'api']]) button.addEventListener('click', () => { selectTab(name, {byUser:true}); (name === 'api' ? ui.providerBaseUrl : ui.connectionLogin).focus(); });
    ui.connectionDialog.querySelector('.connection-tabs').addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight'].includes(event.key)) return; event.preventDefault();
      const next = tab === 'api' ? 'chatgpt' : 'api'; selectTab(next, {byUser:true}); (next === 'api' ? ui.connectionTabApi : ui.connectionTabChatgpt).focus();
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
    for (const input of [ui.providerBaseUrl, ui.providerApiKey]) input.addEventListener('input', () => { formEdited = true; probe = null; discovered = null; discoveredFor = null; renderModelList(); renderProbe(); scheduleDiscovery(); });
    for (const input of [ui.providerEffort, ui.providerContext]) input.addEventListener('change', () => { formEdited = true; probe = null; renderProbe(); });
    ui.providerModel.addEventListener('input', () => { formEdited = true; probe = null; listOpen = true; renderModelList(); renderProbe(); });
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
