import {inputControl} from '../core/simulation-inputs.js';
import {propertyLabels as labels,optionLabels} from '../core/component-labels.js';
import {portName} from '../core/connection-values.js';
import { componentId, displayName, firstDefined, formatInput } from '../core/values.js';
import { makeElement } from '../core/dom.js';

export const modelDependencies = ["project", "agent"];

export const dependencies = ["setInputValue","renderPlacementInspector","appendDraftText","openInterfaces","selectionSnapshot","captureViewport","restoreViewport","isWatched","toggleWatch","activeObservation","enterCircuit","openMemory","openReviewPanel","performProjectAction","resizeQuestion","selectComponent","showToast","simulationAction","switchReviewTab","updateComposerState","updateLiveValues"];

export function createController({models, ui, client, ports}) {
  const {project: projectState, agent: agentState} = models;
  let appearanceOpen=false;
function renderInspector() {
    if (ports.renderPlacementInspector()) return;
    ui.objectInspector.replaceChildren();
    if (!projectState.circuit) return;
    const selection = ports.selectionSnapshot();
    const selected = projectState.circuit.components.filter((c, i) => selection.componentIds.includes(componentId(c, i)));
    const wires = projectState.circuit.wires.filter(w => selection.wireIds.includes(w.wireId));
    const hasSelection = selected.length || wires.length;
    if (!hasSelection) {
      ui.objectInspector.append(makeElement("p", "", "选择元件或导线以查看属性"));
      ports.updateLiveValues();
      return;
    }
    const component = selected.length === 1 && !wires.length ? selected[0] : null;
    const title = component ? component.label || component.factory : [selected.length && `${selected.length} 个元件`, wires.length && `${wires.length} 段导线`].filter(Boolean).join(" · ");
    ui.objectInspector.append(makeElement("h2", "", title));
    const subtitle = component ? `${projectState.circuitName} › ${component.factory} · (${component.location.x}, ${component.location.y})` : "拖动整理，Shift 点击增减选择";
    const description=makeElement("p", "", component ? ({Pin:"引脚",Register:"寄存器",ROM:"只读存储器",RAM:"存储器",Tunnel:"隧道",Multiplexer:"多路选择器",Text:"文字"}[component.factory]||component.factory) : subtitle);
    ui.objectInspector.querySelector('h2').title=subtitle;
    if(description.textContent!==title)ui.objectInspector.append(description);
    if (component) renderPropertyEditor(component);
    if (wires.length) {
      const list = makeElement("div", "selected-wire-details");
      for (const wire of wires.slice(0, 8)) {
        const bundle = projectState.circuit.bundles?.find(b => b.bundleId === wire.bundleId);
        list.append(makeElement("p", "", `(${wire.from.x}, ${wire.from.y}) → (${wire.to.x}, ${wire.to.y})${bundle?.bitNets?.length ? ` · ${bundle.bitNets.length} bit` : ""}`));
      }
      if (wires.length > 8) list.append(makeElement("p", "", `另有 ${wires.length - 8} 段导线`));
      ui.objectInspector.append(list);
    }
    const actions = makeElement("div", "inspector-actions");
    const child = component && (component.subcircuit || (projectState.circuits.some(c => displayName(c) === component.factory) ? component.factory : null));
    if (child) {
      const enter = makeElement("button", "", "进入子电路");
      enter.addEventListener("click", () => ports.enterCircuit(component)); actions.append(enter);
      const symbol=makeElement("button", "", "编辑封装与接口");symbol.addEventListener("click",()=>ports.openInterfaces(child));actions.append(symbol);
    }
    if (agentState.enabled && hasSelection) {
      const explain = makeElement("button", "", "解释选中对象");
      explain.addEventListener("click", () => draftPrompt(`解释${hasSelection ? "选中的对象及其连接" : "当前电路"}，并查看它与上层电路的关系。`)); actions.append(explain);
    }
    if (component && component.ends?.length) {
      const table = makeElement("table", "pin-table");
      const live=Boolean(ports.activeObservation());
      const head = makeElement("tr"); ["接口", "位宽", ...(live?["运行值", ""]:[])].forEach(t => head.append(makeElement("th", "", t))); table.append(head);
      component.ends.forEach((end, i) => {
        const row = makeElement("tr");
        const label = makeElement("td", "", portName(component,end,i));
        label.title = end.runtimeTooltip || '';
        row.append(label, makeElement("td", "", firstDefined(end.width, end.bitWidth, "?")));
        const value = makeElement("td", "live-value", "—");
        value.dataset.livePort = `${component.componentId}:${i}`;
        const watchCell = makeElement("td");
        const watch = makeElement("button", "pin-watch-button", "◉");
        watch.setAttribute("aria-label", `观察端口 ${i}`);
        watch.setAttribute("aria-pressed", String(ports.isWatched(value.dataset.livePort)));
        watch.addEventListener("click", () => {
          const key = value.dataset.livePort;
          watch.setAttribute("aria-pressed", String(ports.toggleWatch(key)));
        });
        watchCell.append(watch); if(live)row.append(value, watchCell);
        table.append(row);
      });
      ui.objectInspector.append(table);
    }
    if (actions.children.length) ui.objectInspector.append(actions);
    const appearance=ui.objectInspector.querySelector(".appearance-properties");
    if(appearance)ui.objectInspector.append(appearance);
    ports.updateLiveValues();
  }

function renderPropertyEditor(component) {
    const live = ports.activeObservation()?.components.find(c => c.componentId === component.componentId);
    let destination=ui.objectInspector;
    function field(label, initial, commit, options, readOnly = false) {
      const form = makeElement("form", "property-editor");
      const wrapper = makeElement("label", "", label);
      const input = makeElement(options ? "select" : "input");
      if (options) options.forEach(({value, label}) => { const o = makeElement("option", "", label); o.value = value; input.append(o); });
      input.value = initial ?? ""; input.setAttribute("aria-label", label); input.disabled = readOnly;
      input.dataset.committed = input.value;
      input.title = readOnly ? "此属性暂不支持在这里编辑" : options ? label : "Enter 提交 · Escape 取消";
      const error = makeElement("span", "property-error"); error.setAttribute("role", "status");
      wrapper.append(input); form.append(wrapper, error);
      const submit = async event => {
        event.preventDefault(); if (input.value === input.dataset.committed || readOnly) return;
        const submitted=input.value;
        input.disabled = true; error.textContent = "";
        try {
          if (await commit(submitted) === false) error.textContent = "未应用，请检查属性值。";
          else input.dataset.committed = submitted;
        }
        catch (e) { error.textContent = e.message; }
        finally { input.disabled = false; }
      };
      form.addEventListener("submit", submit);
      if (options) input.addEventListener("change", submit);
      input.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); input.value = input.dataset.committed; input.blur(); } });
      destination.append(form);
      return input;
    }
    if (live?.control === "input" || (!live && inputControl(component) === 'input')) {
      const input = field("输入值", live ? formatInput(live.input || live.ports[0]) : '', value => ports.setInputValue(component, value));
      input.dataset.liveInput = `${component.componentId}:0`;
      input.placeholder = '未运行';
      input.title = '输入运行值并按 Enter；未运行时自动启动仿真';
    }
    if (live?.control === "parent-input") ui.objectInspector.append(makeElement('p','parent-driven-input','此输入由父电路驱动，可返回父图调整。'));
    if (["RAM", "ROM"].includes(component.factory)) {
      const memory = makeElement("button", "object-memory", "存储内容");
      memory.append(makeElement("span", "", `${2 ** Number(component.attributes.addrWidth)} × ${component.attributes.dataWidth} bit　›`));
      memory.addEventListener("click", () => ports.openMemory(component)); ui.objectInspector.append(memory);
    }
    ui.objectInspector.append(makeElement("h3", "property-heading", "属性"));
    const appearance=makeElement('details','appearance-properties');appearance.open=appearanceOpen;
    appearance.append(makeElement('summary','','外观'));
    appearance.addEventListener('toggle',()=>{appearanceOpen=appearance.open;});
    const attributes=[...(component.attributeDetails||[])].sort((a,b)=>Number(b.name==='label')-Number(a.name==='label'));
    for (const attr of attributes) {
      destination=/^(labelfont|labelcolor|labelloc|color|font|labelvisible|appearance)$/.test(attr.name)?appearance:ui.objectInspector;
      if (attr.name === "contents") continue;
      const simple = /^(java\.lang\.(String|Integer|Long|Double|Float|Boolean)|java\.awt\.Color|com\.cburch\.logisim\.data\.(BitWidth|Direction|AttributeOption))$/.test(attr.valueClass || "");
      const options = attr.options?.length ? attr.options.map(o => ({...o, label: optionLabels[o.label] || o.label})) : null;
      field(labels[attr.name] || attr.displayName || attr.name, attr.standard, value => editObject(component, {attribute: attr.name, value}), options, attr.readOnly || !simple);
    }
    if(appearance.childElementCount>1)ui.objectInspector.append(appearance);
  }

async function editObject(component, change) {
    const viewport = ports.captureViewport();
    const ok = await ports.performProjectAction("edit", { circuit: projectState.circuitName, componentId: component.componentId, ...change });
    if (ok) {
      ports.restoreViewport(viewport);
      const updated = projectState.circuit.components.find(c => c.factory === component.factory && c.location.x === component.location.x && c.location.y === component.location.y);
      if (updated) ports.selectComponent(updated.componentId, false);
    }
    return ok;
  }

function draftPrompt(text) {
    if (!agentState.enabled) { ports.showToast("在桌面版中连接 AI 后可对话"); return; }
    ports.appendDraftText(text);
    ports.switchReviewTab("agent"); ports.openReviewPanel(); ports.resizeQuestion(); ports.updateComposerState(); ui.questionInput.focus();
  }
  return Object.freeze({renderInspector, renderPropertyEditor, editObject, draftPrompt});
}
