import {makeElement} from '../core/dom.js';
import {icon} from '../core/chat-dom.js';

export const modelDependencies = ['project', 'agent'];
export const dependencies = ['askAgent', 'appendDraftText', 'draftReady', 'draftReceipt', 'hasSelection', 'openDesktopFile', 'showToast'];

// Build prompts adapt to what is open: an empty circuit is built in place
// (that is what a student who just clicked 新建电路 expects); otherwise a new
// file is created so existing work stays untouched. Structured construction
// (wire_candidate) avoids the hand-written-XML failure modes seen in real
// runs: diagonal wires and accidental shorts at crossings.
const HOW = '优先使用 wire_candidate 等结构化电路工具放置元件和连线，然后用 simulate_circuit 核对真值表；用清晰的连线和布局表达电路。';
const buildAdder = {
  id: 'build', label: '构建一个全加器', icon: 'CircuitBoard',
  prompt: emptyOpen => (emptyOpen
    ? '在当前打开的这个空电路里构建一个全加器，输入为 A、B、Cin，输出为 Sum、Cout。'
    : '帮我在工作区中新建一份全加器电路，输入为 A、B、Cin，输出为 Sum、Cout。保留已有文件。') + HOW + '最后简要说明原理和如何操作它。',
};
const basics = {
  id: 'explain', label: '认识与门、或门和非门', icon: 'BookOpen',
  prompt: '我是逻辑电路新手。用简单的输入输出例子，讲解与门、或门和非门分别做什么，以及怎样在画布上操作和观察它们。',
};
const counter = {
  id: 'check', label: '构建一个计数器', icon: 'Timer',
  prompt: emptyOpen => (emptyOpen
    ? '在当前打开的这个空电路里构建一个四位二进制计数器，带时钟和复位输入，能直观看到计数变化。'
    : '帮我在工作区中新建一份四位二进制计数器电路，带时钟和复位输入，能直观看到计数变化。保留已有文件。') + HOW + '最后简要说明怎么启动、单步和复位。',
};

export function createController({models: {project, agent}, ui, ports}) {
  const buttons = new Map();
  let starting = false;

  function actions() {
    const readable = project.circuit && !project.sourceChanged &&
      (project.circuit.components.length || project.circuit.wires.length);
    const emptyOpen = Boolean(project.circuit && !project.sourceChanged && !readable);
    const resolve = starter => typeof starter.prompt === 'function' ? {...starter, prompt: starter.prompt(emptyOpen)} : starter;
    if (!readable) return [buildAdder, basics, counter].map(resolve);
    const target = ports.hasSelection() ? '选中的部分' : '当前电路';
    return [resolve(buildAdder), {
      id: 'explain', label: `讲解一下${target}`, icon: 'BookOpen',
      prompt: `请结合实际电路讲解${target}：它要完成什么功能，输入和输出是什么，信号怎样流动，各部分为什么这样连接。用初学者能理解的方式说明，先不要修改文件。`,
    }, {
      id: 'check', label: ports.hasSelection() ? '检查选中部分的问题' : '检查电路中的问题', icon: 'ScanSearch',
      prompt: `帮我检查${target}中可能的问题，结合实际连线、元件属性和可用的运行反馈，指出具体位置和原因。不确定的地方请说明，先不要修改文件。`,
    }];
  }

  function hasDraft() {
    const draft = ports.draftReceipt()?.snapshot.draft;
    return Boolean(ui.questionInput.value || draft?.materials.length || draft?.moments.length);
  }

  function canStart() {
    return agent.enabled && agent.status === 'ready' && !agent.busy && !agent.submitting &&
      !project.projectBusy && (!project.session || ports.draftReady());
  }

  function renderConversationStarters() {
    ui.conversationStarters.hidden = !agent.enabled || hasDraft();
    for (const action of actions()) {
      const button = buttons.get(action.id);
      if (!button) continue;
      button.querySelector('span').textContent = action.label;
      if (button.dataset.icon !== action.icon) {
        button.querySelector('svg').replaceWith(icon(action.icon));
        button.dataset.icon = action.icon;
      }
      button.disabled = starting || !canStart();
      button.title = agent.status !== 'ready' ? '连接 AI 后开始' : project.folder || project.session
        ? '立即发送' : '选择工作文件夹后开始';
    }
  }

  async function start(id) {
    if (starting || !canStart() || hasDraft()) return;
    const action = actions().find(item => item.id === id);
    if (!action) return;
    starting = true;
    renderConversationStarters();
    try {
      if (!project.session && !await ports.openDesktopFile()) return;
      // Opening an existing folder may restore an unfinished question. Keep it
      // intact instead of replacing it or sending it as part of a suggestion.
      if (!ports.draftReady() || hasDraft()) { ui.questionInput.focus(); return; }
      ports.appendDraftText(action.prompt);
      // Use the ordinary send path for context, draft receipts and failure
      // recovery. If the connection was lost, the prompt remains editable.
      await ports.askAgent();
    } catch (error) {
      ports.showToast(`没有开始：${error.message}`);
    } finally {
      starting = false;
      renderConversationStarters();
    }
  }

  function mountConversationStarters() {
    for (const action of actions()) {
      const button = makeElement('button', 'conversation-starter');
      button.type = 'button'; button.dataset.starter = action.id; button.dataset.icon = action.icon;
      button.append(icon(action.icon), makeElement('span', '', action.label), icon('ArrowUpRight'));
      button.addEventListener('click', () => start(action.id));
      buttons.set(action.id, button); ui.conversationStarters.append(button);
    }
    renderConversationStarters();
  }

  return {mountConversationStarters, renderConversationStarters};
}
