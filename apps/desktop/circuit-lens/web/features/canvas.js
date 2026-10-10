import {inputControl} from '../core/simulation-inputs.js';
import { asArray, componentId, componentPoint, displayName, firstDefined, netId, normalizeBounds, normalizePoint, wireId, wirePoints } from '../core/values.js';
import { makeSvg } from '../core/dom.js';
import { wirePath } from '../core/wire-path.js';

export const modelDependencies = ["project", "canvas"];

export const dependencies = ["gridViewportChanged","commitCircuitRendering","placementViewportChanged","bindSelectionDrag","resetManipulation","selectionSnapshot","invalidateSimulationFrame","pressButton","activeObservation","clearSelection","enterCircuit","scheduleRendering","openMemory","performProjectAction","pokeComponent","releaseButton","selectComponent","selectRectangle","selectWire","setCanvasStatus","updateCapabilityState","updateSelectionClasses","renderInspector"];

export function createController({models, ui, client, ports}) {
  const {project: projectState, canvas: canvasState} = models;
  let viewportSize = null;
  let wireCursor = null, wireGesture = null, wireVerticalFirst = false, wireTarget = false;
  const readViewportSize = () => ({width: ui.circuitCanvas.clientWidth, height: ui.circuitCanvas.clientHeight});

  function resizeViewport(from, to) {
    if (!from?.width || !from.height || !to.width || !to.height) return;
    // Panels expose or cover world space. They must not silently zoom the
    // circuit (SVG's default behavior with an unchanged viewBox).
    const unitsPerPixel = canvasState.camera.width / from.width;
    canvasState.camera = {...canvasState.camera,
      width: to.width * unitsPerPixel, height: to.height * unitsPerPixel};
    canvasState.fitCameraWidth *= to.width / from.width;
  }

  function mountCanvasViewport() {
    window.addEventListener('blur', cancelWiring);
    ui.circuitCanvas.addEventListener('lostpointercapture', event => {
      if (wireGesture?.id === event.pointerId) cancelWiring();
    });
    new ResizeObserver(() => {
      resizeViewport(viewportSize, readViewportSize());
      applyCamera();
    }).observe(ui.circuitCanvas);
  }
function renderWirePreview() {
    ui.interactionLayer.querySelector(".wire-preview")?.remove();
    if (!canvasState.wireStart) { wireCursor = null; wireGesture = null; return; }
    const points = [...canvasState.wirePoints, ...(wireCursor ? [wireCursor] : [])];
    if (points.length < 2) return;
    ui.interactionLayer.append(makeSvg("polyline", {
      class: "wire-preview",
      points: wirePath(points, wireVerticalFirst).map((point) => `${point.x},${point.y}`).join(" "),
      fill: "none",
    }));
  }

function cancelWiring() {
    const gesture = wireGesture;
    wireGesture = null; wireCursor = null; canvasState.wireStart = null; canvasState.wirePoints = [];
    if (gesture && ui.circuitCanvas.hasPointerCapture(gesture.id)) ui.circuitCanvas.releasePointerCapture(gesture.id);
    ui.circuitCanvas.querySelectorAll('.is-wire-start, .is-wire-target').forEach(node => node.classList.remove('is-wire-start', 'is-wire-target'));
    renderWirePreview();
  }

function snapWirePoint(event) {
    const point = clientToWorld(event.clientX, event.clientY), scale = ui.circuitCanvas.getScreenCTM().a;
    let nearest = null, distance = 10 / scale;
    const consider = (location, node) => {
      const d = Math.hypot(point.x - location.x, point.y - location.y);
      if (d <= distance) { nearest = {location, node}; distance = d; }
    };
    for (const node of ui.componentLayer.querySelectorAll('.wire-port-hit')) consider({x: Number(node.getAttribute('cx')), y: Number(node.getAttribute('cy'))}, node);
    if (!nearest) for (const wire of projectState.circuit.wires) {
      const points = wirePoints(wire), a = points[0], b = points.at(-1);
      if (!a || !b) continue;
      const clamp = (value, a, b) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), Math.round(value / 10) * 10));
      consider(a.x === b.x ? {x:a.x, y:clamp(point.y,a.y,b.y)} : {x:clamp(point.x,a.x,b.x), y:a.y}, null);
    }
    ui.circuitCanvas.querySelectorAll('.is-wire-target').forEach(node => node.classList.remove('is-wire-target'));
    nearest?.node?.classList.add('is-wire-target');
    wireTarget = Boolean(nearest);
    return nearest?.location || {x:Math.round(point.x / 10) * 10, y:Math.round(point.y / 10) * 10};
  }

