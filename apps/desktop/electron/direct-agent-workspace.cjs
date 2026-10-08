'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {buildWorkspaceIndex} = require('./workspace-index.cjs');

function workspaceToolError(code, message, {hint = null, context = null} = {}) {
  const error = new Error(message);
  error.code = code;
  error.toolError = {
    code,
    message,
    retryable: false,
    ...(hint ? {hint} : {}),
    ...(context && typeof context === 'object' ? {context} : {}),
  };
  return error;
}

// FolderWorkspace.resolve() rejects paths it will not touch with a bare
// message. For the model that has to become an actionable error: it usually
// passed an absolute path (its cwd is the real folder) and needs the
// workspace-relative form, or it named a file that is not in the workspace.
function pathToolError(error, requested, folder, workspaceIndex) {
  const message = String(error?.message || '');
  const kind = /文件路径无效/.test(message) ? 'invalid'
    : /不在当前工作区内/.test(message) ? 'outside'
    : /链接指向工作区之外/.test(message) ? 'link'
    : error?.code === 'ENOENT' ? 'missing' : null;
  if (!kind) return error;
  const root = folder?.current?.root || null;
  const activeFile = folder?.current?.activeFile || null;
  const files = Array.isArray(workspaceIndex?.circuits) ? workspaceIndex.circuits.map(file => file.path) : [];
  let suggestedPath = null;
  if (typeof requested === 'string' && root && path.isAbsolute(requested)) {
    const relative = path.relative(root, path.resolve(requested)).split(path.sep).join('/');
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) suggestedPath = relative;
  }
  if (!suggestedPath && typeof requested === 'string' && requested) {
    const tail = requested.split(/[\\/]/).filter(Boolean).pop();
    const byName = files.filter(file => file.split('/').pop() === tail);
    if (byName.length === 1) suggestedPath = byName[0];
  }
  const example = suggestedPath || files[0] || activeFile || 'design.circ';
  const hint = kind === 'invalid'
    ? `path 必须是相对工作区根目录的路径（例如 "${example}"），不能是绝对路径或含有空字符。${suggestedPath ? `这个文件就在工作区内，请改用 path="${suggestedPath}" 重试。` : '从 context.availableFiles 中选择目标 .circ；如果你刚新建了文件，先确认它写在工作区目录里。'}`
    : kind === 'outside'
      ? `这个路径解析到了工作区目录之外。只能打开当前工作区（${root}）里的文件；${suggestedPath ? `工作区里有同名文件，请改用 path="${suggestedPath}"。` : '从 context.availableFiles 中选择，或先把文件放进工作区。'}`
      : kind === 'missing'
        ? `工作区里没有这个文件。${suggestedPath ? `有一个同名文件，请改用 path="${suggestedPath}"。` : '从 context.availableFiles 中选择目标 .circ；如果你刚新建了文件，先确认它已经写到工作区目录里（写入的目录就是当前工作区），不要根据文件名猜测路径。'}`
        : '这个路径是指向工作区之外的链接；请让用户直接打开链接目标所在的文件夹。';
  const code = kind === 'invalid' ? 'INVALID_PATH' : kind === 'missing' ? 'FILE_NOT_FOUND' : 'FILE_OUTSIDE_WORKSPACE';
  const text = kind === 'missing' ? '文件不存在' : message;
  const wrapped = workspaceToolError(code, `${text}: ${requested}`, {
    hint,
    context: {
      requestedPath: requested,
      ...(suggestedPath ? {suggestedPath} : {}),
      workspaceRoot: root,
      activeFile,
      availableFiles: files.slice(0, 40),
      availableFilesTruncated: files.length > 40 || Boolean(workspaceIndex?.truncated),
    },
  });
  wrapped.cause = error;
  return wrapped;
}

// The model's cwd is the user's folder (on Windows the same path the host
// sees), so it naturally passes absolute paths and, on a POSIX host, sometimes
// backslashes. Accept what unambiguously names a file inside the workspace;
// anything else is left as written so the error can explain it.
function normalizeRequestedPath(requested, root) {
  if (typeof requested !== 'string' || !root) return requested;
  let value = requested.trim();
  if (path.isAbsolute(value)) {
    const relative = path.relative(root, path.resolve(value));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return requested;
    value = relative.split(path.sep).join('/');
  }
  if (path.sep === '/' && value.includes('\\') && !fs.existsSync(path.join(root, value))) {
    const slashed = value.replace(/\\/g, '/');
    if (fs.existsSync(path.join(root, slashed))) value = slashed;
  }
  return value;
}

