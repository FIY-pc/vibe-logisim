import {makeElement} from '../core/dom.js';
export const modelDependencies=['project'];
export const dependencies=['openComparison','panelEmpty'];
export function createController({models,ui,client,ports}) {
  const {project}=models;
  const candidatesState={candidate:null,candidateTraceMode:false,candidateTraceIndex:0,candidateCheckPage:0,candidateCheckFilter:'all'};
  let epoch=0,returnTarget=null;
  function closeCandidateEvidence(){epoch++;returnTarget=null;candidatesState.candidate=null;ui.candidateEvidenceDialog.close();}
  async function showCandidateEvidence({id,returnTo}) {
    returnTarget=returnTo||{kind:'candidate',id,mode:'change'};
    const token=++epoch, projectId=project.session.workspace.id, revision=project.revision;
    candidatesState.candidate=null;
    ui.evidenceResults.textContent='正在读取运行记录…';ui.evidenceModule.replaceChildren();
    ui.candidateEvidenceDialog.showModal();
    try {
      const candidate=await client.request(`/api/candidate/diff?id=${encodeURIComponent(id)}`);
      if(token!==epoch||project.session.workspace.id!==projectId||project.revision!==revision||!ui.candidateEvidenceDialog.open)return;
      Object.assign(candidatesState,{candidate,candidateTraceMode:false,candidateTraceIndex:0,candidateCheckPage:0,candidateCheckFilter:'all'});
      for(const c of candidate.changes){const option=makeElement('option','',c.circuit);option.value=c.circuit;ui.evidenceModule.append(option);}
      renderCandidateChecks();
    }catch(error){if(token===epoch)ui.evidenceResults.textContent=error.message;}
  }
function renderCandidateChecks() {
    if(!candidatesState.candidate)return;
    ui.evidenceResults.replaceChildren();
    const name = ui.evidenceModule.value;
    if (candidatesState.candidateTraceMode) { renderCandidateTrace(); return; }
    const reports = candidatesState.candidate.checks.filter(r => r.circuit === name);
    const rows = reports.flatMap(r => r.rows).map((row, index) => ({ row, index })).filter(({ row }) => candidatesState.candidateCheckFilter === "all" || (candidatesState.candidateCheckFilter === "failed" ? row.passed === false : row.passed === null));
    const pageSize = 32, pages = Math.max(1, Math.ceil(rows.length / pageSize));
    candidatesState.candidateCheckPage = Math.min(candidatesState.candidateCheckPage, pages - 1);
    const toolbar = makeElement("div", "check-navigation");
    const filter = makeElement("select"); filter.setAttribute("aria-label", "筛选检查结果");
    for (const [value, label] of [["all", "全部结果"], ["failed", "不符预期"], ["unknown", "未指定预期"]]) {
      const option = makeElement("option", "", label); option.value = value; filter.append(option);
    }
    filter.value = candidatesState.candidateCheckFilter;
    filter.addEventListener("change", () => { candidatesState.candidateCheckFilter = filter.value; candidatesState.candidateCheckPage = 0; renderCandidateChecks(); });
    const previous = makeElement("button", "", "上一页"), next = makeElement("button", "", "下一页");
    previous.disabled = candidatesState.candidateCheckPage === 0; next.disabled = candidatesState.candidateCheckPage === pages - 1;
    previous.addEventListener("click", () => { candidatesState.candidateCheckPage--; renderCandidateChecks(); });
    next.addEventListener("click", () => { candidatesState.candidateCheckPage++; renderCandidateChecks(); });
    toolbar.append(filter, makeElement("span", "", `${rows.length} 组 · ${candidatesState.candidateCheckPage + 1} / ${pages} 页`), previous, next);
    ui.evidenceResults.append(toolbar, makeElement("h3", "", name));
    rows.slice(candidatesState.candidateCheckPage * pageSize, (candidatesState.candidateCheckPage + 1) * pageSize).forEach(({ row, index }) => {
        const details = makeElement("details", "vector-check");
        details.append(makeElement("summary", "", `输入 ${index + 1}　${row.passed === true ? "符合预期" : row.passed === false ? "不符预期" : "未指定预期"}`));
        const format = object => Object.entries(object || {}).map(([key, value]) => `${key} = ${value ?? "未知"}`).join("\n");
        for (const [label, values] of [["输入", row.inputs], ["预期输出", row.expected], ["实际输出", row.outputs]]) {
          const block = makeElement("div"); block.append(makeElement("strong", "", label), makeElement("pre", "", format(values))); details.append(block);
        }
        ui.evidenceResults.append(details);
    });
    if (!rows.length) ui.evidenceResults.append(ports.panelEmpty(reports.length ? "没有符合筛选条件的结果。" : "这个模块尚未运行输入输出检查。"));
    ui.evidenceResults.scrollTop = 0;
  }

function renderCandidateTrace() {
    const traces = (candidatesState.candidate.traces || []).filter(r => r.circuit === ui.evidenceModule.value);
    const trace = traces[candidatesState.candidateTraceIndex] || traces[0];
    if (!trace) { ui.evidenceResults.append(ports.panelEmpty("这个模块尚未观察时钟执行。")); return; }
    const pageSize = 40, pages = Math.max(1, Math.ceil(trace.rows.length / pageSize));
    candidatesState.candidateCheckPage = Math.min(candidatesState.candidateCheckPage, pages - 1);
    const toolbar = makeElement("div", "check-navigation");
    const records = makeElement("select"); records.setAttribute("aria-label", "选择时钟记录");
    traces.forEach((record, index) => { const option = makeElement("option", "", record.program ? `临时程序 ${index}` : "内置 ROM 程序"); option.value = String(index); records.append(option); });
    records.value = String(candidatesState.candidateTraceIndex);
    records.addEventListener("change", () => { candidatesState.candidateTraceIndex = Number(records.value); candidatesState.candidateCheckPage = 0; renderCandidateChecks(); });
    const previous = makeElement("button", "", "上一页"), next = makeElement("button", "", "下一页");
    const end = makeElement("button", "", candidatesState.candidateCheckPage === pages - 1 ? "回到开头" : "结束位置");
    end.addEventListener("click", () => { candidatesState.candidateCheckPage = candidatesState.candidateCheckPage === pages - 1 ? 0 : pages - 1; renderCandidateChecks(); });
    previous.disabled = candidatesState.candidateCheckPage === 0; next.disabled = candidatesState.candidateCheckPage === pages - 1;
    previous.addEventListener("click", () => { candidatesState.candidateCheckPage--; renderCandidateChecks(); });
    next.addEventListener("click", () => { candidatesState.candidateCheckPage++; renderCandidateChecks(); });
    toolbar.append(records, makeElement("span", "", `${trace.rows.length} 个采样 · ${candidatesState.candidateCheckPage + 1} / ${pages}`), previous, next, end);
    ui.evidenceResults.append(toolbar, makeElement("p", "trace-scope", `${trace.program ? "临时 ROM 程序，候选文件未改动。" : "使用候选内置 ROM 程序。"}${trace.resetButton ? "先按下并释放复位。" : "未施加复位。"}每次时钟变化后采样，未知值不按零处理。`));
    const preferred = ["clock", "Cycles", "PC", "IR", "RegWrite", "rd", "writeback", "MemWrite", "LedData"];
    const supplied = trace.watches.map(w => w.name);
    const names = [...preferred.filter(n => supplied.includes(n)), ...supplied.filter(n => !preferred.includes(n))];
    const table = makeElement("table", "trace-table"), head = makeElement("tr");
    const labels = {clock:"时钟", Cycles:"周期", IR:"指令", RegWrite:"写寄存器", rd:"目标寄存器", writeback:"写回值", MemWrite:"写内存", LedData:"显示值"};
    ["时钟步", ...names].forEach(name => { const th = makeElement("th", "", labels[name] || name); th.title = name; head.append(th); });
    const thead = makeElement("thead"); thead.append(head); table.append(thead);
    const body = makeElement("tbody");
    for (const row of trace.rows.slice(candidatesState.candidateCheckPage * pageSize, (candidatesState.candidateCheckPage + 1) * pageSize)) {
      const tr = makeElement("tr"); tr.append(makeElement("th", "", String(row.tick)));
      for (const name of names) {
        const value = row.values[name], decimal = ["clock", "Cycles", "RegWrite", "MemWrite", "rd", "rs1", "PCenable", "ALUop"].includes(name);
        tr.append(makeElement("td", value == null ? "is-unknown" : "", value == null ? "未知" : decimal ? String(value) : `0x${value.toString(16).padStart(8, "0")}`));
      }
      body.append(tr);
    }
    table.append(body); ui.evidenceResults.append(table);
  }

  function mountCandidateEvidence(){
    ui.closeCandidateEvidence.addEventListener('click',closeCandidateEvidence);
    ui.evidenceBack.addEventListener('click',()=>{if(!returnTarget)return;epoch++;ui.candidateEvidenceDialog.close();ports.openComparison(returnTarget.kind,returnTarget.id,returnTarget.mode);});
    ui.evidenceModule.addEventListener('change',()=>{candidatesState.candidateCheckPage=0;renderCandidateChecks();});
    ui.evidenceVectors.addEventListener('click',()=>{candidatesState.candidateTraceMode=false;candidatesState.candidateCheckPage=0;renderCandidateChecks();});
    ui.evidenceTrace.addEventListener('click',()=>{candidatesState.candidateTraceMode=true;candidatesState.candidateCheckPage=0;renderCandidateChecks();});
    ui.candidateEvidenceDialog.addEventListener('cancel',()=>epoch++);
  }
  return Object.freeze({showCandidateEvidence,closeCandidateEvidence,mountCandidateEvidence});
}