function beginWirePointer(event, location) {
    if (canvasState.wireStart) { void chooseWireEndpoint(location); return; }
    void chooseWireEndpoint(location);
    wireGesture = {id:event.pointerId, x:event.clientX, y:event.clientY, dragged:false};
    ui.circuitCanvas.setPointerCapture(event.pointerId);
  }

function buildWireNetLookup() {
    const lookup = new Map();
    projectState.circuit.nets.forEach((net, index) => {
      const id = netId(net, index);
      asArray(firstDefined(net.wireIds, net.wires)).forEach((wire) => {
        const idValue = typeof wire === "object" ? firstDefined(wire.wireId, wire.id) : wire;
        if (idValue !== undefined) lookup.set(String(idValue), [id]);
      });
    });
    projectState.circuit.bundles.forEach((bundle) => {
      const ids = asArray(firstDefined(bundle.netIds, bundle.bitNets)).map((entry) =>
        typeof entry === "object" ? firstDefined(entry.netId, entry.id) : entry,
      ).filter(Boolean);
      asArray(bundle.wireIds).forEach((id) => lookup.set(String(id), ids.map(String)));
      const bundleId = firstDefined(bundle.bundleId, bundle.id);
      if (bundleId !== undefined) lookup.set(`bundle:${bundleId}`, ids.map(String));
    });
    return lookup;
  }

let componentNodes = new Map(), componentContext = null;
const optimisticNodes = new Map();
let optimisticDeletion = null;

function clearOptimisticDeletion() {
    if (!optimisticDeletion) return;
    const groups = new Map();
    for (const entry of optimisticDeletion.detached) {
      const entries = groups.get(entry.parent) || [];
      entries.push(entry);
      groups.set(entry.parent, entries);
    }
    for (const entries of groups.values()) for (const entry of entries.sort((a, b) => a.index - b.index)) {
      if (!entry.parent || entry.node.parentNode) continue;
      entry.parent.insertBefore(entry.node, entry.parent.children[entry.index] || null);
    }
    optimisticDeletion.cover.remove();
    optimisticDeletion = null;
}

function beginOptimisticDeletion(selection = {}) {
    clearOptimisticDeletion();
    if (!projectState.circuit || !ui.optimisticDeletionLayer) return false;
    const componentIds = new Set((selection.componentIds || []).map(String));
    const wireIds = new Set((selection.wireIds || []).map(String));
    if (!componentIds.size && !wireIds.size) return false;

    const components = projectState.circuit.components
      .map((component, index) => ({component, id: componentId(component, index), bounds: normalizeBounds(component.bounds, componentPoint(component))}))
      .filter(entry => componentIds.has(entry.id));
    const wires = projectState.circuit.wires
      .map((wire, index) => ({wire, id: wireId(wire, index), points: wirePoints(wire)}))
      .filter(entry => entry.points.length >= 2 && (wireIds.has(entry.id) || components.some(component =>
        entry.points.some(point => point.x >= component.bounds.x - 4 && point.x <= component.bounds.x + component.bounds.width + 4 &&
          point.y >= component.bounds.y - 4 && point.y <= component.bounds.y + component.bounds.height + 4))));
    const detached = [];
    for (const id of componentIds) {
      const node = ui.componentLayer.querySelector(`.circuit-component[data-object-id="${CSS.escape(id)}"]`);
      if (!node) continue;
      detached.push({node, parent: node.parentNode, index: [...node.parentNode.children].indexOf(node)});
      node.remove();
    }
    for (const {id} of wires) {
      const node = ui.wireLayer.querySelector(`.wire-group[data-wire-id="${CSS.escape(id)}"]`);
      if (!node) continue;
      detached.push({node, parent: node.parentNode, index: [...node.parentNode.children].indexOf(node)});
      node.remove();
    }
    const cover = makeSvg("g", {class: "optimistic-delete-cover"});
    for (const {bounds} of components) {
      cover.append(makeSvg("rect", {
        x: bounds.x - 5, y: bounds.y - 5,
        width: bounds.width + 10, height: bounds.height + 10,
        rx: 2, class: "optimistic-delete-fill",
      }));
    }
    for (const {points} of wires) {
      cover.append(makeSvg("polyline", {
        points: wirePath(points).map(point => `${point.x},${point.y}`).join(" "),
        class: "optimistic-delete-wire",
      }));
    }
    ui.optimisticDeletionLayer.replaceChildren(cover);
    optimisticDeletion = {detached, cover};
    return true;
}

