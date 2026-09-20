import { firstDefined, responseRevision } from '../core/values.js';
import { makeElement } from '../core/dom.js';
import {ConversationView} from '../core/conversation-view.js';
import {icon} from '../core/chat-dom.js';

export const modelDependencies = ["project", "review", "agent"];

export const dependencies = ["forkConversation","conversationBinding","receiveConversationState","renderConversationHeader","renderConversationStarters","draftReady","draftReceipt","acknowledgeDraft","followConversationReference","appendMaterialReferences","materialAttachments","updateMaterialState","followCircuitReference","momentAttachments","appendMomentReferences","updateAgentConnection","reportAgentError","selectionSnapshot","selectionStatus","invalidateSimulation","activeObservation","bootstrap","clearSelection","focusHarnessTargets","hasSelection","intentSnapshot","loadCandidates","normalizeReview","openCandidate","openReviewPanel","postSelection","queryIntent","querySelection","queryToReview","renderReview","resizeQuestion","showToast","switchReviewTab"];

export function createController({models, ui, client, ports}) {
  let workspaceEpoch = 0, editingMessageId = null;
  const {project: projectState, review: reviewState, agent: agentState} = models;
  const conversation=new ConversationView(ui,{followReference:ports.followConversationReference,appendMoments:ports.appendMomentReferences,appendMaterials:ports.appendMaterialReferences,
    referenceBinding:()=>({folderId:projectState.folder?.id,conversationId:ports.conversationBinding().id,pathVersion:(projectState.folder?.moves||[]).length}),
    notify:ports.showToast,edit:beginMessageEdit,submitEdit:submitMessageEdit,cancelEdit:cancelMessageEdit,fork:ports.forkConversation});
  const appendAgentSystem=(text,kind)=>conversation.system(text,kind);
  const scrollAgentTimeline=()=>conversation.scroll();
  const clearAgentTimeline=()=>{editingMessageId=null;conversation.clear();};
  const renderAgentHistory=messages=>{editingMessageId=null;conversation.history(messages);};
function clearMessageEdit() {
    const id=editingMessageId;
    editingMessageId=null;
    conversation.closeEditor(id);
    updateComposerState();
  }
function cancelMessageEdit({id}) {
    if(editingMessageId!=null&&String(editingMessageId)===String(id))clearMessageEdit();
  }
function beginMessageEdit(message) {
    if (!message || agentState.busy || agentState.submitting) return;
    if (editingMessageId === message.id) {conversation.openEditor(message.id);return;}
    if(editingMessageId!=null)clearMessageEdit();
    editingMessageId = message.id;
    conversation.openEditor(message.id);
    updateComposerState();
  }
function submitMessageEdit({id,text,context}) {
    if(editingMessageId==null||String(editingMessageId)!==String(id))return Promise.resolve(false);
    return askAgent({questionOverride:text,editMessageIdOverride:id,inlineEdit:true,editContext:context});
  }
function canSteerCurrentTurn() {
    return agentState.busy && agentState.canSteer && Boolean(agentState.turnId);
  }
function updateComposerState() {
    conversation.setBusy(agentState.busy || agentState.submitting || ports.conversationBinding().busy);
    ports.updateMaterialState();
    ports.renderConversationStarters();
    if (!agentState.enabled) {
      ui.copyReferenceButton.hidden = false;
      ui.composerOptions.hidden = false;
      ui.composerPreferences.hidden = true;
      ui.interruptButton.hidden = true;
      ui.askButton.hidden = false;
      ui.askButton.textContent = "提问";
      return;
    }
    const busy = agentState.busy || agentState.submitting;
    const canSteer = canSteerCurrentTurn();
    const hasQuestion = Boolean(ui.questionInput.value.trim());
    const ready = agentState.status === "ready";
    ui.copyReferenceButton.hidden = true;
    ui.interruptButton.hidden = !busy;
    ui.askButton.hidden = busy && !(canSteer && hasQuestion);
    ui.interruptButton.classList.toggle("is-compact", busy && !ui.askButton.hidden);
    ui.interruptButton.disabled = agentState.submitting && !agentState.busy;
    ui.questionInput.disabled = !projectState.session || !ports.draftReady();
    ui.questionInput.placeholder = busy ? "继续写下你的想法…" : "一起构思、修改，或问一个问题…";
    ui.askButton.replaceChildren(icon("ArrowUp"));
    ui.askButton.disabled = agentState.submitting || (busy && !canSteer) || projectState.projectBusy || (!ready && !canSteer) || !ports.draftReady() || (!projectState.folder && (!projectState.session || !projectState.circuit)) || (!projectState.folder && projectState.sourceChanged) || !hasQuestion;
    ui.askButton.setAttribute("aria-label", canSteer ? "追加到当前任务" : "发送问题");
    if (canSteer) {
      ui.askButton.title = "追加到当前任务";
    } else if (projectState.sourceChanged) {
      ui.askButton.title = projectState.folder ? "向 AI 讨论或修复当前文件，画布仍显示此前可读版本" : "先重新载入并建立当前版本的上下文";
    } else if (!ready) {
      ui.askButton.title = agentState.status === "auth-required"
        ? "打开 AI 设置查看连接与登录"
        : "正在等待本机 Codex";
    } else if (!hasQuestion) {
      ui.askButton.title = "输入一个关于当前电路的问题";
    } else {
      ui.askButton.title = ports.hasSelection()
        ? "发送问题和当前选区"
        : "发送问题，讨论当前电路";
    }
  }

async function ensureAgentSelection() {
    const current = ports.selectionStatus();
    if (
      current.selection?.id &&
      current.selectionCommittedEpoch === current.selectionEpoch &&
      responseRevision(current.selection) === projectState.revision &&
      current.selection.circuit === projectState.circuitName
    ) return { selection: current.selection, snapshot: ports.intentSnapshot(current.selection) };
    // A conversation about the current circuit does not imply a spatial
    // selection. Materializing the whole canvas here turns an ordinary ask
    // into a heavyweight native observer request, and makes large circuits
    // appear frozen before Codex has even received the question. Selection is
    // an optional focus supplied by the user; without one, let the agent use
    // the workspace and circuit tools to inspect what it needs.
    if (!ports.hasSelection()) return { selection: { id: null }, snapshot: null };
    const expectedEpoch = ports.selectionStatus().selectionEpoch;
    const snapshot = ports.selectionSnapshot();
    const selection = await ports.postSelection(snapshot, expectedEpoch);
    const accepted = ports.selectionStatus();
    if (
      expectedEpoch !== accepted.selectionEpoch ||
      !selection?.id ||
      accepted.selectionCommittedEpoch !== expectedEpoch ||
      responseRevision(selection) !== projectState.revision
    ) {
      if (expectedEpoch !== accepted.selectionEpoch) {
        throw new Error("选区在发送前发生了变化，请确认当前选区后重新发送。");
      }
      throw new Error("选区尚未被当前 Circuit Lens revision 接受。");
    }
    return { selection, snapshot: ports.intentSnapshot(selection, snapshot) };
  }

async function askAgent({questionOverride=null,editMessageIdOverride=null,inlineEdit=false,editContext=null}={}) {
    const steering = !inlineEdit && canSteerCurrentTurn();
    if (projectState.projectBusy || (agentState.busy && !steering) || agentState.submitting || (agentState.enabled && agentState.status !== "ready" && !steering)) return;
    if (!agentState.enabled) {
      await ports.querySelection();
      return;
    }
    const question = (typeof questionOverride === "string" ? questionOverride : ui.questionInput.value).trim();
    if (!question || (!inlineEdit && !ports.draftReady()) || (!projectState.folder && (!projectState.session || !projectState.circuit)) || (!projectState.folder && projectState.sourceChanged)) return false;
    // Capture before selection preparation: a completed turn must reject this
    // submission rather than silently turn the follow-up into a new turn.
    const expectedTurnId = steering ? agentState.turnId : null;
    const receipt = inlineEdit ? null : ports.draftReceipt();
    const editMessageId = inlineEdit ? editMessageIdOverride : null;
    const submittedRevision = projectState.revision;
    const includeCircuit=Boolean(projectState.circuit&&!projectState.sourceChanged);
    const submittedProject = projectState.session?.workspace?.id;
    const submittedEpoch = workspaceEpoch;
    const observationId = ports.activeObservation()?.id || null;
    const moments = inlineEdit ? {ids:[],refs:editContext?.moments||[]} : ports.momentAttachments();
    const materials = inlineEdit ? {refs:editContext?.materials||[]} : ports.materialAttachments();
    agentState.submitting = true;
    updateComposerState();
    ports.switchReviewTab("agent");
    ports.openReviewPanel();
    let backendSubmissionStarted = false;
    try {
      const { selection, snapshot } = includeCircuit ? await ensureAgentSelection() : {selection:{id:null},snapshot:null};
      if(submittedEpoch!==workspaceEpoch||submittedProject!==projectState.session?.workspace?.id||submittedRevision!==projectState.revision)throw new Error('工程在发送前发生了变化，问题仍保留在原工程草稿中');
      const expectedEpoch = ports.selectionStatus().selectionEpoch;
      const query = snapshot ? ports.queryIntent(snapshot) : {kind:"overview",ids:[]};
      backendSubmissionStarted = true;
      const result = await window.vibeDesktop.agent.ask({
        question,
        ...(steering ? {expectedTurnId} : {}),
        conversationId: ports.conversationBinding().id,
        folderId: projectState.folder?.id,
        revisionId: includeCircuit ? submittedRevision : null,
        circuit: includeCircuit ? projectState.circuitName : null,
        selectionId: selection.id,
        kind: query.kind,
        ids: query.ids || [],
        observationId,
        momentIds:moments.ids,
        momentRefs:moments.refs,
        materialRefs:materials.refs,
        editMessageId,
      });
      if (
        submittedEpoch === workspaceEpoch &&
        result?.evidence &&
        expectedEpoch === ports.selectionStatus().selectionEpoch &&
        ports.selectionStatus().selection?.id === selection.id &&
        responseRevision(ports.selectionStatus().selection) === projectState.revision
      ) {
        const review = result.evidence.review || ports.queryToReview(
          result.evidence.result || result.evidence,
          question,
          result.evidence.kind || query.kind,
        );
        reviewState.review = ports.normalizeReview(review, question);
        reviewState.reviewSignature = JSON.stringify(reviewState.review);
        ports.renderReview();
      }
      ports.acknowledgeDraft(receipt);
      clearMessageEdit();
      return true;
    } catch (error) {
      if (backendSubmissionStarted) clearMessageEdit();
      if (submittedEpoch === workspaceEpoch && projectState.session?.workspace?.id === submittedProject) {
        if (steering) ports.showToast(`没有追加到当前任务：${error.message}`);
        else ports.reportAgentError(`没有开始回答：${error.message}`);
      }
      return false;
    } finally {
      if(submittedEpoch===workspaceEpoch)agentState.submitting = false;
      updateComposerState();
    }
  }

async function interruptAgent() {
    if (!agentState.enabled || !agentState.busy) return;
    ui.interruptButton.disabled = true;
    ui.interruptButton.textContent = "正在停止…";
    try {
      const result = await window.vibeDesktop.agent.interrupt();
      if (!result?.interrupted) appendAgentSystem("当前没有正在运行的回答。", "warning");
    } catch (error) {
      appendAgentSystem(`停止失败：${error.message}`, "error");
    } finally {
      ui.interruptButton.disabled = false;
      ui.interruptButton.replaceChildren(icon("Square"));
    }
  }

function initializeAgent() {
    if (!agentState.enabled) {
      ui.agentTab.hidden = true;
      ui.agentPane.hidden = true;
      return;
    }
    ui.reviewPanel.classList.add("has-agent");
    ui.composerOptions.hidden = false;
    for(const [button,name] of [[ui.askButton,'ArrowUp'],[ui.interruptButton,'Square'],[ui.agentSettings,'Settings']])button.replaceChildren(icon(name));
    ui.agentEmpty.querySelector('.chat-empty-mark').append(icon('MessageSquare'));
    conversation.mount();
    ui.agentTab.hidden = false;
    agentState.unsubscribe = window.vibeDesktop.agent.onEvent(handleAgentEvent);
    window.addEventListener("beforeunload", () => agentState.unsubscribe?.(), { once: true });
    ports.switchReviewTab("agent");
    window.vibeDesktop.agent.getState().then((snapshot) => {
      applyAgentState(snapshot);
      if (Array.isArray(snapshot?.messages) && snapshot.messages.length) {
        renderAgentHistory(snapshot.messages);
      }
    }).catch((error) => {
      applyAgentState({ status: "unavailable", detail: error.message, busy: false });
    });
  }

function applyAgentState(snapshot = {}) {
    agentState.status = snapshot.status || "unavailable";
    agentState.busy = Boolean(snapshot.busy || snapshot.status === "busy");
    agentState.canSteer = Boolean(snapshot.canSteer);
    agentState.turnId = snapshot.turnId || null;
    const labels = {
      idle: "等待启动",
      starting: "正在连接本机 Codex…",
      ready: "已连接",
      busy: "正在处理",
      "auth-required": "需要登录",
      unavailable: snapshot.detail || "本机 Codex 不可用",
      stopped: "Codex 已停止",
    };
    const lightState = ["ready", "busy", "starting", "auth-required", "unavailable"].includes(agentState.status)
      ? agentState.status
      : "idle";
    ui.agentStatusLight.dataset.state = lightState;
    ui.agentTabLight.dataset.state = lightState;
    ui.agentStatusText.textContent = labels[agentState.status] || "本机 Codex 状态未知";
    ports.updateAgentConnection(snapshot);
    ports.renderConversationHeader();
    updateComposerState();
  }

function handleAgentEvent(event) {
    if (!event || typeof event !== "object") return;
    if (event.type === 'conversations-changed') {if (event.activate) clearMessageEdit(); ports.receiveConversationState(event); return;}
    if (event.type === "candidate-ready") { ports.loadCandidates(); return; }
    if (event.type === "circuit-change") {
      const card = makeElement("div", "agent-change");
      card.append(makeElement("strong", "", event.candidate.title), makeElement("span", "", event.applied ? "已应用 · 未保存" : "等待你审批"));
      const review = makeElement("button", "quiet-button", "查看图上改动");
      review.addEventListener("click", () => ports.openCandidate(event.candidate));
      card.append(review); ui.agentEmpty.hidden = true; ui.agentTimeline.append(card);
      if (event.applied) {
        ports.invalidateSimulation();
        ports.clearSelection({notifyServer:false});
        reviewState.review = null; reviewState.reviewSignature = "";
        ports.bootstrap();
      }
      else ports.loadCandidates();
      return;
    }
    if (event.type === "question") {
      const form = makeElement("form", "agent-question"), fields = [];
      for (const question of event.questions) {
        const label = makeElement("label", "", question.question);
        const input = makeElement("input"); input.required = true; input.maxLength = 4000;
        fields.push({id:question.id,input}); label.append(input); form.append(label);
        for (const option of question.options || []) {
          const button = makeElement("button", "quiet-button", option.label); button.type = "button"; button.title = option.description || "";
          button.addEventListener("click", () => {input.value = option.label;}); form.append(button);
        }
      }
      const send = makeElement("button", "primary-button", "回复并继续"); send.type = "submit"; form.append(send);
      form.addEventListener("submit", async e => {
        e.preventDefault(); send.disabled = true;
        try {await window.vibeDesktop.agent.answer(event.requestId,Object.fromEntries(fields.map(f=>[f.id,f.input.value]))); form.replaceChildren(makeElement("p","","已回复，继续处理"));}
        catch(error) {ports.showToast(error.message);send.disabled=false;}
      });
      ui.agentEmpty.hidden = true; ui.agentTimeline.append(form); scrollAgentTimeline(); return;
    }
    if (event.type === "status") {
      applyAgentState(event);
      return;
    }
    if (event.type === "history") {
      renderAgentHistory(event.messages || []);
      return;
    }
    if (event.type === "workspace-reset") {
      workspaceEpoch++;
      agentState.submitting=false;
      agentState.canSteer=false;
      agentState.turnId=null;
      clearMessageEdit();
      clearAgentTimeline();
      ports.updateAgentConnection({transmission:null});
      return;
    }
    if (event.type === "revision-changed") {
      if (agentState.busy) conversation.finish("interrupted");
      ui.agentTimeline.querySelectorAll(".is-streaming").forEach(node => { node.classList.remove("is-streaming"); node.removeAttribute("aria-busy"); });
      agentState.busy = false;
      agentState.canSteer = false;
      agentState.turnId = null;
      updateComposerState();
      return;
    }
    if (event.type === "user-message") {
      conversation.user(event.id,event.text,event.context);
      return;
    }
    if (event.type === "assistant-started") {
      conversation.assistant(event.itemId,event.text,event.phase,true);
      return;
    }
    if (event.type === "assistant-delta") {
      conversation.assistant(event.itemId,event.delta||"",event.phase,true,true);
      return;
    }
    if (event.type === "assistant-completed") {
      conversation.assistant(event.itemId,event.text,event.phase,false);
      return;
    }
    if (event.type === "reasoning-delta") {
      conversation.activity(event.itemId, event.delta || "正在分析选区证据", "running", "reasoning", null, "reasoning");
      return;
    }
    if (event.type === "activity") {
      conversation.activity(event.itemId, event.label, event.status, event.kind, event.detail, event.activityKey);
      return;
    }
    if (event.type === "harness-result") {
      const session = event.session || event.binding || {};
      const run = event.run || {};
      const observation = event.observation || {};
      const status = event.feedback?.status === "failed" ? "有异常"
        : event.feedback?.status === "passed" ? "通过" : event.feedback?.status === "observed" ? "已观察" : "未确定";
      const failure = event.feedback?.firstFailure;
      const position = failure?.tick != null ? ` · 首个异常 tick ${failure.tick}`
        : Number.isInteger(failure?.rowIndex) ? ` · 首个异常输入第 ${failure.rowIndex + 1} 组` : "";
      const scope = session.candidateId ? " · 候选电路"
        : session.revisionId && session.revisionId !== projectState.revision ? " · 历史版本" : "";
      const label = run.label || observation.label || run.kind || session.circuit || "电路";
      const output = [observation.error, observation.stderr, observation.stdout].filter(Boolean).join("\n");
      const eventStatus = event.feedback?.status === "failed" ? "failed" : event.feedback?.status === "unknown" ? "warning" : "completed";
      conversation.activity(event.itemId || run.id || session.id || `harness-${Date.now()}`, `${label} · ${status}${position}${scope}`, eventStatus, "tool", output || event.feedback?.note || null, `harness:${run.kind || session.circuit || "result"}`, event.feedback?.status || "observed");
      if (failure) {
        const actual = JSON.stringify(failure.outputs || failure.actual || {});
        const expected = JSON.stringify(failure.expected || {});
        const notice=appendAgentSystem(`${label} 的运行结果与预期不一致${position}${scope}`, "warning");
        const details=makeElement('details');details.append(makeElement('summary','','查看输入与输出'),makeElement('pre','',`输入 ${JSON.stringify(failure.inputs || {})}\n实际 ${actual}\n预期 ${expected}`));notice.append(details);
        if(session.revisionId===projectState.revision&&session.circuit===projectState.circuitName&&!session.candidateId&&event.feedback?.targets?.length){
          const locate=makeElement('button','quiet-button','定位异常');locate.addEventListener('click',()=>{if(!ports.focusHarnessTargets(event.feedback,session))ports.showToast('电路已变化，无法在当前图中定位这次运行的对象。');});notice.append(locate);
        }
      }
      return;
    }
    if (event.type === "turn-started") {
      const canSteer = event.canSteer ?? (event.turnId === agentState.turnId && agentState.canSteer);
      conversation.start();
      applyAgentState({ status: "busy", busy: true, turnId:event.turnId, canSteer, transmission:null });
      return;
    }
    if (event.type === "turn-completed") {
      ports.loadCandidates();
      agentState.busy = false;
      applyAgentState({ status: "ready", busy: false, transmission:event.status === "completed" ? null
        : {phase:event.status === "interrupted" ? "interrupted" : "failed",message:event.error || "",turnId:event.turnId} });
      conversation.finish(event.status);
      return;
    }
    if (event.type === "blocked-request") {
      const scope = firstDefined(event.scope?.command, event.scope?.reason, event.method, "未知请求");
      appendAgentSystem(`这项操作超出当前工程的执行权限：${scope}`, "warning");
      return;
    }
    if (event.type === "error") ports.reportAgentError(event.message || "Codex 返回了未知问题。");
    if (event.type === "warning") appendAgentSystem(event.message || "Codex 返回了提示。", "warning");
  }

  return Object.freeze({updateComposerState,ensureAgentSelection,askAgent,interruptAgent,initializeAgent,applyAgentState,handleAgentEvent,renderAgentHistory,clearAgentTimeline,appendAgentSystem,scrollAgentTimeline});
}
