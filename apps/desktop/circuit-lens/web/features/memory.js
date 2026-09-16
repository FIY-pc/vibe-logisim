import { makeElement } from '../core/dom.js';

export const modelDependencies = ["project", "memory"];

export const dependencies = ["captureViewport","restoreViewport","selectComponent","focusReferences","simulationStatus","activeObservation","closeMobilePanels","editObject","fitCircuit","simulationAction"];

export function createController({models, ui, client, ports}) {
  const {project: projectState, memory: memoryState} = models;
  const request = client.request;
function closeMemory() {
    const m = memoryState.memory;
    if (m?.viewport && m.projectId === projectState.session?.workspace?.id && m.circuit === projectState.circuitName && m.revision === projectState.revision) {
      ports.restoreViewport(m.viewport);
    }
    memoryState.memory = null; ui.memoryPanel.hidden = true;
    ui.canvasStage.style.setProperty("--memory-height", "0px");
  }

async function openMemory(component, {viewport, offset = 0} = {}) {
    const m = {component, projectId: projectState.session?.workspace?.id, circuit: projectState.circuitName, revision: projectState.revision, offset: 0, page: null, editing: false, busy: false,
      viewport: viewport || memoryState.memory?.viewport || ports.captureViewport()};
    memoryState.memory = m;
    ui.memoryOwner.textContent = `${m.circuit} › ${component.label || component.factory}`;
    ui.memoryOwner.title = `${component.factory} · (${component.location.x}, ${component.location.y}) · 定位对象`;
    ui.memoryKind.textContent = component.factory === "ROM" ? "ROM · 工程内容" : "RAM · 运行内容";
    ui.memoryPanel.hidden = false; ports.closeMobilePanels();
    requestAnimationFrame(() => {
      if (memoryState.memory !== m) return;
      ui.canvasStage.style.setProperty("--memory-height", `${ui.memoryPanel.offsetHeight + 8}px`);
      const bounds = component.bounds;
      if (bounds) ports.fitCircuit({x: bounds.x - 70, y: bounds.y - 65, width: bounds.width + 140, height: bounds.height + 130});
    });
    ui.memoryError.hidden = true; ui.memorySelection.textContent = "选择一个存储单元";
    ui.memoryContent.replaceChildren(); ui.memoryState.textContent = ""; ui.memoryGeometry.textContent = "";
    if (component.factory === "RAM" && !ports.activeObservation()) {
      const empty = makeElement("div", "memory-empty");
      empty.append(makeElement("p", "", "RAM 内容属于运行实例。"));
      const start = makeElement("button", "bar-button", "启动此电路的仿真");
      start.addEventListener("click", async () => {
        start.disabled = true;
        if (await ports.simulationAction("start")) await readMemory(0);
        start.disabled = false;
      });
      empty.append(start); ui.memoryContent.append(empty);
      return;
    }
    await readMemory(offset);
  }

async function readMemory(offset) {
    const m = memoryState.memory;
    if (!m || m.busy) return;
    const length = m.page?.length || 2 ** Number(m.component.attributes.addrWidth);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= length) {
      ui.memoryError.textContent = "地址超出存储器范围"; ui.memoryError.hidden = false; return;
    }
    m.busy = true; m.editing = false; ui.memoryError.hidden = true; ui.memoryState.textContent = "读取中…";
    try {
      let page;
      if (m.component.factory === "RAM") {
        if (!ports.activeObservation()) throw new Error("此运行实例已结束，请重新打开 RAM。");
        const ok = await ports.simulationAction("memory", {componentId: m.component.componentId, offset, count: 64});
        if (!ok) throw new Error("未能读取 RAM，请检查运行状态。");
        page = ports.activeObservation()?.memory;
      } else page = await request("/api/memory", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({
        projectId: m.projectId, revisionId: m.revision, circuit: m.circuit, componentId: m.component.componentId, offset})});
      if (memoryState.memory !== m) return;
      if (!page || page.componentId !== m.component.componentId || page.offset !== offset) throw new Error("内存页不属于当前对象。");
      m.page = page; m.offset = offset; m.busy = false; renderMemory();
    } catch (error) {
      if (memoryState.memory === m) { ui.memoryError.textContent = error.message; ui.memoryError.hidden = false; ui.memoryState.textContent = "读取失败"; }
    } finally { m.busy = false; }
  }

function updateMemoryFromSimulation() {
    const m = memoryState.memory;
    if (!m || m.component.factory !== "RAM" || m.busy) return;
    const page = ports.activeObservation()?.memory;
    if (!ports.activeObservation()) { ui.memoryState.textContent = "运行已结束 · 内容已失效"; ui.memoryContent.querySelectorAll("input").forEach(i => { i.disabled = true; }); return; }
    if (page?.componentId === m.component.componentId && page.offset === m.offset) {
      m.page = page;
      if (!m.editing) renderMemory();
    }
  }