function rollbackOptimisticDeletion() {
    clearOptimisticDeletion();
    ports.updateSelectionClasses();
    ports.renderInspector();
}

function renderCircuit({preserveCamera = false, preparedFrame = null} = {}) {
    clearOptimisticDeletion();
    ports.resetManipulation();
    ports.invalidateSimulationFrame();
    cancelWiring();
    ports.commitCircuitRendering(preparedFrame);
    ui.optimisticDeletionLayer?.replaceChildren();
    ui.wireLayer.replaceChildren();

    ui.interactionLayer.replaceChildren();
    const context = `${projectState.session?.workspace?.id}:${projectState.circuitName}:${!!projectState.circuit?.render}`;
    for (const [id, entry] of optimisticNodes) {
      const confirmed = projectState.circuit?.components.some(c => !c.optimistic &&
        c.factory === entry.component.factory && c.location.x === entry.component.location.x && c.location.y === entry.component.location.y);
      if (context !== componentContext || !projectState.circuit || confirmed) {
        entry.node.remove(); optimisticNodes.delete(id);
      }
    }
    if (context !== componentContext || !projectState.circuit) {
      componentContext = context; componentNodes.clear(); ui.componentLayer.replaceChildren();
    }
    if (!projectState.circuit) return;
    ui.circuitCanvas.classList.toggle("is-native", Boolean(projectState.circuit.render));
    const wireNetLookup = buildWireNetLookup();
    const geometry = [];
    const exactConnectivity = projectState.capabilityState === "exact";

    projectState.circuit.wires.forEach((wire, index) => {
      const points = wirePoints(wire);
      if (points.length < 2) return;
      const id = wireId(wire, index);
      const bundleId = firstDefined(wire.bundleId, wire.bundle);
      const relatedNets = exactConnectivity ? asArray(firstDefined(
        wire.netIds,
        wire.netId,
        wire.net,
        wireNetLookup.get(id),
        bundleId !== undefined ? wireNetLookup.get(`bundle:${bundleId}`) : null,
      )).flat().filter(Boolean).map(String) : [];
      const nets = relatedNets.length ? [...new Set(relatedNets)] : [String(firstDefined(bundleId, id))];
      const net = nets[0];
      const hasExactNets = exactConnectivity && relatedNets.length > 0;
      points.forEach((point) => geometry.push(point));
      const group = makeSvg("g", {
        class: "wire-group",
        "data-wire-id": id,
        "data-net-id": net,
        "data-net-ids": JSON.stringify(hasExactNets ? nets : []),
        tabindex: "0",
        role: "button",
        "aria-label": !hasExactNets
          ? `${exactConnectivity ? "未映射" : "几何"}导线片段 ${id}，连通未知`
          : nets.length === 1 ? `网络 ${net}` : `总线，包含 ${nets.length} 个 bit-net`,
      });
      const pointString = points.map((point) => `${point.x},${point.y}`).join(" ");
      const hint = makeSvg('title', {});
      hint.textContent = '拖动调整线段；Shift 多选；Alt + 单击接出分支';
      group.append(hint);
      group.append(
        makeSvg("polyline", { class: "circuit-wire", points: pointString }),
        makeSvg("polyline", { class: "wire-hit", points: pointString }),
      );
      ports.bindSelectionDrag(group,{wireId:id});
      group.addEventListener('pointerdown', event => {
        if (canvasState.mode !== 'select' || canvasState.heldSpace || event.button !== 0 || projectState.sourceChanged) return;
        if (!canvasState.wireStart && !event.altKey) return;
        event.preventDefault(); event.stopPropagation();
        const p = clientToWorld(event.clientX, event.clientY);
        const a = points[0], b = points.at(-1);
        const location = a.x === b.x ? {x:a.x,y:Math.max(Math.min(a.y,b.y),Math.min(Math.max(a.y,b.y),Math.round(p.y/10)*10))}
          : {x:Math.max(Math.min(a.x,b.x),Math.min(Math.max(a.x,b.x),Math.round(p.x/10)*10)),y:a.y};
        if (!projectState.projectBusy) beginWirePointer(event, location);
      });
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          ports.selectWire(id, event.shiftKey);
        }
      });
      ui.wireLayer.append(group);
    });

    const retained = new Map();
    let cursor = ui.componentLayer.firstChild;
    projectState.circuit.components.forEach((component, index) => {
      const point = componentPoint(component);
      const bounds = normalizeBounds(component.bounds, point);
      geometry.push({ x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y + bounds.height });
      const id = componentId(component, index), signature = JSON.stringify(component);
      const cached = componentNodes.get(id);
      const entry = cached?.signature === signature ? cached : {signature, node:renderComponent(component, index, bounds, point)};
      retained.set(id, entry);
      if (entry.node !== cursor) ui.componentLayer.insertBefore(entry.node, cursor);
      cursor = entry.node.nextSibling;
    });

    for (const [id, entry] of componentNodes) if (retained.get(id)?.node !== entry.node) entry.node.remove();
    componentNodes = retained;
    // Clicks arriving while the committed image loads still belong to the next
    // queued edit. Keep their already usable component and artwork on screen.
    for (const {component, node} of optimisticNodes.values()) {
      if (!projectState.circuit.components.some(c => c.componentId === component.componentId)) projectState.circuit.components.push(component);
      ui.componentLayer.append(node);
    }

    if (!projectState.circuit.components.length && !projectState.circuit.wires.length) {
      canvasState.worldBounds = {x:0,y:0,width:900,height:650};
    } else if (projectState.circuit.bounds) {
      canvasState.worldBounds = projectState.circuit.render?.bounds || projectState.circuit.bounds;
    } else if (geometry.length) {
      const xs = geometry.map((point) => point.x);
      const ys = geometry.map((point) => point.y);
      canvasState.worldBounds = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(Math.max(...xs) - Math.min(...xs), 80),
        height: Math.max(Math.max(...ys) - Math.min(...ys), 80),
      };
    }
    if (preserveCamera) applyCamera(); else fitCircuit();
    ports.updateSelectionClasses();
  }

