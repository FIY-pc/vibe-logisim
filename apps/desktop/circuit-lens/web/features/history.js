import {changeTitle} from '../core/change-title.js';
import { makeElement } from '../core/dom.js';

export const modelDependencies = ["project"];

export const dependencies = ["openComparison","loadCandidates"];

export function createController({models, ui, client, ports}) {
  const {project: projectState} = models;
function showChangesPage(history) {
    ui.pendingChanges.hidden = history;
    ui.projectHistory.hidden = !history;
    for (const [button, active] of [[ui.pendingChangesButton, !history], [ui.projectHistoryButton, history]]) {
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    if (history) renderProjectHistory(); else ports.loadCandidates();
  }

function renderProjectHistory() {
    const project = projectState.session?.workspace;
    const signature = JSON.stringify([project?.id, project?.currentRevisionId, project?.savedRevisionId, project?.history]);
    if (ui.projectHistory.dataset.signature === signature) return;
    ui.projectHistory.dataset.signature = signature;
    ui.projectHistory.replaceChildren();
    for (const [index, entry] of (project?.history || []).entries()) {
      const row = makeElement("button", "history-entry");
      const line = makeElement("span", "history-entry-title", changeTitle(entry));
      if (index === 0) line.append(makeElement("span", "history-badge", "当前"));
      if (entry.revisionId === project.savedRevisionId) line.append(makeElement("span", "history-badge saved", "已保存"));
      const time = makeElement("time", "", new Date(entry.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }));
      time.dateTime = entry.at;
      row.append(line, time);
      row.addEventListener("click", () => openHistory(entry));
      ui.projectHistory.append(row);
    }
  }

function openHistory(entry){return ports.openComparison('history',entry.id);}
function mountHistoryControls(){
  ui.pendingChangesButton.addEventListener('click',()=>showChangesPage(false));
  ui.projectHistoryButton.addEventListener('click',()=>showChangesPage(true));
}
return Object.freeze({showChangesPage,renderProjectHistory,openHistory,mountHistoryControls});
}
