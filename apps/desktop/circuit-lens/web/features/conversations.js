import {makeElement} from '../core/dom.js';
import {icon, action} from '../core/chat-dom.js';

export const modelDependencies = ['project', 'agent'];
export const dependencies = ['renderAgentHistory', 'clearAgentTimeline', 'openDraftProject', 'restoreDraftFocus',
  'draftReceipt', 'updateComposerState', 'switchReviewTab', 'openReviewPanel'];

export function createController({models:{project, agent}, ui, ports}) {
  let state = null, key = null, pending = null, busy = false, archived = false, editing = null, epoch = 0;
  const api = window.vibeDesktop?.agent?.conversations;
  const folderKey = () => project.folder?.conversationKey || null;
  const opened = () => ui.conversationMenu.matches(':popover-open');
  const close = () => {if (opened()) ui.conversationMenu.hidePopover();};
  const locked = () => busy || agent.busy || agent.submitting;
  function conversationBinding() { return {id:key === folderKey() ? state?.activeId : null, busy:busy || Boolean(pending)}; }
  function position() {
    if (!opened()) return;
    const anchor = ui.conversationPicker.getBoundingClientRect(), panel = ui.conversationMenu;
    panel.style.width = Math.min(380, ui.reviewPanel.clientWidth - 24, innerWidth - 24) + 'px';
    panel.style.left = Math.max(12, Math.min(anchor.left, innerWidth - panel.offsetWidth - 12)) + 'px';
    panel.style.top = Math.min(anchor.bottom + 10, innerHeight - panel.offsetHeight - 12) + 'px';
  }
  function renderConversationHeader() {
    const title = key === folderKey() && state ? state.conversation.title : '电路助手';
    ui.conversationTitle.textContent = title;
    ui.conversationPicker.title = title + ' · 切换对话';
    ui.conversationPicker.setAttribute('aria-label', '切换对话：' + title);
    ui.conversationPicker.disabled = !project.folder || !api;
    ui.conversationNew.disabled = !project.folder || !api || locked();
    ui.conversationNew.title = locked() ? '先停止当前回答再新建对话' : '新对话（Ctrl / ⌘ Shift O）';
    ui.conversationBusy.hidden = !locked();
    ui.conversationBusy.textContent = busy ? '正在切换…' : '先停止当前回答，再切换对话';
    ui.conversationList.querySelectorAll('button').forEach(button => {
      button.disabled = locked() || (archived && button.classList.contains('conversation-open'));
    });
  }
  function receiveConversationState(next, {openDraft = true} = {}) {
    if (!next || next.workspaceKey !== folderKey()) return;
    const changed = next.activate || key !== next.workspaceKey || state?.activeId !== next.activeId;
    state = next; key = next.workspaceKey;
    renderConversationHeader(); if (opened()) renderList();
    if (changed) {
      ports.clearAgentTimeline(); ports.renderAgentHistory(next.conversation.messages || []);
      if (openDraft && !busy) void ports.openDraftProject().then(ports.restoreDraftFocus);
    }
  }
  async function ensureConversations() {
    const scope = folderKey();
    if (!scope || !api) {
      if (key) {key = null; state = null; ++epoch; pending = null; close();}
      renderConversationHeader(); return;
    }
    if (key === scope && state) return;
    if (pending?.scope === scope) return pending.promise;
    const token = ++epoch;
    const promise = api({action:'list', folderId:project.folder.id}).then(next => {
      if (token !== epoch || scope !== folderKey()) return;
      ui.conversationError.hidden = true;
      receiveConversationState(next, {openDraft:false});
    }).catch(error => {
      if (token === epoch) showError(error);
    }).finally(() => {if (pending?.token === token) pending = null; renderConversationHeader();});
    pending = {scope, token, promise}; return promise;
  }
  function showError(error) {
    ui.conversationError.textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
    ui.conversationError.hidden = false;
  }
  async function manage(command, values = {}) {
    if (locked() || !project.folder) return;
    await ensureConversations(); if (!state || locked()) return;
    const scope = folderKey(); busy = true; ui.conversationError.hidden = true;
    renderConversationHeader(); renderList(); ports.updateComposerState();
    try {
      const next = await api({action:command, folderId:project.folder.id, activeId:state.activeId, ...values});
      if (scope !== folderKey()) return;
      receiveConversationState(next); editing = null;
      if (command === 'new' || command === 'select') {
        close(); ports.switchReviewTab('agent'); ports.openReviewPanel();
      }
    } catch (error) {
      if (scope === folderKey()) {showError(error); if (!opened()) ui.conversationMenu.showPopover(); position();}
    } finally {
      busy = false; renderConversationHeader(); renderList();
      const focus = await ports.openDraftProject(); ports.restoreDraftFocus(focus); ports.updateComposerState();
      if (!opened() && scope === folderKey()) ui.questionInput.focus();
    }
  }
  function newConversation() {
    const draft = ports.draftReceipt()?.snapshot.draft;
    return manage('new', {reuseEmpty:!draft?.text && !draft?.materials.length && !draft?.moments.length, draftTitle:draft?.text?.slice(0, 60)});
  }
  function renderList() {
    ui.conversationFolder.textContent = project.folder?.name || '当前文件夹';
    ui.conversationArchive.textContent = archived ? '返回对话' : '已归档';
    ui.conversationArchive.setAttribute('aria-pressed', String(archived));
    ui.conversationList.replaceChildren();
    const query = ui.conversationSearch.value.trim().toLocaleLowerCase();
    const records = (state?.conversations || []).filter(c => c.archived === archived &&
      (!query || (c.title + ' ' + c.preview).toLocaleLowerCase().includes(query)));
    if (!records.length) ui.conversationList.append(makeElement('p', 'conversation-list-empty', query ? '没有找到匹配的对话' : archived ? '没有已归档的对话' : '还没有对话'));
    for (const record of records) {
      const row = makeElement('div', 'conversation-row'); row.dataset.conversationId = record.id;
      row.classList.toggle('is-current', record.id === state.activeId);
      if (editing === record.id) {
        const form = makeElement('form', 'conversation-rename'), input = makeElement('input');
        input.value = record.title; input.maxLength = 100; input.required = true; input.setAttribute('aria-label', '对话名称');
        const save = action('保存名称', 'Check', () => form.requestSubmit()); save.disabled = locked();
        const cancel = action('取消重命名', 'X', () => {editing = null; renderList();});
        form.append(input, save, cancel);
        form.addEventListener('submit', e => {e.preventDefault(); void manage('rename', {id:record.id, title:input.value});});
        input.addEventListener('keydown', e => {if (e.key === 'Escape') {e.preventDefault();e.stopPropagation();editing = null;renderList();}});
        row.append(form); ui.conversationList.append(row); continue;
      }
      const open = makeElement('button', 'conversation-open'); open.type = 'button';
      open.disabled = locked() || archived; open.setAttribute('aria-current', record.id === state.activeId ? 'true' : 'false');
      open.title = record.title; open.setAttribute('aria-label', '打开对话：' + record.title);
      const title = makeElement('strong', '', record.title);
      const time = makeElement('time', '', new Intl.DateTimeFormat('zh-CN', {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'}).format(new Date(record.updatedAt)));
      time.dateTime = record.updatedAt; open.append(title, time);
      open.addEventListener('click', () => {if (record.id === state.activeId) {close();ui.questionInput.focus();} else void manage('select', {id:record.id});});
      const actions = makeElement('div', 'conversation-row-actions');
      if (!archived) actions.append(action('重命名对话：' + record.title, 'Pencil', () => {
        editing = record.id; renderList(); const input = ui.conversationList.querySelector('input'); input?.focus(); input?.select();
      }));
      actions.append(action((archived ? '恢复对话：' : '归档对话：') + record.title, archived ? 'ArchiveRestore' : 'Archive',
        () => manage(archived ? 'restore' : 'archive', {id:record.id})));
      actions.querySelectorAll('button').forEach(button => button.disabled = locked());
      row.append(open, actions); ui.conversationList.append(row);
    }
    position();
  }
  function mountConversations() {
    ui.conversationPicker.append(icon('ChevronDown'));
    ui.conversationNew.replaceChildren(icon('SquarePen'));
    ui.conversationPicker.addEventListener('click', async () => {
      if (opened()) {close();return;}
      await ensureConversations(); archived = false; editing = null; ui.conversationSearch.value = '';
      renderList(); ui.conversationMenu.showPopover(); position(); ui.conversationSearch.focus();
    });
    ui.conversationNew.addEventListener('click', newConversation);
    ui.conversationSearch.addEventListener('input', () => {editing = null;renderList();});
    ui.conversationArchive.addEventListener('click', () => {archived = !archived;editing = null;renderList();ui.conversationSearch.focus();});
    ui.conversationMenu.addEventListener('toggle', () => {
      ui.conversationPicker.setAttribute('aria-expanded', String(opened()));
    });
    ui.conversationMenu.addEventListener('keydown', event => {
      if (event.key === 'Escape') {event.preventDefault();close();ui.conversationPicker.focus();return;}
      if (editing || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const buttons = [...ui.conversationList.querySelectorAll('.conversation-open:not(:disabled)')];
      if (!buttons.length) return;
      event.preventDefault(); const index = buttons.indexOf(document.activeElement);
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
    });
    document.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'o' && !event.altKey && !event.isComposing && !document.querySelector('dialog[open]')) {
        event.preventDefault(); if (!event.repeat) void newConversation();
      }
    });
    window.addEventListener('resize', position); new ResizeObserver(position).observe(ui.reviewPanel);
    renderConversationHeader();
  }
  return {mountConversations, ensureConversations, conversationBinding, receiveConversationState, renderConversationHeader};
}