function renderComponent(component, index, bounds, point) {
    const id = componentId(component, index);
    const factory = String(firstDefined(component.factoryName, component.factory, component.type, component.kind, "Component"));
    const label = String(firstDefined(component.label, component.selector?.label, component.attributes?.label, factory));
    const lower = factory.toLocaleLowerCase();
    const group = makeSvg("g", {
      class: "circuit-component",
      "data-object-id": id,
      tabindex: "0",
      role: "button",
      "aria-label": `${label}，${factory}`,
    });
    group.dataset.bounds = JSON.stringify(bounds);
    group.dataset.operable = String(Boolean(inputControl(component)) || ['RAM', 'ROM'].includes(factory));
    group.dataset.inputControl = inputControl(component) || '';
    ports.bindSelectionDrag(group,{componentId:id});

    const x = bounds.x;
    const y = bounds.y;
    const width = Math.max(bounds.width, 14);
    const height = Math.max(bounds.height, 14);
    const cx = x + width / 2;
    const cy = y + height / 2;

    if (!projectState.circuit.render && !component.previewImage) {
    if (lower.includes("pin") || lower === "input" || lower === "output") {
      group.append(makeSvg("circle", { class: "component-body", cx, cy, r: Math.max(4, Math.min(width, height) * 0.3) }));
      group.append(makeSvg("path", { class: "component-detail", d: `M${x} ${cy}H${cx - 4}M${cx + 4} ${cy}H${x + width}` }));
    } else if (lower.includes("not") || lower.includes("inverter")) {
      group.append(makeSvg("path", { class: "component-body", d: `M${x + 2} ${y + 2}V${y + height - 2}L${x + width - 6} ${cy}Z` }));
      group.append(makeSvg("circle", { class: "component-port", cx: x + width - 3, cy, r: 2.8 }));
    } else if (lower.includes("and") || lower.includes("nand")) {
      group.append(makeSvg("path", { class: "component-body", d: `M${x + 2} ${y + 2}H${cx}A${width / 2 - 2} ${height / 2 - 2} 0 0 1 ${cx} ${y + height - 2}H${x + 2}Z` }));
      if (lower.includes("nand")) group.append(makeSvg("circle", { class: "component-port", cx: x + width, cy, r: 2.6 }));
    } else if ((lower === "or" || lower.includes("or gate")) && !lower.includes("xor")) {
      group.append(makeSvg("path", { class: "component-body", d: `M${x + 1} ${y + 2}Q${x + width * 0.37} ${cy} ${x + 1} ${y + height - 2}Q${x + width * 0.58} ${y + height - 2} ${x + width - 1} ${cy}Q${x + width * 0.58} ${y + 2} ${x + 1} ${y + 2}Z` }));
    } else if (lower.includes("tunnel")) {
      group.append(makeSvg("path", { class: "component-body", d: `M${x} ${cy}L${x + 7} ${y + 3}H${x + width}V${y + height - 3}H${x + 7}Z` }));
    } else if (lower.includes("splitter")) {
      group.append(makeSvg("path", { class: "component-body", d: `M${x + 3} ${y}H${x + width - 3}L${x + width} ${y + height}H${x}Z` }));
      group.append(makeSvg("path", { class: "component-detail", d: `M${cx} ${y + 3}V${y + height - 3}` }));
    } else if (lower.includes("mux") || lower.includes("multiplexer") || lower.includes("decoder")) {
      group.append(makeSvg("path", { class: "component-body", d: `M${x + 4} ${y + 1}H${x + width - 4}L${x + width} ${y + height - 1}H${x}Z` }));
    } else if (lower.includes("clock")) {
      group.append(makeSvg("rect", { class: "component-body", x, y, width, height }));
      group.append(makeSvg("path", { class: "component-detail", d: `M${x + 3} ${cy + 3}V${cy - 3}H${cx}V${cy + 3}H${x + width - 3}` }));
    } else {
      group.append(makeSvg("rect", { class: "component-body", x, y, width, height }));
      if (lower.includes("register") || lower.includes("counter") || lower.includes("memory") || lower.includes("ram") || lower.includes("rom")) {
        group.append(makeSvg("path", { class: "component-detail", d: `M${x + 4} ${y + 5}H${x + width - 4}M${x + 4} ${y + height - 5}H${x + width - 4}` }));
      }
    }

    const labelText = makeSvg("text", { class: "component-label", x: cx, y: cy + 2.5 });
    labelText.textContent = label.length > 18 ? `${label.slice(0, 16)}…` : label;
    if (!(lower.includes("pin") || lower === "input" || lower === "output" || lower.includes("not"))) group.append(labelText);
    if (label !== factory && height >= 25) {
      const subtitle = makeSvg("text", { class: "component-subtitle", x: cx, y: y + height - 3 });
      subtitle.textContent = factory.length > 16 ? `${factory.slice(0, 14)}…` : factory;
      group.append(subtitle);
    }

    }
    if (projectState.circuit.render || component.previewImage) {
      group.replaceChildren(makeSvg("rect", { class: "component-hit", x: bounds.x - 2, y: bounds.y - 2, width: Math.max(bounds.width + 4, 9), height: Math.max(bounds.height + 4, 9), rx: 2 }));
      if (component.previewImage) {
        const image = component.previewImage;
        group.prepend(makeSvg('image', {href:image.url, x:point.x+image.x, y:point.y+image.y, width:image.width, height:image.height, 'pointer-events':'none'}));
      }
    }
    // Both drag-to-connect and click-to-route use native port coordinates.
    asArray(component.ends).forEach((end, endIndex) => {
      const location = normalizePoint(end.location);
      if (!location) return;
      const port = makeSvg("circle", { class: "component-port wire-port-hit", cx: location.x, cy: location.y, r: 6,
        tabindex: "0", "data-port-index": endIndex, "aria-label": `连接端口 ${endIndex}` });
      const choose = (event) => {
        if (canvasState.mode !== "select" || canvasState.heldSpace || projectState.sourceChanged || projectState.projectBusy || (event.type === 'pointerdown' && event.button !== 0)) return;
        event.preventDefault(); event.stopPropagation();
        const starting = !canvasState.wireStart;
        if (starting) port.classList.add('is-wire-start');
        if (event.type === 'pointerdown') beginWirePointer(event, location);
        else void chooseWireEndpoint(location);
      };
      const hint = makeSvg('title'); hint.textContent = '拖动连接，或点击后逐段布线；Shift 换向'; port.append(hint);
      port.setAttribute('role', 'button');
      // Handle before the component's drag recognizer captures the pointer.
      port.addEventListener("pointerdown", choose);
      port.addEventListener("click", event => event.stopPropagation());
      port.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") choose(event); });
      group.append(port);
    });
    const childName = component.subcircuit || (projectState.circuits.some((c) => displayName(c) === factory) ? factory : null);
    if (childName) {
      const hint = makeSvg('title', {});
      hint.textContent = `双击或 Alt + Enter 进入 ${childName} 的共享定义`;
      group.append(hint);
      group.addEventListener("dblclick", (event) => { event.stopPropagation(); ports.enterCircuit(component); });
    }
    if (["RAM", "ROM"].includes(factory)) group.addEventListener("dblclick", event => { event.stopPropagation(); ports.openMemory(component); });
    if (factory === "Button") {
      group.addEventListener("pointerdown", event => {
        if (canvasState.mode !== "poke" || canvasState.heldSpace || event.button !== 0) return;
        event.stopPropagation(); group.setPointerCapture(event.pointerId); ports.selectComponent(id, false, false);
        ports.pressButton(component);
      });
      group.addEventListener("pointerup", ports.releaseButton);
      group.addEventListener("pointercancel", ports.releaseButton);
      group.addEventListener("lostpointercapture", ports.releaseButton);
      group.addEventListener('blur', ports.releaseButton);
      group.addEventListener('keyup', event => {
        if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); ports.releaseButton(); }
      });
    }
    group.addEventListener("click", (event) => {
      event.stopPropagation();
      if (canvasState.mode === "pan" || canvasState.heldSpace) return;
      const point = clientToWorld(event.clientX, event.clientY);
      ports.selectComponent(id, event.shiftKey, canvasState.mode !== "poke");
      if (canvasState.mode === "poke" && factory !== "Button") ports.pokeComponent(component, point);
    });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.altKey && childName) {
        event.preventDefault(); event.stopPropagation(); ports.enterCircuit(component); return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        ports.selectComponent(id, event.shiftKey);
        if (canvasState.mode === "poke") {
          if (factory === 'Button') ports.pressButton(component);
          else ports.pokeComponent(component);
        }
      }
    });
    return group;
  }