// Codex writes the same directory the human sees. The host keeps optional
// history and native runtime observations; there is no staging design.circ.
class DirectAgentWorkspace {
  constructor(workspace) { this.workspace = workspace; }
  async prepare(revisionId) {
    const w = this.workspace;
    let session = null;
    await w.run(async () => {
      session = await w.backend.session();
      if(!session.sourceStatus?.stale)await w.saveWorking();
      await w.refresh({checkpoint:true});
      session = await w.backend.session();
    });
    const currentRevisionId = session?.revision?.id || null;
    if (typeof revisionId === 'string' && revisionId && currentRevisionId !== revisionId) {
      throw workspaceToolError('STALE_WORKSPACE_CONTEXT',
        '发送前工作区版本已经变化，请重新读取当前电路后再发送。', {
          hint: '当前文件已经保留；重新打开或重新选择当前电路后再继续。',
          context: {expectedRevisionId: revisionId || null, currentRevisionId},
        });
    }
    w.turnActive = true;
    const workspaceIndex = buildWorkspaceIndex({
      root: w.folder.current.root,
      activeFile: w.folder.current.activeFile,
      session,
    });
    return {folderId:w.folder.current.id, projectId:session?.workspace?.id || null,
      revisionId, relative:'.', sourceName:w.folder.current.activeFile, workspaceIndex,
      turnBaselines:session?.workspace?.id && currentRevisionId
        ? {[session.workspace.id]:currentRevisionId} : {}};
  }
  assert(binding) { this.workspace.folder.assert(binding.folderId); }
  resolveFile(binding, relative) {
    this.assert(binding);
    return this.workspace.folder.resolve(relative);
  }
  async synchronize(binding, relative = null, assertCurrent = () => {}, {navigate=false} = {}) {
    this.assert(binding);
    assertCurrent();
    let previous = null;
    await this.workspace.run(async () => {
      assertCurrent();
      this.assert(binding);
      // The revision loaded before this refresh. When the model edited the
      // file directly, refresh() imports the new bytes as a new revision and
      // the write receipt diffs the two to report which definitions changed.
      const before = relative ? null : await this.workspace.backend.session();
      previous = before?.revision?.id || null;
      if(relative) {
        const target = normalizeRequestedPath(relative, this.workspace.folder.current?.root);
        try { await this.workspace.select(target,{notify:!navigate}); }
        catch (error) { throw pathToolError(error, relative, this.workspace.folder, binding.workspaceIndex); }
      }
      else await this.workspace.refresh({checkpoint:false});
    });
    const session = await this.workspace.backend.session();
    assertCurrent();
    this.assert(binding);
    binding.projectId = session.workspace?.id || null;
    binding.revisionId = session.revision?.id || null;
    binding.turnBaselines ||= {};
    if (binding.projectId && binding.revisionId && !Object.hasOwn(binding.turnBaselines,binding.projectId)) {
      binding.turnBaselines[binding.projectId] = binding.revisionId;
    }
    binding.previousRevisionId = previous;
    binding.sourceName = this.workspace.folder.current.activeFile;
    return session;
  }
  canvasState(session) { return this.workspace.canvas?.snapshot(session) ?? {status:'unavailable',circuit:null}; }
  canvasVersion() { return this.workspace.canvas?.version; }
  async navigate(binding, session, circuit, assertCurrent, version) {
    this.assert(binding);assertCurrent();
    if(circuit && !session.project?.circuits?.some(item=>item.name===circuit)){
      this.workspace.emit('changed',{...this.workspace.snapshot(),documentChanged:true});
      const available = (session.project?.circuits || []).map(item => item.name).filter(Boolean);
      throw workspaceToolError('CIRCUIT_NOT_FOUND',
        '文件已载入，但电路定义不存在：' + circuit + '。可用电路：' + available.join('、'), {
          hint: available.length
            ? '从 context 或上一次 open_circuit 回执的 circuits 中选择一个定义名后重试。'
            : '当前文件没有可用的电路定义；先检查文件内容。',
          context: {requested: circuit, availableCircuits: available},
        });
    }
    const canvas=await this.workspace.canvas?.open(session,circuit,version) ?? this.canvasState(session);
    this.assert(binding);assertCurrent();
    return {...session,canvas};
  }
  async checkout(binding, candidateId, assertCurrent = () => {}) {
    const w = this.workspace;
    await w.run(async () => {
      this.assert(binding);
      assertCurrent();
      if (!binding.sourceName) throw new Error('先用 open_circuit 选择电路文件');
      const session = await w.backend.session();
      assertCurrent();
      if (session.workspace?.id !== binding.projectId || session.revision?.id !== binding.revisionId
          || session.workspace?.dirty || session.sourceStatus?.stale || w.folder.current.activeFile !== binding.sourceName) {
        throw new Error('当前电路已变化，请重新读取后再使用候选');
      }
      const file = w.folder.resolve(binding.sourceName);
      const original = fs.readFileSync(file);
      const bundle = await w.backend.agentBundle(binding.revisionId, candidateId);
      assertCurrent();
      this.assert(binding);
      if (!fs.readFileSync(file).equals(original)) throw new Error('当前文件已在外部修改，候选尚未写入');
      fs.writeFileSync(file, Buffer.from(bundle.files['design.circ'], 'base64'));
    });
    return this.synchronize(binding, null, assertCurrent);
  }
  async finish(binding, {isCurrent}) {
    if(!isCurrent())return null;
    this.assert(binding); this.workspace.turnActive = false;
    await this.workspace.run(() => this.workspace.refresh({checkpoint:true,title:'AI 文件改动'}));
    const session = await this.workspace.backend.session();
    return {
      projectId: session?.workspace?.id || null,
      revisionId: session?.revision?.id || null,
    };
  }
  async abort(binding, {isCurrent = () => true} = {}) {
    if(!isCurrent())return null;
    this.assert(binding);
    // No model turn has started, so there cannot be a model file change to
    // checkpoint. The important invariant is to release the direct-workspace
    // turn guard so later human edits create normal history checkpoints.
    this.workspace.turnActive = false;
    return null;
  }
  listRecoveries(){ return []; }
  clearRecovery(){}
}
module.exports = {DirectAgentWorkspace, normalizeRequestedPath};
