import {makeSvg} from '../core/dom.js';

export const modelDependencies = ['project'];
export const dependencies = ['activeObservation', 'configureSimulationViewport'];

export function createController({models, ui, ports}) {
  const {project} = models;
  let epoch = 0, timer, pending = null, wanted = null, shown = null, failed = null;
  let live = false, imageUrl = null, mounted = false;
  let staticFrame = null;

  function clearDetail() {
    ui.detailLayer.replaceChildren();
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = null; shown = null;
  }

  function resetRendering() {
    epoch++; clearTimeout(timer); wanted = null; failed = null;
    pending?.abort(); clearDetail(); ui.renderStatus.hidden = true;
  }

  function viewRequest({render = project.circuit?.render, observation = ports.activeObservation(),
    revision = project.revision, circuit = project.circuitName, staticOnly = false} = {}) {
    if (!render?.viewportUrl || render.revisionId !== revision) return null;
    const svg = ui.circuitCanvas, rect = svg.getBoundingClientRect(), matrix = svg.getScreenCTM();
    if (!matrix || !rect.width || !rect.height) return null;
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    if (!observation && matrix.a * ratio <= render.scale * 1.03) return null;
    const a = new DOMPoint(rect.left, rect.top).matrixTransform(matrix.inverse());
    const b = new DOMPoint(rect.right, rect.bottom).matrixTransform(matrix.inverse());
    const margin = 64 / matrix.a;
    const bounds = {x:Math.floor(a.x-margin), y:Math.floor(a.y-margin),
      width:Math.ceil(b.x-a.x+margin*2)+1, height:Math.ceil(b.y-a.y+margin*2)+1};
    // Bound both pixel dimensions and area; this is resolution, never topology.
    const scale = Math.min(matrix.a*ratio, 32, 4095/bounds.width, 4095/bounds.height,
      Math.sqrt(7_900_000/(bounds.width*bounds.height)));
    if (!observation && scale <= render.scale) return null;
    if (observation) return {bounds,scale,live:true,sessionId:observation.sessionId,viewId:observation.viewId,
      projectId:project.session?.workspace?.id,circuit:project.circuitName,revision:project.revision,
      key:JSON.stringify([observation.sessionId,observation.viewId,bounds,scale])};
    if (live && !staticOnly) return null;
    const query = new URLSearchParams({revisionId:revision, profileId:render.profileId,
      name:circuit, ...bounds, scale});
    const url = `${render.viewportUrl}?${query}`;
    return {bounds, scale, url, key:`${project.session?.workspace?.id}:${url}`,
      projectId:project.session?.workspace?.id, circuit, revision};
  }

  async function decodeImage(url, signal) {
    const response = await fetch(url, {signal});
    if (!response.ok) throw new Error(`电路图像不可用（${response.status}）`);
    const objectUrl = URL.createObjectURL(await response.blob());
    const decoded = new Image(); decoded.src = objectUrl;
    try { await decoded.decode(); return {url:objectUrl, width:decoded.naturalWidth, height:decoded.naturalHeight}; }
    catch (error) { URL.revokeObjectURL(objectUrl); throw error; }
  }

  // A document edit keeps its previous artwork and provisional components until
  // both replacement resolutions can be presented in the same browser frame.
  async function prepareCircuitRendering(circuit, {revision, preserveCamera = false}) {
    if (!circuit.render) return null;
    const projectId = project.session?.workspace?.id;
    const detail = preserveCamera ? viewRequest({render:circuit.render, observation:null, revision,
      circuit:circuit.name, staticOnly:true}) : null;
    const results = await Promise.allSettled([decodeImage(circuit.render.url), detail ? decodeImage(detail.url) : null]);
    if (results.some(result => result.status === 'rejected')) {
      for (const result of results) if (result.status === 'fulfilled' && result.value) URL.revokeObjectURL(result.value.url);
      throw results.find(result => result.status === 'rejected').reason;
    }
    return {projectId, revision, circuit:circuit.name,
      base:{...circuit.render, url:results[0].value.url}, detail:detail && {...detail, image:results[1].value}};
  }

  function discardCircuitRendering(frame) {
    if (frame?.base) URL.revokeObjectURL(frame.base.url);
    if (frame?.detail) URL.revokeObjectURL(frame.detail.image.url);
  }

  function detailNode(request, decoded) {
    return makeSvg('image', {href:decoded.url, ...request.bounds,
      width:decoded.width/request.scale, height:decoded.height/request.scale, preserveAspectRatio:'none',
      'data-circuit':request.circuit, 'data-revision':request.revision, 'data-scale':request.scale,
      'data-pixel-width':decoded.width, 'data-pixel-height':decoded.height});
  }

  function commitCircuitRendering(frame) {
    resetRendering();
    if (staticFrame) URL.revokeObjectURL(staticFrame.base.url);
    staticFrame = frame; live = false;
    ui.runtimeLayer.replaceChildren();
    if (!frame) return;
    ui.runtimeLayer.append(makeSvg('image', {href:frame.base.url, ...frame.base.bounds, preserveAspectRatio:'none'}));
    if (frame.detail) {
      imageUrl = frame.detail.image.url;
      ui.detailLayer.append(detailNode(frame.detail, frame.detail.image)); shown = frame.detail.key;
      frame.detail = null; // Detail lifetime is now owned by clearDetail().
    }
  }

  function staticCircuitRender() {
    return staticFrame?.projectId === project.session?.workspace?.id && staticFrame.revision === project.circuit?.render?.revisionId &&
      staticFrame.circuit === project.circuitName ? staticFrame.base : project.circuit?.render;
  }

  function scheduleRendering() {
    wanted = viewRequest(); clearTimeout(timer);
    if (!wanted) {if (!project.projectBusy) clearDetail(); ui.renderStatus.hidden = true; return;}
    if (wanted.key === shown) {ui.renderStatus.hidden = true; return;}
    if (wanted.key === failed) return;
    ui.renderStatus.hidden = true;
    timer = setTimeout(draw, 100);
  }

  async function draw() {
    if (pending || !wanted || wanted.key === shown || wanted.key === failed) return;
    const request = wanted, generation = epoch, controller = new AbortController();
    pending = controller;
    const isCurrent = () => generation === epoch && wanted?.key === request.key &&
      project.session?.workspace?.id === request.projectId && project.revision === request.revision &&
      project.circuitName === request.circuit && (request.live
        ? ports.activeObservation()?.sessionId===request.sessionId && ports.activeObservation()?.viewId===request.viewId
        : !ports.activeObservation());
    const loading = setTimeout(() => {
      if (!isCurrent()) return;
      ui.renderStatus.textContent = '正在细化画面…'; ui.renderStatus.disabled = true; ui.renderStatus.hidden = false;
    }, 350);
    let nextUrl;
    try {
      if (request.live) {
        const ok=await ports.configureSimulationViewport({sessionId:request.sessionId,viewId:request.viewId,
          viewport:{...request.bounds,scale:request.scale}});
        if(!isCurrent())return;
        if(!ok)throw new Error('运行画面未能调整到当前视野');
        // The next native frame carries both the new viewport and its port
        // values. Never cover a running circuit with a static detail image.
        shown=request.key;failed=null;ui.renderStatus.hidden=true;
        return;
      }
      const decoded = await decodeImage(request.url, controller.signal);
      nextUrl = decoded.url;
      if (!isCurrent()) return;
      const node = detailNode(request, decoded);
      clearDetail(); imageUrl = nextUrl; nextUrl = null;
      ui.detailLayer.append(node); shown = request.key; failed = null;
      ui.renderStatus.hidden = true;
    } catch (error) {
      if (error.name !== 'AbortError' && isCurrent()) {
        failed = request.key;
        ui.renderStatus.textContent = '细节未加载 · 重试'; ui.renderStatus.title = error.message;
        ui.renderStatus.disabled = false; ui.renderStatus.hidden = false;
      }
    } finally {
      clearTimeout(loading);
      if (nextUrl) URL.revokeObjectURL(nextUrl);
      if (pending === controller) pending = null;
      // Discard intermediate views and render only the last requested viewport.
      scheduleRendering();
    }
  }

  function setRenderingLive(value) {
    if (live === value) return;
    live = value; resetRendering(); scheduleRendering();
  }

  function mountRendering() {
    if (mounted) return; mounted = true;
    new ResizeObserver(scheduleRendering).observe(ui.circuitCanvas);
    let resolution, density;
    const watchResolution=()=>{
      resolution?.removeEventListener('change',watchResolution);
      // Chromium can report 1.50000004 while CSS resolution is 1.5. An exact
      // query is then false both before and after moving displays, so it never
      // emits a change. A small range reliably matches the current display.
      const ratio=window.devicePixelRatio || 1;
      density=ratio;
      resolution=matchMedia(`(min-resolution: ${ratio*.999}dppx) and (max-resolution: ${ratio*1.001}dppx)`);
      resolution.addEventListener('change',watchResolution,{once:true});
      scheduleRendering();
    };
    watchResolution();
    // Electron can change physical pixel density without changing CSS size;
    // that emits window resize even when ResizeObserver/media listeners do not.
    window.addEventListener('resize',watchResolution);
    // Some Electron display changes emit neither event. This only reads one
    // number; layout and native drawing are requested only when it changes.
    const densityTimer=setInterval(()=>{
      if(!document.hidden && window.devicePixelRatio!==density)watchResolution();
    },250);
    ui.renderStatus.addEventListener('click', () => {failed = null; scheduleRendering();});
    window.addEventListener('pagehide', () => {clearInterval(densityTimer);resetRendering();});
  }
  return Object.freeze({prepareCircuitRendering, discardCircuitRendering, commitCircuitRendering, staticCircuitRender,
    resetRendering, scheduleRendering, setRenderingLive, mountRendering});
}
