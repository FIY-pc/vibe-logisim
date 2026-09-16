// Native file dragging stays inside the explorer; text dragging stays native.
export function createFileDrop({element, folder, api, onImported, fail}) {
  let depth = 0, target = null, busy = false, hoverTimer;
  const hint = document.createElement('div');
  hint.className = 'file-drop-hint'; hint.hidden = true; hint.setAttribute('role', 'status');
  element.append(hint);
  const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
  function clear() {
    depth = 0; target = null; clearTimeout(hoverTimer);
    element.classList.remove('is-file-drop');
    element.querySelectorAll('.is-drop-target').forEach(row => row.classList.remove('is-drop-target'));
    if (!busy) hint.hidden = true;
  }
  function over(event) {
    if (!hasFiles(event)) return;
    event.preventDefault(); event.stopPropagation();
    const current = folder();
    event.dataTransfer.dropEffect = current && !busy ? 'copy' : 'none';
    if (!current || busy) return;
    // A file row targets its containing folder, a directory row that directory.
    const row = event.target.closest('.file-row');
    const path = row?.dataset.kind === 'folder' ? row.dataset.path : (row?.dataset.path || '').split('/').slice(0,-1).join('/');
    if (path !== target) {
      clearTimeout(hoverTimer); target = path;
      element.querySelectorAll('.is-drop-target').forEach(row => row.classList.remove('is-drop-target'));
      const directory = [...element.querySelectorAll('.file-row')].find(row => row.dataset.path === path && row.dataset.kind === 'folder');
      directory?.classList.add('is-drop-target');
      if (directory?.getAttribute('aria-expanded') === 'false') hoverTimer = setTimeout(() => directory.click(), 650);
    }
    element.classList.add('is-file-drop'); hint.hidden = false;
    hint.textContent = '复制到 ' + (path ? path.split('/').at(-1) : current.name);
    if (document.getElementById('filesTab').getAttribute('aria-selected') !== 'true') document.getElementById('filesTab').click();
    const collapse = document.getElementById('collapseFiles');
    if (collapse.getAttribute('aria-expanded') === 'false') collapse.click();
  }
  element.addEventListener('dragenter', event => {if (hasFiles(event)) {depth++; over(event);}});
  element.addEventListener('dragover', over);
  element.addEventListener('dragleave', event => {
    if (!hasFiles(event)) return;
    if (--depth <= 0 || (event.relatedTarget && !element.contains(event.relatedTarget))) clear();
  });
  element.addEventListener('drop', async event => {
    if (!hasFiles(event)) return;
    over(event);
    const binding = folder(), path = target || '', files = Array.from(event.dataTransfer.files);
    clear();
    if (!binding || busy || !files.length) return;
    busy = true; hint.hidden = false; hint.textContent = '正在复制…';
    try {
      const result = await api.importFiles({folderId:binding.id, path}, files);
      if (folder()?.id === binding.id) await onImported(result.items, path);
    } catch (error) {fail(error);}
    finally {busy = false; clear();}
  });
  document.addEventListener('dragend', clear);
  document.addEventListener('drop', clear);
  window.addEventListener('blur', clear);
  return {clear};
}