async function chooseWireEndpoint(location) {
    if (!canvasState.wireStart) {
      canvasState.wireStart = {location};
      canvasState.wirePoints = [location];
      wireCursor = location; wireVerticalFirst = false;
      ui.circuitCanvas.focus({preventScroll:true});
      return;
    }
    const points = wirePath([...canvasState.wirePoints, location], wireVerticalFirst);
    if (points.length < 2) return;
    cancelWiring();
    const pending = makeSvg('polyline', {class:'wire-preview is-pending',points:points.map(p => `${p.x},${p.y}`).join(' '),fill:'none'});
    ui.interactionLayer.append(pending);
    ports.setCanvasStatus(projectState.projectBusy ? '等待当前放置完成…' : '正在连接导线…', 'loading');
    try { await ports.performProjectAction('wire', {circuit:projectState.circuitName, points}); }
    finally { pending.remove(); }
}

function appendOptimisticComponent(component) {
    if (!projectState.circuit || !component?.componentId) return false;
    projectState.circuit.components.push(component);
    const point = componentPoint(component);
    const bounds = normalizeBounds(component.bounds, point);
    const node = renderComponent(component, projectState.circuit.components.length - 1, bounds, point);
    node.classList.add('is-optimistic');
    node.dataset.optimistic = 'true';
    ui.componentLayer.append(node);
    optimisticNodes.set(component.componentId, {component, node});
    ports.updateSelectionClasses();
    ports.renderInspector();
    return true;
}

