// Menu, shortcuts and settings share commands; native session ownership stays in run.js.
import {icon} from '../core/chat-dom.js';
export const modelDependencies = ['project', 'canvas'];
export const dependencies = ['simulationStatus', 'simulationAction', 'mountSimulationRuntime', 'returnToSimulation', 'captureMoment'];

const commands = [
  {id: 'simulationStart', action: 'start'},
  {id: 'simulationPlay', action: 'toggle-clock', key: 'k'},
  {id: 'simulationTick', action: 'tick', key: 't'},
  {id: 'simulationAutomatic', action: 'toggle-propagation', key: 'e'},
  {id: 'simulationStep', action: 'step', key: 'i'},
  {id: 'simulationReset', action: 'reset', key: 'r'},
  {id: 'simulationStop', action: 'stop'},
  {id: 'momentCapture', action: 'capture', key: 'F6', unmodified: true},
];

export function createController({models: {project, canvas}, ui, ports}) {
  let queue = Promise.resolve(), frequency = 2, settingsScope = null, focusLast = false;
  const modifier = /Mac/.test(navigator.platform) ? 'Meta' : 'Control';
  const menuOpen = () => ui.simulationMenu.matches(':popover-open');
  const scope = () => ({projectId: project.session?.workspace?.id, revision: project.revision,
    circuit: project.circuitName, navigation: project.circuitRequestEpoch});
  const sameDocument = s => s.projectId === project.session?.workspace?.id && s.revision === project.revision;
  const canRun = () => Boolean(project.circuit && project.capabilityState === 'exact' && !project.projectBusy && !project.sourceChanged);
  const allowed = action => {
    const s = ports.simulationStatus();
    return canRun() || (s.exists && (action === 'stop' || (action === 'toggle-clock' && s.running)));
  };
  const closeMenu = () => { if (menuOpen()) ui.simulationMenu.hidePopover(); };

  function dispatch(action, extra = {}) {
    // A snapshot binds the displayed sample synchronously at the key/click,
    // independently of queued clock commands and their future observations.
    if (action === 'capture') return ports.captureMoment();
    const origin = scope();
    // Resolve toggles after the preceding acknowledgement, including a cold start.
    // Separate K presses are preserved; holding the key does not oscillate the clock.
    const execute = async () => {
      if (!sameDocument(origin) || !allowed(action)) return false;
      if (action === 'frequency') {
        if (ports.simulationStatus().exists && !await ports.simulationAction('configure', extra)) return false;
        if (!sameDocument(origin)) return false;
        frequency = extra.frequency; renderSimulationControls(); return true;
      }
      const wasActive = ports.simulationStatus().exists;
      if (!wasActive) {
        if (action === 'stop') return true;
        if (origin.circuit !== project.circuitName || origin.navigation !== project.circuitRequestEpoch) return false;
        if (!await ports.simulationAction('start')) return false;
        if (!sameDocument(origin)) return false;
        if (frequency !== 2 && !await ports.simulationAction('configure', {frequency})) return false;
      }
      if (!sameDocument(origin)) return false;
      const state = ports.simulationStatus();
      if (action === 'start') return true;
      if (action === 'toggle-clock') return ports.simulationAction(state.running ? 'pause' : 'play');
      // In an idle workspace Ctrl+E enables simulation; it must not immediately
      // disable the propagation that the fresh native session just enabled.
      if (action === 'toggle-propagation') return wasActive ? ports.simulationAction('configure', {automatic: !state.automatic}) : true;
      return ports.simulationAction(action, extra);
    };
    const pending = queue.then(execute, execute);
    queue = pending.catch(() => false);
    return pending;
  }

  function renderSimulationControls() {
    const s = ports.simulationStatus();
    ui.circuitCanvas.dataset.simulationBusy = String(s.busy);
    ui.pokeTool.setAttribute('aria-busy', String(s.busy));
    ui.pokeTool.title = s.busy ? '正在准备仿真，点击的输入会随后生效' : '操作输入、按钮和时钟（P）；首次点击自动启动仿真';
    const status = s.busy ? (s.busyAction === 'stop' ? '正在结束仿真…' : '正在准备仿真…') : !s.exists ? '尚未开始' :
      `${s.running ? '时钟运行' : '时钟暂停'}${s.automatic ? '' : ' · 自动传播已暂停'}`;
    ui.simulationOwner.textContent = s.circuit || project.circuitName || '尚未打开电路';
    ui.simulationStatus.textContent = status + (s.exists ? ` · ${s.ticks ?? 0} tick` : '');
    ui.simulationStart.hidden = s.exists;
    ui.simulationPlay.querySelector('span').textContent = s.running ? '暂停时钟' : '运行时钟';
    ui.simulationAutomatic.setAttribute('aria-checked', String(s.exists && s.automatic));
    for (const command of commands) if (command.action !== 'capture') ui[command.id].disabled = !allowed(command.action) || (command.action === 'stop' && !s.exists);
    ui.simulationReturn.hidden = !s.exists || s.visible;
    ui.simulationReturn.disabled = s.viewBusy;
    ui.simulationSettings.disabled = !project.circuit;
    ui.simulationReset.title = `复位 ${s.circuit || project.circuitName} 及其所有内部模块的运行状态`;
    ui.simulationRate.hidden = !s.running;
    ui.simulationRate.textContent = `当前实测 ${(s.actualFrequency || 0).toFixed(1)} tick/s`;
    ui.simulationTransport.hidden = !project.circuit || (!s.exists && !s.busy && !s.stale && canvas.mode !== 'poke');
    ui.simulationActivity.textContent = s.busy ? (s.busyAction === 'stop' ? '结束中…' : '启动中…')
      : s.stale ? '电路已改动' : !s.exists ? '未仿真' : !s.visible ? `正在仿真 ${s.circuit}` : !s.automatic ? '传播已暂停' : s.running ? '时钟运行' : '交互中';
    const elsewhere = s.exists && !s.visible;
    ui.simulationQuickRestart.hidden = !s.stale;
    ui.simulationQuickRestart.disabled = s.busy || !allowed('start');
    ui.simulationQuickReturn.hidden = !elsewhere;
    ui.simulationQuickReturn.disabled = s.viewBusy || s.busy;
    for (const button of [ui.simulationQuickPlay, ui.simulationQuickTick, ui.simulationQuickReset]) button.hidden = s.stale || elsewhere;
    ui.simulationTransport.dataset.running = String(s.running);
    ui.simulationTransport.setAttribute('aria-busy', String(s.busy));
    const playLabel = s.running ? '暂停时钟' : '运行时钟';
    if (ui.simulationQuickPlay.getAttribute('aria-label') !== playLabel || !ui.simulationQuickPlay.childElementCount) {
      ui.simulationQuickPlay.replaceChildren(icon(s.running ? 'Pause' : 'Play'));
      ui.simulationQuickPlay.setAttribute('aria-label', playLabel);
    }
    ui.simulationQuickPlay.title = `${playLabel}（${modifier === 'Meta' ? '⌘' : 'Ctrl'}+K）`;
    ui.simulationQuickPlay.disabled = !allowed('toggle-clock');
    ui.simulationQuickTick.disabled = !allowed('tick') || s.running;
    ui.simulationQuickReset.disabled = !allowed('reset') || !s.exists;
    ui.simulationQuickTick.title = s.running ? '先暂停时钟，再逐步推进' : `时钟一步（${modifier === 'Meta' ? '⌘' : 'Ctrl'}+T）`;
    ui.simulationQuickReset.title = ui.simulationReset.title;
    ui.documentKind.textContent = !project.circuit || !ui.simulationTransport.hidden ? '' : s.visible ? '' : s.exists ? '图面预览' : '未仿真';
    ui.documentKind.title = '';
    ui.simulationMenuButton.dataset.running = String(s.running);
    if (settingsScope && !sameDocument(settingsScope)) ui.simulationOptions.close();
  }

  function positionMenu() {
    if (!menuOpen()) return;
    const anchor = ui.simulationMenuButton.getBoundingClientRect(), panel = ui.simulationMenu;
    panel.style.left = Math.max(8, Math.min(anchor.left, innerWidth - panel.offsetWidth - 8)) + 'px';
    panel.style.top = Math.max(8, Math.min(anchor.bottom + 6, innerHeight - panel.offsetHeight - 8)) + 'px';
  }
  function menuItems() { return [...ui.simulationMenu.querySelectorAll('button')].filter(b => !b.hidden && !b.disabled); }
  function showSettings() {
    settingsScope = scope();
    ui.simulationFrequency.value = ports.simulationStatus().frequency ?? frequency;
    ui.simulationSettingsError.hidden = true;
    closeMenu(); ui.simulationOptions.showModal(); ui.simulationFrequency.focus();
  }

  function mountSimulationControls() {
    ui.simulationQuickRestart.addEventListener('click', () => void dispatch('start'));
    ui.simulationQuickReturn.addEventListener('click', () => void ports.returnToSimulation());
    ui.simulationQuickTick.replaceChildren(icon('StepForward'));
    ui.simulationQuickReset.replaceChildren(icon('RotateCcw'));
    for (const [button, action] of [[ui.simulationQuickPlay, 'toggle-clock'], [ui.simulationQuickTick, 'tick'], [ui.simulationQuickReset, 'reset']]) {
      button.addEventListener('click', () => void dispatch(action));
    }
    ui.simulationMenu.querySelectorAll('button').forEach(button => { button.tabIndex = -1; });
    for (const command of commands) {
      const button = ui[command.id];
      if (command.key) {
        const label = command.unmodified ? command.key : `${modifier === 'Meta' ? '⌘' : 'Ctrl'} ${command.key.toUpperCase()}`;
        const kbd = document.createElement('kbd'); kbd.textContent = label; button.append(kbd);
        button.setAttribute('aria-keyshortcuts', command.unmodified ? command.key : `${modifier}+${command.key.toUpperCase()}`);
      }
      button.addEventListener('click', () => { closeMenu(); void dispatch(command.action); });
    }
    ui.simulationMenu.addEventListener('toggle', () => {
      ui.simulationMenuButton.setAttribute('aria-expanded', String(menuOpen()));
      if (menuOpen()) { renderSimulationControls(); positionMenu(); const items = menuItems(); (focusLast ? items.at(-1) : items[0])?.focus(); focusLast = false; }
    });
    ui.simulationMenuButton.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      focusLast = event.key === 'ArrowUp';
      if (!menuOpen()) ui.simulationMenu.showPopover();
      const items = menuItems(); (event.key === 'ArrowUp' ? items.at(-1) : items[0])?.focus();
    });
    ui.simulationMenu.addEventListener('keydown', event => {
      const items = menuItems(), index = items.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
          (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closeMenu(); ui.simulationMenuButton.focus();
      } else if (event.key === 'Tab') { closeMenu(); ui.simulationMenuButton.focus(); }
    });
    ui.simulationReturn.addEventListener('click', () => { closeMenu(); void ports.returnToSimulation(); });
    ui.momentOpen.addEventListener('click', closeMenu);
    ui.simulationSettings.addEventListener('click', showSettings);
    ui.simulationSettingsClose.addEventListener('click', () => ui.simulationOptions.close());
    ui.simulationSettingsCancel.addEventListener('click', () => ui.simulationOptions.close());
    ui.simulationOptions.addEventListener('close', () => { settingsScope = null; ui.simulationMenuButton.focus(); });
    ui.simulationSettingsForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (!settingsScope || !sameDocument(settingsScope) || !ui.simulationSettingsForm.reportValidity()) return;
      const opened = settingsScope;
      ui.simulationSettingsApply.disabled = true;
      const ok = await dispatch('frequency', {frequency: Number(ui.simulationFrequency.value)});
      ui.simulationSettingsApply.disabled = false;
      if (settingsScope !== opened) return;
      if (ok) ui.simulationOptions.close();
      else { ui.simulationSettingsError.textContent = '未能应用频率，请重试。'; ui.simulationSettingsError.hidden = false; }
    });
    window.addEventListener('resize', positionMenu);
    document.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey) return;
      const command = commands.find(c => c.key?.toLowerCase() === event.key.toLowerCase() &&
        (c.unmodified ? !event.ctrlKey && !event.metaKey : modifier === 'Meta' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey));
      if (!command || (command.action !== 'capture' && event.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) ||
          document.querySelector('dialog[open]') || document.querySelector(':popover-open:not(#simulationMenu)')) return;
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) { closeMenu(); void dispatch(command.action); }
    }, true);
    ports.mountSimulationRuntime();
    renderSimulationControls();
  }
  return {mountSimulationControls, renderSimulationControls, startSimulation: () => dispatch('start')};
}
