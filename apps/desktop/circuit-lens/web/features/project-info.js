import {icon, copyText} from '../core/chat-dom.js';
import {createRequestScope} from '../core/request-scope.js';

export const modelDependencies = ['project'];
export const dependencies = [];

// File information and export only. Opening this surface never runs a check.
export function createController({models, ui}) {
  const project = models.project;
  const scope = createRequestScope(project);
  let openedProject = null, download = null;
  const available = () => Boolean(project.session?.workspace?.id && project.revision);

  function showError(message) {
    ui.projectInfoError.textContent = message;
    ui.projectInfoError.hidden = !message;
  }

  function renderProjectInfo() {
    ui.projectInfo.disabled = !available();
    ui.projectInfo.title = available() ? '文件位置、组件库与导出' : '打开工程后查看文件信息';
    if (!ui.projectDialog.open) return;
    if (!available() || openedProject !== project.session.workspace.id) { ui.projectDialog.close(); return; }
    const {source, workspace} = project.session;
    const capabilities = project.capabilities;
    const libraries = capabilities?.revisionScope?.externalLibraryDescriptors || [];
    const complete = capabilities?.relativeExternalLibraries?.supported !== false;
    const profile = capabilities?.observationProfile || capabilities?.profile;
    const version = project.runtime?.reportedVersion || profile?.reportedVersion;
    const observed = project.capabilityState === 'exact' && version;
    ui.projectFileName.textContent = source?.name || workspace.name;
    ui.projectContents.textContent = `${project.circuits.length} 个电路${workspace.dirty ? ' · 有未保存的改动' : ''}`;
    ui.projectSource.textContent = source?.directory || '从上传文件打开，尚未关联本地路径';
    ui.projectCopyPath.hidden = !source?.path;
    ui.projectRuntime.textContent = observed ? `Logisim-ITA ${String(version).replace(/\.(jar|exe)$/i, '')}` : '尚未成功载入';
    ui.projectLibraries.textContent = libraries.length
      ? [...new Set(libraries.map(descriptor => descriptor.split('#')[1] || descriptor))].join('、')
      : '仅使用内置组件';
    const problem = project.circuit?.observerError?.message || profile?.error;
    ui.projectIssue.hidden = !problem && complete;
    ui.projectIssue.textContent = problem ? `当前电路的运行环境未能载入：${problem}` : '组件库未完整载入，请检查电路文件所引用的库。';
    ui.projectExportNote.textContent = project.sourceChanged
      ? '工程已有外部改动，导出的是当前打开的版本。'
      : workspace.dirty ? '包含当前未保存的改动，不会覆盖原文件。' : '包含当前电路与依赖文件。';
    ui.exportProject.disabled = !complete || Boolean(download) || project.projectBusy;
    ui.exportProject.title = complete ? '导出为 ZIP，解压后用 Logisim 打开其中的 .circ' : '补齐组件库后才能导出电路包';
  }

  async function exportProject() {
    if (ui.exportProject.disabled || !available()) return;
    const current = scope.begin();
    const binding = {projectId: project.session.workspace.id, revisionId: project.revision};
    const filename = (project.session.source?.name || '电路').replace(/\.circ$/i, '').replace(/[\\/:*?"<>|]/g, '_') + '.zip';
    const pending = new AbortController(); download = pending;
    showError('');
    ui.exportProject.textContent = '正在打包…';
    ui.exportProject.setAttribute('aria-busy', 'true');
    renderProjectInfo();
    try {
      const response = await fetch(`/api/project/download?${new URLSearchParams(binding)}`, {signal: pending.signal, cache: 'no-store'});
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || `导出失败（${response.status}）`);
      }
      const blob = await response.blob();
      if (pending.signal.aborted || !ui.projectDialog.open) return;
      if (!current()) { showError('工程已更新，请重新导出当前版本。'); return; }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = filename;
      document.body.append(link); link.click(); link.remove();
      // Let the browser hand the file to its download manager before release.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) {
      if (current() && ui.projectDialog.open && !pending.signal.aborted) showError(`导出未完成：${error.message}`);
    } finally {
      if (download === pending) {
        download = null;
        ui.exportProject.textContent = '导出电路包…';
        ui.exportProject.removeAttribute('aria-busy');
        renderProjectInfo();
      }
    }
  }

  function mountProjectInfo() {
    ui.projectInfoClose.replaceChildren(icon('X'));
    ui.projectCopyPath.replaceChildren(icon('Copy'));
    ui.projectInfo.addEventListener('click', () => {
      if (!available()) return;
      openedProject = project.session.workspace.id;
      showError(''); ui.projectDialog.showModal(); renderProjectInfo();
    });
    ui.projectInfoClose.addEventListener('click', () => ui.projectDialog.close());
    ui.projectDialog.addEventListener('close', () => { scope.begin(); download?.abort(); });
    // A drag selecting a long path outwards must not dismiss the dialog.
    let outside = false;
    ui.projectDialog.addEventListener('pointerdown', event => { outside = outsideDialog(event); });
    ui.projectDialog.addEventListener('click', event => { if (outside && outsideDialog(event)) ui.projectDialog.close(); outside = false; });
    ui.projectCopyPath.addEventListener('click', () => {
      showError(''); copyText(project.session.source.path, ui.projectCopyPath, showError);
    });
    ui.exportProject.addEventListener('click', exportProject);
    renderProjectInfo();
  }

  function outsideDialog(event) {
    const rect = ui.projectDialog.getBoundingClientRect();
    return event.target === ui.projectDialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
  }

  return {mountProjectInfo, renderProjectInfo};
}