function removeOptimisticComponent(componentId) {
    const entry = optimisticNodes.get(componentId);
    entry?.node.remove();
    optimisticNodes.delete(componentId);
    if (projectState.circuit) {
      projectState.circuit.components = projectState.circuit.components.filter(component => component.componentId !== componentId);
    }
    ports.updateSelectionClasses();
    ports.renderInspector();
}

function focusComponents(ids) {
    const targets = projectState.circuit?.components.filter((c,i)=>ids.includes(componentId(c,i))) || [];
    if (!targets.length) return;
    const bounds = targets.map(c=>normalizeBounds(c.bounds,componentPoint(c)));
    const left=Math.min(...bounds.map(b=>b.x)),top=Math.min(...bounds.map(b=>b.y));
    const width=Math.max(...bounds.map(b=>b.x+b.width))-left,height=Math.max(...bounds.map(b=>b.y+b.height))-top;
    const old=canvasState.camera, pad=40;
    if(left>=old.x+pad&&top>=old.y+pad&&left+width<=old.x+old.width-pad&&top+height<=old.y+old.height-pad)return;
    const scale=Math.max(1,(width+2*pad)/old.width,(height+2*pad)/old.height);
    const w=old.width*scale,h=old.height*scale;
    canvasState.camera={x:left+(width-w)/2,y:top+(height-h)/2,width:w,height:h};
    applyCamera();
  }