function renderMemory() {
    const m = memoryState.memory, page = m?.page;
    if (!page) return;
    const hex = (n, bits) => n.toString(16).toUpperCase().padStart(Math.ceil(bits / 4), "0");
    ui.memoryAddress.value = hex(m.offset, page.addressBits);
    ui.memoryGeometry.textContent = `${page.length.toLocaleString()} 字 × ${page.dataBits} bit`;
    ui.memoryPrev.disabled = m.offset === 0; ui.memoryNext.disabled = m.offset + 64 >= page.length;
    ui.memoryState.textContent = page.storage === "design" ? (projectState.session.workspace.dirty ? "工程未保存" : "工程已保存") : `${ports.simulationStatus()?.running ? "运行中" : "已暂停"} · ${ports.activeObservation()?.ticks ?? "—"} tick`;
    const table = makeElement("table", "memory-grid"); table.setAttribute("aria-label", `${m.component.label || m.component.factory} 字地址与数据`);
    const columns = ui.memoryPanel.clientWidth < 740 ? 4 : 8;
    const head = makeElement("thead"), titles = makeElement("tr"); titles.append(makeElement("th", "", "字地址"));
    for (let i = 0; i < columns; i++) titles.append(makeElement("th", "", `+${i.toString(16).toUpperCase()}`));
    head.append(titles); table.append(head);
    const body = makeElement("tbody"); let row;
    const previous = m.displayed || new Map(); m.displayed = new Map();
    for (const [index, word] of page.words.entries()) {
      if (index % columns === 0) { row = makeElement("tr"); row.append(makeElement("th", "", hex(word.address, page.addressBits))); body.append(row); }
      const cell = makeElement("td"), input = makeElement("input");
      const initial = hex(word.value, page.dataBits);
      input.value = initial; input.dataset.address = word.address; input.spellcheck = false;
      input.setAttribute("aria-label", `地址 ${hex(word.address, page.addressBits)}`);
      input.title = `0x${hex(word.address, page.addressBits)} · ${word.value} · ${page.dataBits} bit · Enter 确认，Esc 取消`;
      input.dataset.changed = String(previous.has(word.address) && previous.get(word.address) !== word.value);
      m.displayed.set(word.address, word.value);
      input.addEventListener("focus", () => {
        m.editing = true; input.select();
        ui.memorySelection.textContent = `0x${hex(word.address, page.addressBits)}　${word.value.toLocaleString()}　${page.dataBits} bit`;
      });
      input.addEventListener("blur", () => { input.value = initial; m.editing = false; });
      input.addEventListener("keydown", async event => {
        if (event.key === "Escape") { event.stopPropagation(); input.value = initial; input.blur(); return; }
        const delta = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns}[event.key];
        if (delta && input.value === initial) {
          event.preventDefault(); table.querySelector(`[data-address="${word.address + delta}"]`)?.focus(); return;
        }
        if (event.key !== "Enter") return;
        event.preventDefault(); event.stopPropagation();
        const value = input.value.trim().replace(/^0x/i, "");
        if (!/^[0-9a-f]+$/i.test(value) || BigInt(`0x${value}`) >= (1n << BigInt(page.dataBits))) {
          ui.memoryError.textContent = `请输入 ${page.dataBits} 位以内的十六进制数据`; ui.memoryError.hidden = false; return;
        }
        if (Number.parseInt(value, 16) === word.value) { table.querySelector(`[data-address="${word.address + 1}"]`)?.focus(); return; }
        m.busy = true; input.disabled = true; ui.memoryError.hidden = true;
        try {
          if (page.storage === "runtime") {
            const ok = await ports.simulationAction("memory-write", {componentId: m.component.componentId, offset: m.offset, count: 64,
              address: word.address, expected: initial, value});
            if (!ok) throw new Error("写入未成功；若内容已变化，请刷新后再编辑。");
            if (memoryState.memory !== m) return;
            m.page = ports.activeObservation().memory; m.busy = false; m.editing = false; renderMemory();
          } else {
            const ok = await ports.editObject(m.component, {attribute: "contents", address: word.address, expected: initial, value});
            if (!ok) throw new Error("ROM 写入未成功，工程未改变。");
            const c = projectState.circuit.components.find(c => c.factory === m.component.factory && c.location.x === m.component.location.x && c.location.y === m.component.location.y);
            if (!c || m.projectId !== projectState.session?.workspace?.id || m.circuit !== projectState.circuitName) return;
            await openMemory(c, {viewport: m.viewport, offset: m.offset});
          }
          ui.memoryContent.querySelector(`[data-address="${word.address + 1}"]`)?.focus();
        } catch (e) { ui.memoryError.textContent = e.message; ui.memoryError.hidden = false; input.disabled = false; }
        finally { m.busy = false; }
      });
      cell.append(input); row.append(cell);
    }
    table.append(body); const scroll = ui.memoryContent.scrollTop;
    ui.memoryContent.replaceChildren(table); ui.memoryContent.scrollTop = scroll;
  }
function mountMemoryControls() {
ui.memoryClose.addEventListener("click", closeMemory);
ui.memoryOwner.addEventListener("click", () => { if (memoryState.memory) { ports.selectComponent(memoryState.memory.component.componentId); ports.focusReferences(new Set([memoryState.memory.component.componentId])); } });
ui.memoryJump.addEventListener("submit", e => { e.preventDefault(); const raw = ui.memoryAddress.value.trim().replace(/^0x/i, ""); readMemory(/^[0-9a-f]+$/i.test(raw) ? Number.parseInt(raw, 16) : NaN); });
ui.memoryPrev.addEventListener("click", () => readMemory(Math.max(0, memoryState.memory.offset - 64)));
ui.memoryNext.addEventListener("click", () => readMemory(memoryState.memory.offset + 64));
ui.memoryRefresh.addEventListener("click", () => readMemory(memoryState.memory?.offset || 0));
new ResizeObserver(() => {
    ui.canvasStage.style.setProperty("--memory-height", `${ui.memoryPanel.hidden ? 0 : ui.memoryPanel.offsetHeight + 8}px`);
  }).observe(ui.memoryPanel);
}

  return Object.freeze({mountMemoryControls, closeMemory, openMemory, readMemory, updateMemoryFromSimulation, renderMemory});
}
