import { asArray, firstDefined, netId, normalizeBounds, normalizePoint, responseRevision, shortRevision } from '../core/values.js';
import { makeElement, makeSvg } from '../core/dom.js';
import { API } from '../core/endpoints.js';

export const modelDependencies = ["project", "canvas", "review"];

export const dependencies = ["renderConnections","selectionSnapshot","selectionStatus","candidateCount","applyCamera","pollSessionState","showToast"];

export function createController({models, ui, client, ports}) {
  const {project: projectState, canvas: canvasState, review: reviewState} = models;
  const request = client.request;
function queryToReview(payload, question, queryKind = "") {
    const claims = [];
    const requested = asArray(firstDefined(payload?.requestedComponents, payload?.components));
    requested.forEach((component) => {
      const id = String(firstDefined(component.componentId, component.id, "component"));
      const factory = firstDefined(component.factoryName, component.factory, component.type, "组件");
      const label = firstDefined(component.selector?.label, component.label);
      const point = normalizePoint(firstDefined(component.location, component.at));
      claims.push({
        kind: "fact",
        text: `${label ? `${label} 是 ` : "选中的对象是 "}${factory}${point ? `，位于 (${point.x}, ${point.y})` : ""}。`,
        componentIds: [id],
        requiresConnectivity: false,
        evidence: id,
      });
      const ends = asArray(component.ends);
      const componentNets = new Set();
      ends.forEach((end) => asArray(firstDefined(end.relevantNetBits, end.netBits, end.nets)).forEach((bit) => {
        const idValue = firstDefined(bit.netId, bit.id, Array.isArray(bit) ? bit[1] : null);
        if (idValue) componentNets.add(String(idValue));
      }));
      if (componentNets.size) {
        claims.push({
          kind: "fact",
          text: `目标运行时把这个组件的相关端点映射到 ${componentNets.size} 个 bit-net。`,
          componentIds: [id],
          netIds: [...componentNets],
          requiresConnectivity: true,
          evidence: [...componentNets].join(", "),
        });
      }
    });

    const nets = asArray(payload?.nets);
    nets.forEach((net, index) => {
      const id = netId(net, index);
      const contacts = asArray(net.contacts);
      claims.push({
        kind: "fact",
        text: `${id} 在当前投影中有 ${firstDefined(net.contactCount, contacts.length, 0)} 个端点接触。`,
        netIds: [id],
        componentIds: contacts.map((contact) => firstDefined(contact.componentId, contact.id)).filter(Boolean).map(String),
        requiresConnectivity: true,
        evidence: id,
      });
    });

    asArray(payload?.unknowns).forEach((unknown) => {
      claims.push({
        kind: "unknown",
        text: String(firstDefined(unknown.claim, unknown.message, unknown.code, unknown)),
        requiresConnectivity: false,
        evidence: firstDefined(unknown.code, "observer unknown"),
      });
    });
    if (!claims.length) {
      claims.push({
        kind: "unknown",
        text: "当前查询没有返回足够信息来形成新的主张。请复制选区引用给 AI，或缩小选区后继续查询。",
        requiresConnectivity: false,
      });
    }
    return {
      revision: projectState.revision,
      question,
      summary: queryKind === "overview"
        ? "区域概览：大选区不会逐个展开全部组件；缩小到 4 个以内可查询逐项事实。"
        : "",
      claims,
      proposal: payload?.proposal || null,
    };
  }

async function loadReview({ quiet = false } = {}) {
    if (!projectState.session) return;
    try {
      const payload = await request(API.review);
      if (!payload || payload.empty) return;
      if (payload.selectionId && (!ports.selectionStatus().selection?.id || payload.selectionId !== ports.selectionStatus().selection.id)) return;
      if ((payload.status === "empty" || !asArray(payload.claims).length) && reviewState.review?.claims?.length) return;
      const payloadRevision = responseRevision(payload);
      if (payloadRevision && payloadRevision !== projectState.revision) {
        return; // An old review is not evidence that the current document changed.
      }
      const normalized = normalizeReview(payload);
      const signature = JSON.stringify(normalized);
      if (signature === reviewState.reviewSignature) return;
      reviewState.review = normalized;
      reviewState.reviewSignature = signature;
      renderReview();
      if (!quiet) ports.showToast("已读取这份电路的审阅证据。");
    } catch (_) {
      // Review is a collaborative sidecar; the canvas remains useful without it.
    }
  }

function startReviewPolling() {
    if (reviewState.reviewTimer) window.clearInterval(reviewState.reviewTimer);
    reviewState.reviewTimer = window.setInterval(async () => {
      if (document.hidden || !projectState.session || reviewState.polling || projectState.projectBusy) return;
      reviewState.polling = true;
      try {
        const current = await ports.pollSessionState();
        if (current) await loadReview({ quiet: true });
      } finally {
        reviewState.polling = false;
      }
    }, 4500);
  }

function normalizeReview(raw, fallbackQuestion = "") {
    const claims = [];
    const sourceClaims = asArray(firstDefined(raw?.claims, raw?.evidence?.claims));
    sourceClaims.forEach((claim, index) => {
      const kind = normalizeClaimKind(firstDefined(claim.kind, claim.type, claim.classification));
      claims.push({
        id: String(firstDefined(claim.id, `claim-${index}`)),
        kind,
        text: String(firstDefined(claim.text, claim.claim, claim.message, "未命名主张")),
        componentIds: referenceIds(claim, "component"),
        netIds: referenceIds(claim, "net"),
        targets: normalizeTargets(claim),
        evidence: firstDefined(claim.evidence, claim.witness, claim.source, claim.method),
        requiresConnectivity: claim.requiresConnectivity !== false && kind !== "unknown",
      });
      const falsifier = firstDefined(claim.falsifier, claim.howToFalsify);
      if (falsifier) {
        claims.push({
          id: `${firstDefined(claim.id, index)}-falsifier`,
          kind: "falsifier",
          text: String(falsifier),
          componentIds: referenceIds(claim, "component"),
          netIds: referenceIds(claim, "net"),
          evidence: "falsifier",
          requiresConnectivity: false,
        });
      }
    });
    asArray(raw?.facts).forEach((claim, index) => claims.push(normalizeLooseClaim(claim, "fact", `fact-${index}`)));
    asArray(raw?.inferences).forEach((claim, index) => claims.push(normalizeLooseClaim(claim, "inference", `inference-${index}`)));
    asArray(raw?.unknowns).forEach((claim, index) => claims.push(normalizeLooseClaim(claim, "unknown", `unknown-${index}`)));
    asArray(raw?.falsifiers).forEach((claim, index) => claims.push(normalizeLooseClaim(claim, "falsifier", `falsifier-${index}`)));
    return {
      revision: firstDefined(responseRevision(raw), projectState.revision),
      question: String(firstDefined(raw?.question, fallbackQuestion) || ""),
      summary: String(firstDefined(raw?.summary, raw?.evidence?.summary) || ""),
      claims,
      proposal: firstDefined(raw?.proposal, raw?.changeProposal),
    };
  }

function normalizeLooseClaim(value, kind, id) {
    if (typeof value === "string") return { id, kind, text: value, componentIds: [], netIds: [], requiresConnectivity: kind !== "unknown" && kind !== "falsifier" };
    return {
      id: String(firstDefined(value?.id, id)),
      kind,
      text: String(firstDefined(value?.text, value?.claim, value?.message, value?.code, "未命名主张")),
      componentIds: referenceIds(value, "component"),
      netIds: referenceIds(value, "net"),
      targets: normalizeTargets(value),
      evidence: firstDefined(value?.evidence, value?.witness, value?.code),
      requiresConnectivity: value?.requiresConnectivity !== false && kind !== "unknown" && kind !== "falsifier",
    };
  }

function normalizeClaimKind(kind) {
    const value = String(kind || "unknown").toLowerCase();
    if (["fact", "facts", "事实"].includes(value)) return "fact";
    if (["inference", "hypothesis", "推断", "假设"].includes(value)) return "inference";
    if (["falsifier", "counterexample", "反证", "如何推翻"].includes(value)) return "falsifier";
    return "unknown";
  }

function referenceIds(claim, kind) {
    const references = firstDefined(claim?.references, claim?.refs, {});
    const targetIds = asArray(claim?.targets)
      .filter((target) => String(target?.kind || "").toLowerCase() === kind)
      .map((target) => firstDefined(target.id, target.componentId, target.netId));
    const keys = kind === "component"
      ? [claim?.componentIds, claim?.components, references?.componentIds, references?.components, targetIds]
      : [claim?.netIds, claim?.nets, references?.netIds, references?.nets, targetIds];
    return [...new Set(keys.flatMap(asArray).map((value) =>
      String(typeof value === "object" ? firstDefined(value.componentId, value.netId, value.id) : value),
    ).filter((value) => value && value !== "undefined"))];
  }

function normalizeTargets(claim) {
    return asArray(firstDefined(claim?.targets, claim?.references?.targets)).map((target) => {
      if (typeof target === "string") return { kind: "region", id: target };
      return {
        ...target,
        kind: String(firstDefined(target?.kind, "region")).toLowerCase(),
        id: firstDefined(target?.id, target?.componentId, target?.netId, target?.instanceId),
      };
    });
  }

function renderReview() {
    ports.renderConnections();
    renderProposal(reviewState.review?.proposal, reviewState.review?.revision || projectState.revision);
  }

function clearReview() {
    reviewState.review = null;
    reviewState.reviewSignature = "";
    ports.renderConnections();
    renderProposal(null, projectState.revision);
  }

function highlightReferences(componentIds, netIds, targets = []) {
    const componentSet = new Set(componentIds.map(String));
    const netSet = new Set(netIds.map(String));
    const targetBounds = [];
    asArray(targets).forEach((target) => {
      if (target.kind === "component" && target.id) componentSet.add(String(target.id));
      if (target.kind === "net" && target.id) netSet.add(String(target.id));
      if (target.kind === "region") {
        const bounds = normalizeTargetBounds(firstDefined(target.rectangle, target.bounds, target.region));
        if (bounds) targetBounds.push(bounds);
        else if (ports.selectionSnapshot().rectangle) targetBounds.push(ports.selectionSnapshot().rectangle);
      }
      if (target.kind === "instance") {
        const instance = projectState.circuit?.instances.find((item) => String(firstDefined(item.instanceId, item.id)) === String(target.id));
        const bounds = instance ? normalizeBounds(instance.bounds, normalizePoint(instance.location)) : normalizeTargetBounds(target.bounds);
        if (bounds) targetBounds.push(bounds);
      }
    });
    ui.interactionLayer.querySelectorAll(".evidence-target-region").forEach((node) => node.remove());
    targetBounds.forEach((bounds) => {
      ui.interactionLayer.append(makeSvg("rect", {
        class: "selection-region evidence-target-region",
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      }));
    });
    const hasRefs = componentSet.size || netSet.size || targetBounds.length;
    ui.componentLayer.querySelectorAll(".circuit-component").forEach((node) => {
      const active = componentSet.has(node.dataset.objectId);
      node.classList.toggle("is-evidence", active);
      node.classList.toggle("is-dimmed", Boolean(hasRefs && !active));
    });
    ui.wireLayer.querySelectorAll(".wire-group").forEach((node) => {
      const ids = JSON.parse(node.dataset.netIds || `["${node.dataset.netId}"]`);
      const active = ids.some((id) => netSet.has(String(id)));
      node.classList.toggle("is-evidence", active);
      node.classList.toggle("is-dimmed", Boolean(hasRefs && !active));
    });
    focusReferences(componentSet, targetBounds);
  }

function normalizeTargetBounds(value) {
    if (!value || (typeof value !== "object" && !Array.isArray(value))) return null;
    const bounds = normalizeBounds(value);
    return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ? bounds : null;
  }

function focusReferences(componentSet, targetBounds = []) {
    const bounds = [];
    componentSet.forEach((id) => {
      const node = [...ui.componentLayer.querySelectorAll(".circuit-component")].find((item) => item.dataset.objectId === id);
      if (node?.dataset.bounds) bounds.push(JSON.parse(node.dataset.bounds));
    });
    bounds.push(...targetBounds);
    if (!bounds.length) return;
    const minX = Math.min(...bounds.map((item) => item.x));
    const minY = Math.min(...bounds.map((item) => item.y));
    const maxX = Math.max(...bounds.map((item) => item.x + item.width));
    const maxY = Math.max(...bounds.map((item) => item.y + item.height));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    canvasState.camera = {
      ...canvasState.camera,
      x: centerX - canvasState.camera.width / 2,
      y: centerY - canvasState.camera.height / 2,
    };
    ports.applyCamera();
  }

function renderProposal(proposal, reviewRevision) {
    ui.proposalContent.replaceChildren();
    if (!proposal) {
      ui.proposalCount.textContent = String(ports.candidateCount());
      ui.proposalCount.hidden = ui.proposalCount.textContent === "0";
      return;
    }
    ui.proposalCount.textContent = "1";
      ui.proposalCount.hidden = ui.proposalCount.textContent === "0";
    const sheet = makeElement("div", "proposal-sheet");
    const summary = String(firstDefined(proposal.summary, proposal.intent, proposal.title, "未命名修改提案"));
    sheet.append(makeElement("p", "proposal-summary", summary));

    const semanticDiff = asArray(firstDefined(proposal.semanticDiff, proposal.diff, proposal.changes, proposal.operations));
    if (semanticDiff.length) {
      sheet.append(makeElement("h3", "", "语义变化"));
      semanticDiff.forEach((change) => {
        const row = makeElement("div", "semantic-diff");
        const action = firstDefined(change.kind, change.action, change.type, "变化");
        row.append(makeElement("span", "", action));
        row.append(makeElement("div", "", String(firstDefined(change.text, change.summary, change.after, change.to, change))));
        sheet.append(row);
      });
    }
    appendProposalList(sheet, "保护范围", firstDefined(proposal.protectedScope, proposal.protected, proposal.mustNotChange));
    appendProposalList(sheet, "验证义务", firstDefined(proposal.obligations, proposal.verificationObligations, proposal.mustProve));
    appendProposalList(sheet, "仍然未知", firstDefined(proposal.unknowns, proposal.openQuestions));
    const meta = makeElement("div", "proposal-meta");
    meta.textContent = `proposal-only · base ${shortRevision(firstDefined(proposal.baseRevision, reviewRevision, projectState.revision))} · no Apply`;
    sheet.append(meta);
    ui.proposalContent.append(sheet);
  }

function appendProposalList(parent, heading, values) {
    const listValues = asArray(values);
    if (!listValues.length) return;
    parent.append(makeElement("h3", "", heading));
    const list = makeElement("ul", "proposal-list");
    listValues.forEach((value) => list.append(makeElement("li", "", String(firstDefined(value?.text, value?.claim, value?.summary, value)))));
    parent.append(list);
  }

function panelEmpty(text) {
    const empty = makeElement("div", "panel-empty");
    const icon = makeSvg("svg", { viewBox: "0 0 44 44", "aria-hidden": "true" });
    icon.append(makeSvg("path", { d: "M8 33V11h28v22zM14 17h16M14 22h11M14 27h13" }));
    empty.append(icon, makeElement("p", "", text));
    return empty;
  }
  return Object.freeze({queryToReview, loadReview, startReviewPolling, normalizeReview, normalizeLooseClaim, normalizeClaimKind, referenceIds, normalizeTargets, renderReview, clearReview, highlightReferences, normalizeTargetBounds, focusReferences, renderProposal, appendProposalList, panelEmpty});
}
