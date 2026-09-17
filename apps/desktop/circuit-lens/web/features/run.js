import { formatInput, formatSignal } from '../core/values.js';
import { makeElement, makeSvg } from '../core/dom.js';

export const modelDependencies = ["project", "run"];

export const dependencies = ["renderSimulationControls","updateMomentCapture","runtimeNavigationStarted","renderNavigation","setRenderingLive","loadCircuit","showToast","openMemory","openReviewPanel","renderInspector","selectComponent","switchReviewTab","updateMemoryFromSimulation"];

export function createController({models, ui, client, ports}) {
  const {project: projectState, run: runState} = models;
  const request = client.request;
  let pollingToken = 0;
function simulationStatus() {
    const s = runState.simulation;
    return Object.freeze({ exists: Boolean(s?.session), running: Boolean(s?.running), automatic: s?.automatic !== false,
      frequency: s?.session ? s.frequency : undefined, actualFrequency: s?.actualFrequency, circuit: s?.session?.circuit,
      ticks: s?.observation?.ticks, visible: Boolean(activeObservation()), busy: runState.simulationBusy, busyAction: runState.simulationBusyAction, viewBusy: runState.simulationViewBusy });
  }

function invalidateSimulationFrame() { runState.simulationFrame = null; }

function invalidateSimulation() {
    pollingToken++;
    runState.simulationEpoch++;
    runState.simulation = null;
    runState.simulationBusy = false;
    runState.simulationBusyAction = null;
    runState.simulationPolling = false;
    runState.simulationPendingSequence = 0;
    runState.heldButton = null;
    runState.displayedView = null;
    runState.simulationViewBusy=false;
    runState.watchSets=new Map();
    invalidateSimulationFrame();
    ui.simulationError.hidden = true;
    ui.simulationDock.hidden = true;
  }

function isWatched(key) { return runState.watchKeys.has(key); }

function toggleWatch(key) {
    if (isWatched(key)) runState.watchKeys.delete(key);
    else if (runState.watchKeys.size < 12) runState.watchKeys.add(key);
    else ports.showToast("最多同时观察 12 个端口");
    renderSimulation(true);
    return isWatched(key);
  }

function pressButton(id) {
    if (!activeObservation()) return;
    releaseButton();
    const held = {id, session: runState.simulation.session.id, viewId:runState.displayedView?.id};
    runState.heldButton = held;
    held.pressed = simulationAction("button", {componentId: id, value: "1"});
  }

function activeObservation() {
    const s = runState.simulation;
    return s?.session?.projectId === projectState.session?.workspace?.id && s?.session?.revisionId === projectState.revision && s.observation?.circuit === projectState.circuitName && s.view?.id === runState.displayedView?.id && s.observation?.viewId === runState.displayedView?.id ? s.observation : null;
  }

function displayedSimulationView() {
    const s=runState.simulation,view=runState.displayedView;
    return s?.session&&view&&s.session.projectId===projectState.session?.workspace?.id&&s.session.revisionId===projectState.revision&&view.circuit===projectState.circuitName&&view.id===s.view?.id
      ? structuredClone(view) : null;
  }

function prepareCircuitNavigation(name,navigation) {
    if(navigation.runtimeView)runState.displayedView=structuredClone(navigation.runtimeView);
    else if(navigation.kind!=='refresh'||runState.displayedView?.circuit!==name)runState.displayedView=null;
    if(projectState.circuit)renderSimulation(true);
  }

async function activateSimulationView(instancePath) {
    if(runState.simulationViewBusy)return null;
    runState.simulationViewBusy=true;renderSimulation();
    try{
      await releaseButton();
      const result=await simulationAction('view',{instancePath});
      return result?structuredClone(result.view):null;
    }finally{runState.simulationViewBusy=false;renderSimulation();}
  }

function updateLiveValues() {
    const sample = activeObservation();
    const values = new Map((sample?.components || []).flatMap(c => c.ports.map(p => [`${c.componentId}:${p.index}`, p])));
    document.querySelectorAll("[data-live-port]").forEach(node => {
      const port = values.get(node.dataset.livePort), value = formatSignal(port);
      node.dataset.changed = String(node.textContent !== "—" && node.textContent !== value);
      node.dataset.unknown = String(port?.value === null);
      node.textContent = value;
      node.title = port ? `${port.bits} · ${port.width} bit` : "此电路当前没有运行状态";
    });
    document.querySelectorAll("[data-live-input]").forEach(node => {
      if (node !== document.activeElement && !node.disabled && node.value === node.dataset.committed) {
        const id = node.dataset.liveInput.split(":")[0];
        const c = sample?.components.find(c => c.componentId === id);
        const value = formatInput(c?.input || values.get(node.dataset.liveInput));
        node.value = value; node.dataset.committed = value;
      }
    });
  }

function pokeComponent(component, point = null) {
    if (["RAM", "ROM"].includes(component.factory)) { ports.openMemory(component); return; }
    const c = activeObservation()?.components.find(c => c.componentId === component.componentId);
    if (!c?.control) return;
    if(c.control==='parent-input'){ports.showToast('此输入由父电路驱动，请返回父图调整');return;}
    if (c.control === "pulse") simulationAction("pulse", {componentId: c.componentId});
    else if (point || c.control === "clock" || c.ports[0]?.width === 1) {
      const b = component.bounds;
      const at = point || {x: b.x + b.width / 2, y: b.y + b.height / 2};
      simulationAction("poke", {componentId: c.componentId, x: at.x, y: at.y});
    }
    else ui.objectInspector.querySelector('[aria-label="输入值"]')?.focus();
  }

function releaseButton() {
    const held = runState.heldButton; runState.heldButton = null;
    if (held) return held.pressed.then(ok => {
      const release = () => {
        if (!ok || runState.simulation?.session?.id !== held.session) return;
        return simulationAction("button", {componentId: held.id, value: "0",viewId:held.viewId});
      };
      return release();
    });
  }

function simulationAction(action, extra = {}) {
    if (!projectState.session?.workspace) return Promise.resolve(false);
    const lifecycle = action === "start" || action === "stop";
    if (lifecycle && runState.simulationBusy) return Promise.resolve(false);
    const context = {projectId: projectState.session.workspace.id, revisionId: projectState.revision,
      sessionId: runState.simulation?.session?.id, circuit: projectState.circuitName, viewId:runState.simulation?.view?.id};
    if (lifecycle) {
      runState.simulationBusy = true; runState.simulationBusyAction = action; runState.simulationEpoch++;
      // A poll for the previous run may still be decoding its frame. It must
      // neither block this run's polls nor clear a newer poll's in-flight flag.
      pollingToken++; runState.simulationPolling = false;
      renderSimulation();
    }
    const epoch = runState.simulationEpoch;
    const isCurrent = () => epoch === runState.simulationEpoch
      && context.projectId === projectState.session?.workspace?.id
      && context.revisionId === projectState.revision
      && (action !== 'viewport' || context.viewId === runState.simulation?.view?.id);
    const execute = async () => {
      try {
        if (context.revisionId !== projectState.revision || context.projectId !== projectState.session?.workspace?.id ||
            (action !== "start" && context.sessionId !== runState.simulation?.session?.id) ||
            (action === "viewport" && context.viewId !== runState.simulation?.view?.id)) return false;
        const result = await request("/api/simulation", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({...context, action, ...extra}) });
        if (!isCurrent()) return false;
        await acceptSimulation(result, epoch);
        if(action==='start'&&isCurrent()){
          if(context.circuit===projectState.circuitName){runState.displayedView=structuredClone(result.view);ports.runtimeNavigationStarted();}
          renderSimulation();ports.renderInspector();
        }
        if (!isCurrent()) return false;
        runState.simulationPendingSequence = Math.max(runState.simulationPendingSequence, result.commandSequence || 0);
        ui.simulationError.hidden = true;
        return result;
      } catch (error) { if (action !== "viewport" && isCurrent()) { ui.simulationError.textContent = error.message; ui.simulationError.hidden = false; } return false; }
      finally { if (isCurrent()) { if (lifecycle) runState.simulationBusy = false; renderSimulation(); void pollSimulation(true); } }
    };
    // Ordered commands, not a busy flag that discards the next click.
    const promise = runState.simulationQueue.then(execute, execute);
    runState.simulationQueue = promise.catch(() => false);
    return promise.then(async result => {
      if (!result) return false;
      if(action==='view')return result;
      // Wait outside the command queue: opening RAM cannot hold up button release.
      if (action === "memory" || action === "memory-write") {
        const deadline = performance.now() + 10000;
        while (runState.simulation?.session?.id === context.sessionId &&
               (activeObservation()?.commandSequence || 0) < result.commandSequence) {
          if (performance.now() > deadline || epoch !== runState.simulationEpoch || context.revisionId !== projectState.revision || context.circuit !== projectState.circuitName) return false;
          await pollSimulation(true);
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        return runState.simulation?.session?.id === context.sessionId;
      }
      return true;
    });
  }

async function acceptSimulation(result, epoch) {
    const previous = Boolean(activeObservation()), session = result.session;
    if (session && (session.revisionId !== projectState.revision || session.projectId !== projectState.session?.workspace?.id)) return;
    const sample = result.observation;
    if (sample?.render?.url) {
      const decoded = new Image(); decoded.src = sample.render.url;
      await decoded.decode();
    }
    if (epoch !== runState.simulationEpoch || (session && (session.revisionId !== projectState.revision || session.projectId !== projectState.session?.workspace?.id))) return;
    const same = session?.id === runState.simulation?.session?.id;
    const current = runState.simulation || {};
    const controls = !same || (result.commandSequence || 0) >= (current.commandSequence || 0) ? result : current;
    const observation = sample && (!same || sample.sequence > (current.observation?.sequence || 0)) ? sample : same ? current.observation : null;
    runState.simulation = {...controls, session, observation: session ? observation : null};
    if(!session)runState.displayedView=null;
    if (!same) runState.simulationPendingSequence = 0;
    renderSimulation();
    if (previous !== Boolean(activeObservation())) ports.renderInspector();
  }

async function pollSimulation(force = false) {
    if (runState.simulationPolling || runState.simulationBusy || !projectState.session?.workspace || document.hidden) return;
    const pending = runState.simulationPendingSequence > (runState.simulation?.observation?.commandSequence || 0);
    if (!force && !pending && !runState.simulation?.running && performance.now() - runState.simulationLastPoll < 750) return;
    runState.simulationPolling = true;
    const token = ++pollingToken;
    runState.simulationLastPoll = performance.now();
    const epoch = runState.simulationEpoch, revision = projectState.revision, projectId = projectState.session.workspace.id;
    const isCurrent = () => epoch === runState.simulationEpoch && revision === projectState.revision && projectId === projectState.session?.workspace?.id;
    try {
      const result = await request(`/api/simulation?since=${encodeURIComponent(runState.simulation?.observation?.id || "")}`);
      if (isCurrent()) await acceptSimulation(result, epoch);
    } catch (error) {
      if (isCurrent()) { ui.simulationError.textContent = `无法读取运行状态：${error.message}`; ui.simulationError.hidden = false; renderSimulation(); }
    } finally { if (token === pollingToken) runState.simulationPolling = false; }
  }

function renderSimulation(force = false) {
    const sim = runState.simulation, sample = activeObservation(), live = Boolean(sample);
    ports.renderSimulationControls();
    if (!projectState.circuit) { ui.simulationDock.hidden = true; return; }
    const watchScope=JSON.stringify([projectState.session?.workspace?.id,projectState.revision,sim?.session?.id,projectState.circuitName,displayedSimulationView()?.instancePath||null]);
    if (runState.watchCircuit !== watchScope) {
      runState.watchSets??=new Map();
      if(runState.watchCircuit)runState.watchSets.set(runState.watchCircuit,new Set(runState.watchKeys));
      runState.watchCircuit = watchScope;
      runState.watchKeys = new Set(runState.watchSets.get(watchScope)||[]);
      while(runState.watchSets.size>64)runState.watchSets.delete(runState.watchSets.keys().next().value);
      force = true;
    }
    ports.setRenderingLive(live);
    ports.renderNavigation();
    ports.updateMomentCapture();
    if (sim?.reason) { ui.simulationError.textContent = sim.reason; ui.simulationError.hidden = false; }
    const frame = sample?.id || `${projectState.revision}:${projectState.circuitName}:static`;
    if (frame !== runState.simulationFrame || force) {
      runState.simulationFrame = frame;
      const render = sample?.render || projectState.circuit.render;
      if (render) {
        let image = ui.runtimeLayer.querySelector("image");
        if (!image) { image = makeSvg("image"); ui.runtimeLayer.replaceChildren(image); }
        for (const [name, value] of Object.entries({href: render.url, ...render.bounds, preserveAspectRatio:'none'})) {
          if (image.getAttribute(name) !== String(value)) image.setAttribute(name, value);
        }
        ui.runtimeLayer.dataset.observationId = sample?.id || "";
        ui.runtimeLayer.dataset.commandSequence = sample?.commandSequence || "";
        ui.runtimeLayer.dataset.scale = render.scale || '';
        ui.runtimeLayer.dataset.pixelWidth = render.pixelWidth || '';
        ui.runtimeLayer.dataset.pixelHeight = render.pixelHeight || '';
      }
      ui.simulationWatches.hidden = !live || !runState.watchKeys.size;
      const watchSignature = `${runState.watchCircuit}:${[...runState.watchKeys].join(",")}:${live}`;
      if (ui.simulationWatches.dataset.signature !== watchSignature) {
      ui.simulationWatches.dataset.signature = watchSignature;
      ui.simulationWatches.replaceChildren();
      for (const key of runState.watchKeys) {
        const [id, index] = key.split(":");
        const c = sample?.components.find(c => c.componentId === id);
        if (!c) continue;
        const watch = makeElement("button", "signal-watch");
        const caption = `${c.label || c.factory}${Number(index) ? ` · ${index}` : ""}`;
        watch.setAttribute("aria-label", `定位 ${caption}`);
        const value = makeElement("strong", "", "—"); value.dataset.livePort = key;
        watch.append(makeElement("span", "", caption), value);
        watch.addEventListener("click", () => { ports.selectComponent(id, false); ports.switchReviewTab("evidence"); ports.openReviewPanel(); });
        ui.simulationWatches.append(watch);
      }
      }
      updateLiveValues();
      ports.updateMemoryFromSimulation();
    }
    ui.simulationDock.hidden = ui.simulationWatches.hidden && ui.simulationError.hidden;
  }
async function returnToSimulation() {
  const view=await activateSimulationView(runState.simulation?.view?.instancePath||[]);
  if(view)await ports.loadCircuit(view.circuit,{navigation:{kind:'runtime-return',runtimeView:view}});
}
function mountSimulationRuntime() {
setInterval(pollSimulation, 60);
window.addEventListener("blur", releaseButton);
document.addEventListener("pointerup", releaseButton);
document.addEventListener("visibilitychange", () => { if (document.hidden) releaseButton(); });
}

function configureSimulationViewport({sessionId,viewId,viewport}) {
  const sample=activeObservation();
  if(!sample || sample.sessionId!==sessionId || sample.viewId!==viewId)return Promise.resolve(false);
  return simulationAction('viewport',{viewport});
}

  return Object.freeze({configureSimulationViewport,runningInstance:()=>({session:structuredClone(runState.simulation?.session||null),view:displayedSimulationView()}),watchedSignals:()=>[...runState.watchKeys],displayedSimulationView,prepareCircuitNavigation,activateSimulationView,simulationStatus, invalidateSimulation, invalidateSimulationFrame, isWatched, toggleWatch, pressButton, mountSimulationRuntime, returnToSimulation, activeObservation, updateLiveValues, pokeComponent, releaseButton, simulationAction, acceptSimulation, pollSimulation, renderSimulation});
}