function fitCircuit(bounds = canvasState.worldBounds) {
    if (!bounds || !ui.canvasStage.clientWidth || !ui.canvasStage.clientHeight) return;
    const pad = Math.max(45, Math.min(bounds.width, bounds.height) * 0.08);
    const target = {
      x: bounds.x - pad,
      y: bounds.y - pad,
      width: Math.max(bounds.width + pad * 2, 80),
      height: Math.max(bounds.height + pad * 2, 80),
    };
    // Fit inside the unobscured canvas, including wrapped toolbars in small windows.
    const viewport = ui.circuitCanvas.getBoundingClientRect();
    const toolbar = ui.canvasStage.querySelector('.canvas-toolbar').getBoundingClientRect();
    const transport = ui.simulationTransport.getBoundingClientRect();
    const top = ui.simulationTransport.hidden ? 0 : Math.max(0, transport.bottom - viewport.top) + 12;
    const bottom = Math.max(0, viewport.bottom - toolbar.top) + 12;
    const availableHeight = Math.max(1, viewport.height - top - bottom);
    const scale = Math.max(target.width / Math.max(1, viewport.width), target.height / availableHeight);
    const width = viewport.width * scale, height = viewport.height * scale;
    canvasState.camera = {
      x: target.x + (target.width - width) / 2,
      y: target.y + target.height / 2 - (top + availableHeight / 2) * scale,
      width, height,
    };
    canvasState.fitCameraWidth = width;
    applyCamera();
  }

function applyCamera() {
    viewportSize = readViewportSize();
    const camera = canvasState.camera;
    ui.circuitCanvas.setAttribute("viewBox", `${camera.x} ${camera.y} ${camera.width} ${camera.height}`);
    const percent = Math.round((canvasState.fitCameraWidth / camera.width) * 100);
    ui.zoomReadout.textContent = `${Math.max(1, percent)}%`;
    ports.gridViewportChanged();
    ports.scheduleRendering();
    ports.placementViewportChanged();
  }

function zoomAt(factor, clientX, clientY) {
    const rect = ui.circuitCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const xRatio = (clientX - rect.left) / rect.width;
    const yRatio = (clientY - rect.top) / rect.height;
    const old = canvasState.camera;
    const width = Math.min(Math.max(old.width * factor, rect.width / 16), Math.max(canvasState.fitCameraWidth * 18, rect.width / 16));
    const height = width * (old.height / old.width);
    const anchorX = old.x + old.width * xRatio;
    const anchorY = old.y + old.height * yRatio;
    canvasState.camera = {
      x: anchorX - width * xRatio,
      y: anchorY - height * yRatio,
      width,
      height,
    };
    applyCamera();
  }

function clientToWorld(clientX, clientY) {
    return new DOMPoint(clientX, clientY).matrixTransform(ui.circuitCanvas.getScreenCTM().inverse());
  }

function onPointerDown(event) {
    if (!projectState.circuit || event.button > 1) return;
    if (canvasState.wireStart && event.button === 0 && !event.target.closest?.(".wire-port-hit")) {
      const snapped = snapWirePoint(event);
      const previous = canvasState.wirePoints[canvasState.wirePoints.length - 1];
      if (!previous || previous.x !== snapped.x || previous.y !== snapped.y) {
        canvasState.wirePoints = wirePath([...canvasState.wirePoints, snapped], wireVerticalFirst);
        wireCursor = snapped;
        renderWirePreview();
      }
      event.preventDefault();
      return;
    }
    // Port gestures own the pointer sequence; never let the enclosing
    // component turn a connection attempt into a move or marquee.
    if (event.target.closest?.(".wire-port-hit") && !canvasState.heldSpace && canvasState.mode !== 'pan' && event.button !== 1) return;
    const onObject = event.target.closest?.(".circuit-component, .wire-group");
    if (onObject && canvasState.mode !== "pan" && !canvasState.heldSpace && event.button === 0) return;
    if (canvasState.mode === "poke" && !onObject && !canvasState.heldSpace && event.button === 0) return;
    const effectiveMode = canvasState.heldSpace || event.button === 1 ? "pan" : canvasState.mode;
    const startWorld = clientToWorld(event.clientX, event.clientY);
    canvasState.pointer = {
      id: event.pointerId,
      mode: effectiveMode,
      startClient: { x: event.clientX, y: event.clientY },
      startWorld,
      camera: { ...canvasState.camera },
      additive: event.shiftKey,
    };
    ui.circuitCanvas.setPointerCapture(event.pointerId);
    ui.circuitCanvas.classList.add("is-dragging");
    if (effectiveMode === "select") {
      const marquee = makeSvg("rect", { class: "selection-marquee", x: startWorld.x, y: startWorld.y, width: 0, height: 0 });
      marquee.id = "selectionMarquee";
      ui.interactionLayer.append(marquee);
    }
  }

