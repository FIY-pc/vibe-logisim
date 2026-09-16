import { asArray, componentId, firstDefined, netId, rectanglesIntersect, responseRevision, shortRevision } from '../core/values.js';
import { makeSvg } from '../core/dom.js';
import { API } from '../core/endpoints.js';
import {wireInRectangle,within} from '../core/selection-geometry.js';

export const modelDependencies = ["project", "canvas", "focus", "review", "agent"];

export const dependencies = ["renderConnections","revealInspector","applyCamera","clearReview","highlightReferences","markStale","normalizeReview","normalizeTargetBounds","openReviewPanel","queryToReview","renderInspector","renderReview","showToast","switchReviewTab","updateCapabilityState","updateComposerState"];

export function createController({models, ui, client, ports}) {
  const {project: projectState, canvas: canvasState, focus: focusState, review: reviewState, agent: agentState} = models;
  const request = client.request;
function hasSelection() {
    return focusState.selectedComponentIds.size > 0 || focusState.selectedNetIds.size > 0 || focusState.selectedWireIds.size > 0 || Boolean(focusState.selectionRectangle);
  }

function selectionSnapshot() {
    return {
      projectId: projectState.session?.workspace?.id,
      revisionId: projectState.revision,
      circuit: projectState.circuitName,
      componentIds: [...focusState.selectedComponentIds],
      netIds: [...focusState.selectedNetIds],
      wireIds: [...focusState.selectedWireIds],
      rectangle: focusState.selectionRectangle ? { ...focusState.selectionRectangle } : null,
    };
  }

// Detached observations let other domains read the focus without owning it.
function restoreDraftSelection(snapshot) {
    if(snapshot.projectId!==projectState.session?.workspace?.id||snapshot.revisionId!==projectState.revision||snapshot.circuit!==projectState.circuitName)return false;
    const circuit=projectState.circuit;
    if(!circuit||snapshot.componentIds.some(id=>!circuit.components.some((c,i)=>componentId(c,i)===id))||snapshot.netIds.some(id=>!circuit.nets.some((n,i)=>netId(n,i)===id))||snapshot.wireIds.some(id=>!circuit.wires.some(w=>w.wireId===id)))return false;
    adoptResolvedSelection({intent:snapshot},true);commitLocalSelection();return true;
  }

function selectionStatus() {
    return {
      selectionEpoch: focusState.selectionEpoch,
      selectionCommittedEpoch: focusState.selectionCommittedEpoch,
      selection: focusState.selection ? structuredClone(focusState.selection) : null,
    };
  }

function selectRegionContext(bounds) {
    focusState.selectedComponentIds.clear();
    focusState.selectedNetIds.clear();
    focusState.selectedWireIds.clear();
    focusState.selectionRectangle = bounds ? { ...bounds } : null;
    commitLocalSelection();
  }

function intentSnapshot(selection, fallback = selectionSnapshot()) {
    const intent = selection?.intent;
    if (!intent || typeof intent !== "object") return fallback;
    return {
      revisionId: selection.revisionId || fallback.revisionId,
      circuit: selection.circuit || fallback.circuit,
      componentIds: asArray(intent.componentIds).map(String),
      netIds: asArray(intent.netIds).map(String),
      wireIds: asArray(intent.wireIds).map(String),
      rectangle: intent.rectangle ? { ...intent.rectangle } : null,
    };
  }

function invalidateFrozenSelection() {
    focusState.selectionEpoch += 1;
    focusState.selectionCommittedEpoch = -1;
    focusState.selectionRequest = null;
    focusState.selection = null;
  }

function selectComponent(id, additive = false, inspect = true) {
    if (!additive && focusState.selectedComponentIds.size === 1 && focusState.selectedComponentIds.has(id) && !focusState.selectedWireIds.size && !focusState.selectedNetIds.size && !focusState.selectionRectangle) {
      if (inspect) ports.revealInspector();
      return;
    }
    if (!additive) {
      focusState.selectedComponentIds.clear();
      focusState.selectedNetIds.clear();
      focusState.selectedWireIds.clear();
    }
    if (additive && focusState.selectedComponentIds.has(id)) focusState.selectedComponentIds.delete(id);
    else focusState.selectedComponentIds.add(id);
    focusState.selectionRectangle = null;
    commitLocalSelection();
    // Poking changes the object, not the camera or the open inspector panel.
    if (!inspect) return;
    ports.revealInspector();

  }

function focusHarnessTargets(feedback, session) {
    // Object IDs are local to a circuit artifact, including candidate artifacts.
    if (!session || session.revisionId !== projectState.revision ||
        session.circuit !== projectState.circuitName || session.candidateId) return false;
    const targets = Array.isArray(feedback?.targets) ? feedback.targets : [];
    const ids = targets.map(target => firstDefined(target?.componentId, target?.component, target?.id))
      .map(String)
      .filter(id => projectState.circuit?.components.some((c, i) => componentId(c, i) === id));
    const nets = targets.map(target => firstDefined(target?.netId, target?.net))
      .map(value => value == null ? null : String(value))
      .filter(id => id && projectState.circuit?.nets?.some(net => String(firstDefined(net.netId, net.id)) === id));
    const targetBounds = targets.map(target => ports.normalizeTargetBounds(firstDefined(target?.bounds, target?.rectangle, target?.region))).filter(Boolean);
    if (!ids.length && !nets.length && !targetBounds.length) return false;
    focusState.selectedComponentIds.clear();
    focusState.selectedWireIds.clear();
    focusState.selectedNetIds = new Set(nets);
    ids.forEach(id => focusState.selectedComponentIds.add(id));
    focusState.selectionRectangle = null;
    commitLocalSelection();
    ports.highlightReferences(ids, nets, targetBounds.map(bounds => ({ kind: "region", bounds })));
    return true;
  }

function selectNet(id, additive = false) {
    selectNets([id], additive);
  }

function selectNets(ids, additive = false) {
    if (!additive) {
      focusState.selectedComponentIds.clear();
      focusState.selectedNetIds.clear();
      focusState.selectedWireIds.clear();
    }
    ids.map(String).forEach((id) => {
      if (additive && focusState.selectedNetIds.has(id)) focusState.selectedNetIds.delete(id);
      else focusState.selectedNetIds.add(id);
    });
    focusState.selectionRectangle = null;
    commitLocalSelection();
  }

function selectWire(id, additive = false) {
    if (!additive) {
      focusState.selectedComponentIds.clear();
      focusState.selectedNetIds.clear();
      focusState.selectedWireIds.clear();
    }
    const key = String(id);
    if (additive && focusState.selectedWireIds.has(key)) focusState.selectedWireIds.delete(key);
    else focusState.selectedWireIds.add(key);
    focusState.selectionRectangle = null;
    commitLocalSelection();
  }

function selectGeometryWire(points, additive = false) {
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const padding = 5;
    selectRectangle({
      x: Math.min(...xs) - padding,
      y: Math.min(...ys) - padding,
      width: Math.max(Math.max(...xs) - Math.min(...xs) + padding * 2, 10),
      height: Math.max(Math.max(...ys) - Math.min(...ys) + padding * 2, 10),
    }, additive);
  }

function selectRectangle(rectangle, additive = false, crossing = false) {
    if (!additive) {
      focusState.selectedWireIds.clear();
      focusState.selectedComponentIds.clear();
      focusState.selectedNetIds.clear();
    }
    focusState.selectionRectangle = {...rectangle,width:Math.max(1,rectangle.width),height:Math.max(1,rectangle.height)};
    ui.componentLayer.querySelectorAll(".circuit-component").forEach((node) => {
      const bounds = JSON.parse(node.dataset.bounds || "{}");
      const inside=crossing?rectanglesIntersect(rectangle,bounds):within(bounds,rectangle)&&within({x:bounds.x+bounds.width,y:bounds.y+bounds.height},rectangle);
      if(inside){
        if(additive&&focusState.selectedComponentIds.has(node.dataset.objectId))focusState.selectedComponentIds.delete(node.dataset.objectId);
        else focusState.selectedComponentIds.add(node.dataset.objectId);
      }
    });
    projectState.circuit.wires.forEach(wire=>{
      if(!wireInRectangle(wire,rectangle,crossing))return;
      if(additive&&focusState.selectedWireIds.has(wire.wireId))focusState.selectedWireIds.delete(wire.wireId);
      else focusState.selectedWireIds.add(wire.wireId);
    });
    commitLocalSelection();
  }

function commitLocalSelection() {
    invalidateFrozenSelection();
    ports.clearReview();
    updateSelectionClasses();
    updateSelectionDock();
    ports.updateCapabilityState();
    // Freeze a durable selection only when querying, copying, or asking AI.
  }

function updateSelectionClasses() {
    document.getElementById("selectionRegion")?.remove();
    ui.interactionLayer.querySelectorAll(".evidence-target-region").forEach((node) => node.remove());
    if (focusState.selectionRectangle) {
      const region = makeSvg("rect", {
        id: "selectionRegion",
        class: "selection-region",
        x: focusState.selectionRectangle.x,
        y: focusState.selectionRectangle.y,
        width: focusState.selectionRectangle.width,
        height: focusState.selectionRectangle.height,
      });
      ui.interactionLayer.prepend(region);
    }
    ui.componentLayer.querySelectorAll(".circuit-component").forEach((node) => {
      node.classList.toggle("is-selected", focusState.selectedComponentIds.has(node.dataset.objectId));
      node.classList.remove("is-evidence", "is-dimmed");
    });
    ui.wireLayer.querySelectorAll(".wire-group").forEach((node) => {
      const ids = JSON.parse(node.dataset.netIds || `["${node.dataset.netId}"]`);
      const related = ids.some((id) => focusState.selectedNetIds.has(String(id)));
      node.classList.toggle("is-selected", related && !focusState.selectedComponentIds.size);
      node.classList.toggle("is-related", related && Boolean(focusState.selectedComponentIds.size));
      node.classList.toggle("is-selected-wire", focusState.selectedWireIds.has(String(node.dataset.wireId)));
      node.classList.remove("is-evidence", "is-dimmed");
    });
    ui.deleteSelectionButton.disabled = !(focusState.selectedComponentIds.size || focusState.selectedWireIds.size) || projectState.projectBusy || projectState.sourceChanged;
  }

function updateSelectionDock() {
    ports.renderInspector();
    ports.renderConnections();
    ui.clearComposerContext.hidden = !hasSelection();
    ui.clearObjectSelection.hidden = !hasSelection();
    ui.selectionDock.hidden = agentState.enabled ? !projectState.session : !hasSelection();
    if (!hasSelection()) {
      ui.selectionSummary.textContent = projectState.circuitName ? `整个 ${projectState.circuitName}` : projectState.folder ? "工作区文件" : "尚未打开工作区";
      ui.selectionRevision.textContent = shortRevision(projectState.revision);
      ui.selectionRevision.title = projectState.revision || "";
      ui.askButton.textContent = agentState.enabled ? "发送" : "查询证据";
      ports.updateComposerState();
      return;
    }
    const components = focusState.selectedComponentIds.size;
    const nets = focusState.selectedNetIds.size;
    const wires = focusState.selectedWireIds.size;
    const bits = [];
    if (wires) bits.push(`${wires} 段导线`);
    if (components) {
      const names = [...focusState.selectedComponentIds].map(id => {
        const c = projectState.circuit?.components.find((c, i) => componentId(c, i) === id);
        return c?.label || c?.factory || id;
      });
      bits.push(names.length <= 2 ? names.join("、") : `${names[0]} 等 ${components} 个组件`);
    }
    if (nets) bits.push(components ? `${nets} 个关联 bit-net` : `${nets} 个 bit-net`);
    if (!bits.length && focusState.selectionRectangle) bits.push("1 个空间区域");
    ui.selectionSummary.textContent = `${projectState.sourceChanged ? "旧版本 · " : ""}${bits.join("，")}`;
    ui.selectionRevision.textContent = shortRevision(projectState.revision);
    ui.selectionRevision.title = projectState.revision || "";
    ui.askButton.textContent = agentState.enabled
      ? "发送"
      : queryIntent().kind === "overview" ? "查询区域概览" : "查询证据";
    ports.updateComposerState();
  }

async function postSelection(snapshot = selectionSnapshot(), expectedEpoch = focusState.selectionEpoch) {
    if (focusState.selectionRequest?.epoch === expectedEpoch) return structuredClone(await focusState.selectionRequest.promise);

    const isCurrent = () => expectedEpoch === focusState.selectionEpoch
      && snapshot.projectId === projectState.session?.workspace?.id
      && snapshot.revisionId === projectState.revision && snapshot.circuit === projectState.circuitName;
    const persist = async () => {
      if (!isCurrent()) return null;
      if ((!snapshot.componentIds.length && !snapshot.netIds.length && !(snapshot.wireIds || []).length && !snapshot.rectangle) || projectState.isDemo) {
        if (!isCurrent()) return null;
        focusState.selection = localSelectionResponse(snapshot);
        focusState.selectionCommittedEpoch = expectedEpoch;
        return focusState.selection;
      }
      const body = {
        projectId: snapshot.projectId,
        revisionId: snapshot.revisionId,
        circuit: snapshot.circuit,
        componentIds: snapshot.componentIds,
        netIds: snapshot.netIds,
        wireIds: snapshot.wireIds,
      };
      if (snapshot.rectangle) body.rectangle = snapshot.rectangle;
      try {
        const response = await request(API.selection, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (
          !isCurrent()
        ) return null;
        if (responseRevision(response) && responseRevision(response) !== projectState.revision) {
          ports.markStale("选区响应属于另一个版本，已保留当前旧引用。");
          return null;
        }
        focusState.selection = response || localSelectionResponse(snapshot);
        focusState.selectionCommittedEpoch = expectedEpoch;
        adoptResolvedSelection(response);
        updateSelectionClasses();
        updateSelectionDock();
        ports.updateCapabilityState();
        return focusState.selection;
      } catch (error) {
        if (!isCurrent()) return null;
        focusState.selection = localSelectionResponse(snapshot);
        focusState.selectionCommittedEpoch = -1;
        ports.showToast(`选区已保留在页面中；本地引用保存失败：${error.message}`);
        return focusState.selection;
      }
    };

    // The local server is threaded and its current-selection pointer is mutable.
    // Preserve UI order on the wire so an older POST can never commit after a
    // newer selection. Immutable selection IDs remain independently queryable.
    const promise = focusState.selectionWriteQueue.then(persist, persist);
    focusState.selectionWriteQueue = promise.catch(() => null);
    focusState.selectionRequest = { epoch: expectedEpoch, promise };
    try {
      return structuredClone(await promise);
    } finally {
      if (focusState.selectionRequest?.promise === promise) focusState.selectionRequest = null;
    }
  }

async function loadSelection() {
    if (projectState.isDemo) return;
    const expectedEpoch = focusState.selectionEpoch;
    const expectedProject = projectState.session?.workspace?.id;
    const expectedRevision = projectState.revision;
    const expectedCircuit = projectState.circuitName;
    try {
      const response = await request(API.selection);
      if (!response || response.empty) return;
      if (
        expectedProject !== projectState.session?.workspace?.id ||
        response.projectId !== expectedProject ||
        expectedEpoch !== focusState.selectionEpoch ||
        expectedRevision !== projectState.revision ||
        expectedCircuit !== projectState.circuitName
      ) return;
      const selectionRevision = responseRevision(response);
      if (selectionRevision && selectionRevision !== projectState.revision) {
        ports.markStale("已有选区属于旧版本，没有映射到当前电路。");
        focusState.selection = response;
        return;
      }
      if (response.circuit && response.circuit !== projectState.circuitName) return;
      focusState.selection = response;
      focusState.selectionCommittedEpoch = expectedEpoch;
      adoptResolvedSelection(response, true);
      updateSelectionClasses();
      updateSelectionDock();
      ports.updateCapabilityState();
    } catch (_) {
      // Selection persistence is helpful but not required to inspect a circuit.
    }
  }

function adoptResolvedSelection(response, replace = false) {
    if (!response) return;
    if(response.intent){
      const intent=response.intent;
      focusState.selectedComponentIds=new Set(intent.componentIds||[]);
      focusState.selectedNetIds=new Set(intent.netIds||[]);
      focusState.selectedWireIds=new Set(intent.wireIds||[]);
      focusState.selectionRectangle=intent.rectangle||null;
      return;
    }
    const resolved = response.resolved || response.selection || response.reference || {};
    const componentIds = asArray(firstDefined(response.componentIds, resolved.componentIds, resolved.components)).map(String);
    const netIds = asArray(firstDefined(response.netIds, resolved.netIds, resolved.nets)).map((item) =>
      String(typeof item === "object" ? firstDefined(item.netId, item.id) : item),
    );
    if (replace) {
      focusState.selectedComponentIds.clear();
      focusState.selectedNetIds.clear();
      focusState.selectedWireIds.clear();
    }
    componentIds.forEach((id) => focusState.selectedComponentIds.add(id));
    netIds.forEach((id) => focusState.selectedNetIds.add(id));
    if (response.rectangle) focusState.selectionRectangle = response.rectangle;
  }

function localSelectionResponse(snapshot = selectionSnapshot()) {
    const reference = `${snapshot.circuit || "circuit"}@${shortRevision(snapshot.revisionId)}:${[
      ...snapshot.componentIds,
      ...snapshot.netIds,
      ...(snapshot.wireIds||[]),
    ].join(",") || "region"}`;
    return {
      revision: snapshot.revisionId,
      reference,
      componentIds: snapshot.componentIds,
      netIds: snapshot.netIds,
      wireIds: snapshot.wireIds,
      rectangle: snapshot.rectangle,
    };
  }

function clearSelection({ notifyServer = false } = {}) {
    focusState.selectedWireIds.clear();
    focusState.selectedComponentIds.clear();
    focusState.selectedNetIds.clear();
    focusState.selectionRectangle = null;
    invalidateFrozenSelection();
    ui.interactionLayer.replaceChildren();
    updateSelectionClasses();
    updateSelectionDock();
    ports.clearReview();
    if (notifyServer && !projectState.isDemo) void postSelection(selectionSnapshot(), focusState.selectionEpoch);
  }

function copyReferenceText() {
    const selection = focusState.selection || localSelectionResponse();
    const returned = firstDefined(selection.agentMessage, selection.agentFacingState, selection.command);
    const question = ui.questionInput.value.trim();
    if (returned) return question ? `${returned}\n\n我的问题：${question}` : String(returned);
    const ids = [...focusState.selectedComponentIds, ...focusState.selectedNetIds, ...focusState.selectedWireIds];
    const lines = [
      "请使用 Vibe Logisim Circuit Lens 检查这个选区。",
      `电路：${projectState.circuitName || "未知"}`,
      `版本：${projectState.revision || "未冻结"}`,
      `引用：${firstDefined(selection.reference?.id, selection.reference, ids.join(", "), "空间区域")}`,
    ];
    if (selection.statePath) lines.push(`状态文件：${selection.statePath}`);
    if (projectState.sourceChanged) lines.push("注意：源文件已经变化，这个引用属于旧版本；不要自动映射。 ");
    if (question) lines.push(`问题：${question}`);
    return lines.join("\n");
  }

async function copyReference() {
    await postSelection();
    if (focusState.selectionCommittedEpoch !== focusState.selectionEpoch) return;
    const text = copyReferenceText();
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    ports.showToast("已复制当前选区的引用。");
  }

function queryIntent(snapshot = selectionSnapshot()) {
    if(snapshot.wireIds?.length)return {kind:'overview'};
    const componentIds = snapshot.componentIds || [];
    const netIds = snapshot.netIds || [];
    const componentCount = componentIds.length;
    const netCount = netIds.length;
    if (componentCount > 0 && componentCount <= 4) {
      return { kind: "component", ids: [...componentIds] };
    }
    if (componentCount === 0 && netCount > 0 && netCount <= 4) {
      return { kind: "net", ids: [...netIds] };
    }
    return { kind: "overview" };
  }

function chooseQuery() {
    const question = ui.questionInput.value.trim();
    const binding = {
      revisionId: projectState.revision,
      selectionId: focusState.selection?.id,
      question,
    };
    return { ...binding, ...queryIntent() };
  }

async function querySelection() {
    if (!hasSelection() || projectState.sourceChanged || projectState.capabilityState !== "exact") return;
    await postSelection();
    if (focusState.selectionCommittedEpoch !== focusState.selectionEpoch) return;
    const question = ui.questionInput.value.trim();
    const query = chooseQuery();
    const expectedEpoch = focusState.selectionEpoch;
    const expectedSelectionId = focusState.selection?.id || null;
    ui.askButton.disabled = true;
    ui.askButton.textContent = "正在查询…";
    try {
      if (projectState.isDemo) {
        const selectedComponents = projectState.circuit.components.filter((component, index) =>
          focusState.selectedComponentIds.has(componentId(component, index)),
        );
        const selectedNets = projectState.circuit.nets.filter((net, index) => focusState.selectedNetIds.has(netId(net, index)));
        reviewState.review = ports.normalizeReview(ports.queryToReview({ requestedComponents: selectedComponents, nets: selectedNets }, question, query.kind), question);
        reviewState.reviewSignature = JSON.stringify(reviewState.review);
        ports.renderReview();
        ports.switchReviewTab("evidence");
        ports.openReviewPanel();
        return;
      }
      const payload = await request(API.query, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(query),
      });
      const payloadRevision = responseRevision(payload);
      if (payloadRevision && payloadRevision !== projectState.revision) {
        ports.markStale("查询结果属于另一个版本，未显示为当前证据。");
        return;
      }
      if (
        expectedEpoch !== focusState.selectionEpoch ||
        expectedSelectionId !== (focusState.selection?.id || null)
      ) return;
      const review = payload?.review || ports.queryToReview(payload?.result || payload, question, query.kind);
      reviewState.review = ports.normalizeReview(review, question);
      reviewState.reviewSignature = JSON.stringify(reviewState.review);
      ports.renderReview();
      ports.switchReviewTab("evidence");
      ports.openReviewPanel();
    } catch (error) {
      ports.showToast(`查询失败：${error.message}`);
    } finally {
      ui.askButton.textContent = queryIntent().kind === "overview" ? "查询区域概览" : "查询证据";
      ports.updateCapabilityState();
    }
  }
  return Object.freeze({restoreDraftSelection,selectionStatus, selectRegionContext, hasSelection, selectionSnapshot, intentSnapshot, invalidateFrozenSelection, selectComponent, focusHarnessTargets, selectNet, selectNets, selectWire, selectGeometryWire, selectRectangle, commitLocalSelection, updateSelectionClasses, updateSelectionDock, postSelection, loadSelection, adoptResolvedSelection, localSelectionResponse, clearSelection, copyReferenceText, copyReference, queryIntent, chooseQuery, querySelection});
}
