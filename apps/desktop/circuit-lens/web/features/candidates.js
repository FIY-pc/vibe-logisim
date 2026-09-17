import { makeElement } from '../core/dom.js';
import { createRequestScope } from '../core/request-scope.js';

export const modelDependencies = ["project", "candidates"];

export const dependencies = ["openComparison","panelEmpty","showToast"];

export function createController({models, ui, client, ports}) {
  const {project: projectState, candidates: candidatesState} = models;
  const request = client.request;
  const listRequests = createRequestScope(projectState);
async function loadCandidates() {
    const isCurrent = listRequests.begin();
    const revision = projectState.revision;
    const projectId = projectState.session?.workspace?.id;
    if (!revision) return;
    try {
      const response = await request("/api/candidates");
      const recoveries = await window.vibeDesktop?.agent?.getRecoveries?.() || [];
      if (!isCurrent()) return;
      candidatesState.candidates = response.candidates || [];
      const draft = recoveries.find(item => item.projectId === projectId && item.revisionId === revision &&
        item.draftChanged && !item.draftMissing &&
        !(item.draftDigest === item.submittedDigest && candidatesState.candidates.some(candidate => candidate.id === item.candidateId)));
      ui.candidateList.replaceChildren();
      ui.proposalCount.textContent = String(candidatesState.candidates.length + (draft ? 1 : 0));
      ui.proposalCount.hidden = ui.proposalCount.textContent === "0";
      if (!candidatesState.candidates.length && !draft) ui.candidateList.append(ports.panelEmpty("没有待应用改动"));
      if (draft) {
        const view = makeElement("button", "quiet-button", "查看暂存草稿");
        view.addEventListener("click", async () => {
          view.disabled = true;
          try {
            const candidate = await window.vibeDesktop.agent.reviewRecovery({projectId, revisionId:revision});
            if (projectState.revision !== revision || projectState.session?.workspace?.id !== projectId) return;
            await openCandidate(candidate);
            await loadCandidates();
          } catch (error) { ports.showToast(error.message); }
          finally { view.disabled = false; }
        });
        ui.candidateList.append(view);
      }
      for (const candidate of candidatesState.candidates) {
        const card = makeElement("article", "candidate-card");
        card.append(makeElement("h3", "", candidate.title));
        candidate.changes.forEach(change => card.append(makeElement("p", "", change.circuit)));
        const passed = candidate.checks.reduce((n, r) => n + r.passed, 0), failed = candidate.checks.reduce((n, r) => n + r.failed, 0);
        const wiring = candidate.changes.find(c => c.wiringProof);
        const connectivitySummary = wiring ? `${wiring.connections.length} 条连接已核对` : null;
        const behaviorSummary = failed ? `${failed} 组输入不符预期` : passed ? `${passed} 组输入输出符合预期` : null;
        const summary = [connectivitySummary, behaviorSummary].filter(Boolean).join(" · ") || (candidate.interfacePreserved === true ? "接口已保留 · 尚未检查功能" : "已原生加载 · 尚未检查功能");
        card.append(makeElement("p", `check-result${failed ? " failed" : ""}`, summary));
        if (wiring) {
          const verified = (candidate.executionReviews || []).find(r => r.passed && r.instructions > 100);
          card.append(makeElement("p", "", verified ? `${verified.instructions} 条指令与参考执行一致 · 终值 0x${verified.display.toString(16)}` : candidate.traces?.length ? "含原生时钟记录，点开查看执行数据" : "尚未观察时钟执行"));
        }
        const view = makeElement("button", "", "查看改动"); view.addEventListener("click", () => openCandidate(candidate)); card.append(view);
        ui.candidateList.append(card);
      }
    } catch (error) {
      if (!isCurrent()) return;
      ui.candidateList.replaceChildren(ports.panelEmpty(`无法读取候选：${error.message}`));
    }
  }

function openCandidate(candidate){return ports.openComparison('candidate',candidate.id);}
function candidateCount(){return candidatesState.candidates.length;}
  return Object.freeze({loadCandidates,openCandidate,candidateCount});
}