function onPointerMove(event) {
    if (canvasState.wireStart) {
      if (projectState.sourceChanged || canvasState.mode !== 'select') { cancelWiring(); return; }
      wireVerticalFirst = event.shiftKey;
      wireCursor = snapWirePoint(event);
      if (wireGesture?.id === event.pointerId && Math.hypot(event.clientX - wireGesture.x, event.clientY - wireGesture.y) >= 4) wireGesture.dragged = true;
      renderWirePreview(); return;
    }
    if (!canvasState.pointer || event.pointerId !== canvasState.pointer.id) return;
    if (canvasState.pointer.mode === "pan") {
      const rect = ui.circuitCanvas.getBoundingClientRect();
      const dx = ((event.clientX - canvasState.pointer.startClient.x) / rect.width) * canvasState.pointer.camera.width;
      const dy = ((event.clientY - canvasState.pointer.startClient.y) / rect.height) * canvasState.pointer.camera.height;
      canvasState.camera = { ...canvasState.pointer.camera, x: canvasState.pointer.camera.x - dx, y: canvasState.pointer.camera.y - dy };
      applyCamera();
      return;
    }
    const current = clientToWorld(event.clientX, event.clientY);
    const x = Math.min(current.x, canvasState.pointer.startWorld.x);
    const y = Math.min(current.y, canvasState.pointer.startWorld.y);
    const width = Math.abs(current.x - canvasState.pointer.startWorld.x);
    const height = Math.abs(current.y - canvasState.pointer.startWorld.y);
    const marquee = document.getElementById("selectionMarquee");
    if (marquee) {
      marquee.setAttribute("x", x);
      marquee.setAttribute("y", y);
      marquee.setAttribute("width", width);
      marquee.setAttribute("height", height);
      marquee.classList.toggle("is-crossing",current.x < canvasState.pointer.startWorld.x);
    }
  }

function onPointerUp(event) {
    if (wireGesture?.id === event.pointerId) {
      const gesture = wireGesture; wireGesture = null;
      if (ui.circuitCanvas.hasPointerCapture(event.pointerId)) ui.circuitCanvas.releasePointerCapture(event.pointerId);
      if (event.type === 'pointercancel') { cancelWiring(); return; }
      if (gesture.dragged) {
        const rect = ui.circuitCanvas.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { cancelWiring(); return; }
        wireVerticalFirst = event.shiftKey;
        const location = snapWirePoint(event);
        if (wireTarget) void chooseWireEndpoint(location);
        else {
          // A release in empty space fixes a bend; the route stays a draft
          // until it reaches an electrically defined port or wire.
          canvasState.wirePoints = wirePath([...canvasState.wirePoints, location], wireVerticalFirst);
          wireCursor = location; renderWirePreview();
        }
      }
      return;
    }
    if (!canvasState.pointer || event.pointerId !== canvasState.pointer.id) return;
    if (canvasState.pointer.mode === "select") {
      const current = clientToWorld(event.clientX, event.clientY);
      const rectangle = {
        x: Math.min(current.x, canvasState.pointer.startWorld.x),
        y: Math.min(current.y, canvasState.pointer.startWorld.y),
        width: Math.abs(current.x - canvasState.pointer.startWorld.x),
        height: Math.abs(current.y - canvasState.pointer.startWorld.y),
      };
      document.getElementById("selectionMarquee")?.remove();
      if (rectangle.width > canvasState.camera.width * 0.006 || rectangle.height > canvasState.camera.height * 0.006) {
        ports.selectRectangle(rectangle, canvasState.pointer.additive, current.x < canvasState.pointer.startWorld.x);
      } else if (!canvasState.pointer.additive) {
        ports.clearSelection({ notifyServer: false });
        ports.updateCapabilityState();
      }
    }
    ui.circuitCanvas.classList.remove("is-dragging");
    canvasState.pointer = null;
  }
  function captureViewport() {
    return {camera: {...canvasState.camera}, fitWidth: canvasState.fitCameraWidth, size: {...viewportSize}};
  }

  function restoreViewport(viewport) {
    canvasState.camera = {...viewport.camera};
    canvasState.fitCameraWidth = viewport.fitWidth;
    resizeViewport(viewport.size, readViewportSize());
    applyCamera();
  }

  return Object.freeze({cancelWiring, mountCanvasViewport, focusComponents, captureViewport, restoreViewport, renderWirePreview, buildWireNetLookup, renderCircuit, renderComponent, appendOptimisticComponent, removeOptimisticComponent, beginOptimisticDeletion, rollbackOptimisticDeletion, fitCircuit, applyCamera, zoomAt, clientToWorld, onPointerDown, onPointerMove, onPointerUp});
}
