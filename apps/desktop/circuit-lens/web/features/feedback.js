import {makeElement} from '../core/dom.js';
import {icon} from '../core/chat-dom.js';
import {createFileMenu} from './file-menu.js';

// Low-frequency app actions live one level down, in the header "…" menu:
// feedback, the log folder, release checks and the version. Diagnostics are
// built and redacted in the main process; this module previews them and
// passes on what the user chose. A new release shows as one neutral banner.
export const modelDependencies = [];
export const dependencies = ['showToast','openShortcutSettings','requestSave','saveState','shortcutLabel'];

const RELEASES_PAGE = 'https://github.com/FIY-pc/vibe-logisim/releases';
const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function createController({ui, ports}) {
  const desktop = window.vibeDesktop;
  let menu = null, version = '', update = null, closedFor = null, preview = null, previewToken = 0, busy = false;

  // ---------------------------------------------------------------- menu
  async function openAppMenu() {
    const shortcuts={label:'快捷键…',icon:'Keyboard',shortcut:/Mac/.test(navigator.platform)?'⌘+,':'Ctrl+,',run:ports.openShortcutSettings};
    const save={id:'saveMenuAction',label:'保存',icon:'Save',shortcut:ports.shortcutLabel('save')==='未设置'?'':ports.shortcutLabel('save'),disabled:!ports.saveState().canSave,run:ports.requestSave};
    if(!desktop?.diagnostics||!desktop?.updates){menu.open([save,null,shortcuts],ui.appMenuButton);return;}
    update = await desktop.updates.status().catch(() => update);
    const forced = Boolean(update?.forcedOff), automatic = Boolean(update?.enabled) && !forced;
    menu.open([
      save,
      null,
      shortcuts,
      null,
      {label: '反馈问题…', icon: 'MessageSquare', run: openFeedback},
      {label: '打开日志文件夹', icon: 'FolderOpen', run: () => desktop.diagnostics.openLogs()},
      null,
      // An unchecked item keeps an empty icon slot so the labels stay aligned.
      {label: '自动检查更新', checked: automatic, icon: 'None', disabled: forced, run: () => setAutomatic(!automatic)},
      {label: '立即检查更新', icon: 'RefreshCw', disabled: forced, run: checkNow},
      null,
      {label: `关于 Vibe Logisim ${version}`.trim(), icon: 'ExternalLink', run: () => desktop.openWebLink(RELEASES_PAGE)},
    ], ui.appMenuButton);
  }

  async function setAutomatic(enabled) {
    update = await desktop.updates.setPreference(enabled);
    ports.showToast(enabled ? '已开启自动检查更新' : '已关闭自动检查更新，启动时不再访问 GitHub');
  }

  async function checkNow() {
    ports.showToast('正在检查更新…');
    update = await desktop.updates.checkNow();
    if (update.error) return ports.showToast(`检查更新失败：${update.error}`);
    if (!update.newer) return ports.showToast(`已是最新版本（${update.current}）`);
    // Asked for explicitly: show it even if this version was ignored before.
    closedFor = null;
    renderBanner(update, {force: true});
  }

  // -------------------------------------------------------------- banner
  function renderBanner(status, {force = false} = {}) {
    const show = Boolean(status?.newer && (status.available || force) && closedFor !== status.latest);
    ui.updateBanner.hidden = !show;
    if (show) ui.updateText.textContent = `新版本 v${status.latest} 可用（当前 ${status.current}）`;
  }

  // ------------------------------------------------------------ feedback
  function setBusy(value) {
    busy = value;
    for (const button of [ui.feedbackSave, ui.feedbackCopy, ui.feedbackOpenIssue]) button.disabled = value || !preview;
    ui.feedbackIncludeCircuit.disabled = value || !preview?.circuitAvailable;
  }

  function showError(error) {
    ui.feedbackError.textContent = message(error);
    ui.feedbackError.hidden = false;
  }

  async function refreshPreview() {
    const token = ++previewToken;
    preview = null; setBusy(true); ui.feedbackError.hidden = true;
    ui.feedbackSummary.textContent = '正在生成预览…'; ui.feedbackEntries.replaceChildren();
    try {
      const result = await desktop.diagnostics.preview({includeCircuit: ui.feedbackIncludeCircuit.checked});
      if (token !== previewToken) return;
      preview = result;
      ui.feedbackSummary.textContent = result.summary;
      ui.feedbackEntries.replaceChildren(...result.entries.map(entry => makeElement('li', '', `${entry.name} · ${size(entry.bytes)}`)));
      ui.feedbackIncludeCircuit.title = result.circuitAvailable ? '' : '当前没有打开的电路文件';
    } catch (error) {
      if (token === previewToken) { ui.feedbackSummary.textContent = ''; showError(error); }
    } finally {
      if (token === previewToken) setBusy(false);
    }
  }

  async function openFeedback() {
    if (document.querySelector('dialog[open]')) return;
    ui.feedbackIncludeCircuit.checked = false;
    ui.feedbackDialog.showModal();
    await refreshPreview();
  }

  async function saveBundle() {
    if (busy) return;
    setBusy(true); ui.feedbackError.hidden = true;
    try {
      const result = await desktop.diagnostics.export({includeCircuit: ui.feedbackIncludeCircuit.checked});
      if (!result.canceled) ports.showToast('诊断包已保存');
    } catch (error) { showError(error); }
    finally { setBusy(false); }
  }

  async function copySummary({quiet = false} = {}) {
    await desktop.copyText(preview.summary);
    if (!quiet) ports.showToast('摘要已复制');
  }

  async function openIssuePage() {
    try {
      // The summary is too long for the URL; it rides on the clipboard.
      await copySummary({quiet: true});
      await desktop.openWebLink(preview.issueUrl);
      ports.showToast('摘要已复制：在反馈页的「诊断摘要」一栏粘贴，再把诊断包拖进附件栏');
    } catch (error) { showError(error); }
  }

  // ---------------------------------------------------------------- mount
  function mountFeedback() {
    menu = createFileMenu(ui.appMenu, error => ports.showToast(message(error)));
    ui.appMenuButton.replaceChildren(icon('Ellipsis'));
    ui.appMenuButton.addEventListener('click', () => { void openAppMenu(); });
    if (!desktop?.diagnostics || !desktop?.updates) return;
    ui.feedbackClose.replaceChildren(icon('X'));
    ui.feedbackClose.addEventListener('click', () => ui.feedbackDialog.close());
    ui.feedbackDialog.addEventListener('close', () => { previewToken++; preview = null; });
    ui.feedbackIncludeCircuit.addEventListener('change', () => { void refreshPreview(); });
    ui.feedbackSave.addEventListener('click', () => { void saveBundle(); });
    ui.feedbackCopy.addEventListener('click', () => { copySummary().catch(showError); });
    ui.feedbackOpenIssue.addEventListener('click', () => { void openIssuePage(); });
    ui.agentReportIssue.addEventListener('click', () => { void openFeedback(); });
    ui.updateClose.replaceChildren(icon('X'));
    ui.updateOpen.addEventListener('click', () => desktop.openWebLink(update?.url || RELEASES_PAGE).catch(error => ports.showToast(message(error))));
    ui.updateDismiss.addEventListener('click', async () => {
      try { update = await desktop.updates.dismiss(update.latest); ui.updateBanner.hidden = true; }
      catch (error) { ports.showToast(message(error)); }
    });
    ui.updateClose.addEventListener('click', () => { closedFor = update?.latest || null; ui.updateBanner.hidden = true; });
    desktop.updates.onAvailable(status => { update = status; renderBanner(status); });
    desktop.getAppInfo().then(info => { version = info.version || ''; }).catch(() => {});
    desktop.updates.status().then(status => { update = status; renderBanner(status); }).catch(() => {});
  }

  return Object.freeze({mountFeedback, openFeedback});
}
