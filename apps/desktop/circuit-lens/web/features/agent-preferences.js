import {makeElement} from '../core/dom.js';
import {icon} from '../core/chat-dom.js';
import {choiceMenu, placeAbove} from '../core/anchored-menu.js';

export const modelDependencies = [];
export const dependencies = ['applyAgentState'];
const efforts = {none:'关闭', minimal:'最少', low:'轻度', medium:'中', high:'高', xhigh:'极高', max:'最高', ultra:'Ultra'};
const descriptions = {
  'Our most capable model for complex, demanding work.':'适合复杂、要求较高的任务。',
  'Reliable agentic workhorse for everyday tasks.':'适合日常构建与持续协作。',
  'Balanced agentic coding model for everyday work.':'兼顾日常任务的能力与效率。',
  'Fast and affordable agentic coding model.':'适合希望较快完成的日常任务。',
  'Proven previous-generation model for coding and general work.':'适用于构建与通用任务的上一代模型。',
};

export function createController({ui, ports}) {
  let state = {}, models = [], loading = false, saving = false, loadEpoch = 0;
  let effortMenu;
  const busy = () => Boolean(state.busy || saving);
  const currentModel = () => models.find(model => model.model === state.model);
  const modelLabel = () => currentModel()?.name || state.model || '选择模型';
  const positionModel = () => { if (ui.modelDialog.open) placeAbove(ui.modelDialog, ui.agentModel, 370); };

  function trigger(button, text, label) {
    button.replaceChildren(makeElement('span', '', text), icon('ChevronUp'));
    button.title = label; button.setAttribute('aria-label', label);
    button.disabled = busy();
  }

  function updateAgentPreferences(snapshot) {
    state = {...state, ...snapshot};
    trigger(ui.agentModel, modelLabel(), '选择模型：' + modelLabel());
    trigger(ui.agentEffort, efforts[state.effort] || state.effort || '思考深度', '思考深度：' + (efforts[state.effort] || state.effort || '默认'));
    ui.modelBusy.hidden = !state.busy;
    ui.modelSearch.disabled = loading || saving;
    ui.modelRefresh.disabled = loading || busy();
    for (const panel of [ui.modelChoice, ui.effortOptions]) {
      for (const button of panel.querySelectorAll('button')) button.disabled = busy() || (panel === ui.effortOptions && loading);
    }
  }

  function row(name, description, checked) {
    const button = makeElement('button', 'preference-option'); button.type = 'button';
    button.setAttribute('role', 'menuitemradio'); button.setAttribute('aria-checked', String(checked));
    const text = makeElement('span', 'preference-option-text'); text.append(makeElement('strong', '', name));
    if (description) text.append(makeElement('small', '', description));
    button.append(text, icon('Check')); button.disabled = busy();
    return button;
  }

  async function savePreference(action, errorNode, close) {
    if (busy()) return;
    saving = true; errorNode.hidden = true; updateAgentPreferences({});
    try {
      const snapshot = await action();
      saving = false; ports.applyAgentState(snapshot); close();
    } catch (error) {
      errorNode.textContent = '未能更改：' + error.message; errorNode.hidden = false;
    } finally {
      saving = false; updateAgentPreferences({});
      effortMenu.position(); positionModel();
    }
  }

  function renderEfforts() {
    ui.effortOptions.replaceChildren();
    if (loading) { ui.effortOptions.append(makeElement('p', 'preference-empty', '正在读取…')); return; }
    for (const item of currentModel()?.efforts || []) {
      const button = row(efforts[item.value] || item.value, '', item.value === state.effort);
      button.dataset.effort = item.value;
      button.addEventListener('click', () => savePreference(
        () => window.vibeDesktop.agent.selectModel({model:state.model, effort:item.value}), ui.effortError, () => effortMenu.close(true)));
      ui.effortOptions.append(button);
    }
    if (!ui.effortOptions.childElementCount) ui.effortOptions.append(makeElement('p', 'preference-empty', '当前模型没有可调整的思考深度。'));
    effortMenu.position();
  }

  function renderModels() {
    ui.modelChoice.replaceChildren();
    const query = ui.modelSearch.value.trim().toLowerCase();
    const chosen = state.modelSelection?.model || '';
    const entries = [{model:'', name:'跟随本机配置', description:state.inheritedModel || '使用本机设置'}, ...models];
    for (const model of entries.filter(model => (model.name + ' ' + model.model).toLowerCase().includes(query))) {
      const button = row(model.name, descriptions[model.description] || model.description || model.model, model.model === chosen);
      button.classList.add('model-option'); button.dataset.model = model.model;
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(model.model === chosen));
      button.removeAttribute('aria-checked');
      button.addEventListener('click', () => {
        const effort = model.efforts?.some(item => item.value === state.effort) ? state.effort : model.defaultEffort;
        void savePreference(() => window.vibeDesktop.agent.selectModel(model.model ? {model:model.model, effort} : null), ui.modelError, () => ui.modelDialog.close());
      });
      ui.modelChoice.append(button);
    }
    if (!ui.modelChoice.childElementCount) ui.modelChoice.append(makeElement('p', 'model-empty', '没有找到这个模型'));
    const configurationIssue = state.modelConfigurationError;
    const unavailableSelection = chosen && !models.some(model => model.model === chosen);
    ui.modelDescription.hidden = !configurationIssue && !unavailableSelection;
    ui.modelDescription.textContent = configurationIssue?.message || '之前选择的模型目前不可用，请重新选择。';
    positionModel();
  }

  async function refreshModelOptions(refresh = false) {
    const epoch = ++loadEpoch;
    loading = true; ui.modelError.hidden = ui.effortError.hidden = true; ui.modelLoading.hidden = false;
    updateAgentPreferences({}); renderEfforts();
    try {
      const result = await window.vibeDesktop.agent.listModels(refresh);
      if (epoch !== loadEpoch) return;
      if (!Array.isArray(result.models) || !result.models.length) throw new Error('当前连接没有返回模型');
      models = result.models;
      if (result.state) ports.applyAgentState(result.state);
    } catch (error) {
      if (epoch !== loadEpoch) return;
      for (const node of [ui.modelError, ui.effortError]) { node.textContent = '无法读取模型：' + error.message; node.hidden = false; }
    } finally {
      if (epoch === loadEpoch) {
        loading = false; ui.modelLoading.hidden = true;
        renderModels(); renderEfforts(); updateAgentPreferences({}); positionModel();
      }
    }
  }

  function openModelPicker() {
    if (document.querySelector('dialog[open]')) return;
    effortMenu.close();
    ui.modelSearch.value = ''; renderModels();
    ui.modelDialog.showModal(); ui.agentModel.setAttribute('aria-expanded', 'true');
    positionModel(); void refreshModelOptions(); ui.modelSearch.focus();
  }

  function mountAgentPreferences() {
    if (!window.vibeDesktop?.agent) return;
    effortMenu = choiceMenu({trigger:ui.agentEffort, panel:ui.effortMenu, width:184, onOpen:refreshModelOptions});
    ui.modelClose.replaceChildren(icon('X'));
    ui.agentModel.addEventListener('click', openModelPicker);
    ui.agentModel.addEventListener('keydown', event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); openModelPicker(); } });
    ui.modelClose.addEventListener('click', () => ui.modelDialog.close());
    ui.modelDialog.addEventListener('close', () => {
      ++loadEpoch; loading = false; ui.agentModel.setAttribute('aria-expanded', 'false');
      ui.agentModel.focus(); updateAgentPreferences({});
    });
    ui.modelDialog.addEventListener('click', event => {
      if (event.target !== ui.modelDialog) return;
      const rect = ui.modelDialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) ui.modelDialog.close();
    });
    ui.modelDialog.addEventListener('keydown', event => {
      if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key) || (['Home','End'].includes(event.key) && event.target === ui.modelSearch)) return;
      const options = [...ui.modelChoice.querySelectorAll('button:not(:disabled)')];
      if (!options.length) return;
      event.preventDefault(); const index = options.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length-1 : (index + (event.key === 'ArrowDown' ? 1 : options.length-1)) % options.length;
      options[next].focus();
    });
    ui.modelSearch.addEventListener('input', renderModels);
    ui.modelRefresh.addEventListener('click', () => refreshModelOptions(true));
    window.addEventListener('resize', positionModel);
    updateAgentPreferences({});
  }
  return {mountAgentPreferences, updateAgentPreferences, openModelPicker, refreshModelOptions};
}
