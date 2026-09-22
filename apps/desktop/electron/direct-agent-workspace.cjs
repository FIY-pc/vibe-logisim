'use strict';
const fs = require('node:fs');
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
      revisionId, relative:'.', sourceName:w.folder.current.activeFile, workspaceIndex};
  }
  assert(binding) { this.workspace.folder.assert(binding.folderId); }
  resolveFile(binding, relative) {
    this.assert(binding);
    return this.workspace.folder.resolve(relative);
  }
  async synchronize(binding, relative = null, assertCurrent = () => {}, {navigate=false} = {}) {
    this.assert(binding);
    assertCurrent();
    await this.workspace.run(async () => {
      assertCurrent();
      this.assert(binding);
      if(relative) await this.workspace.select(relative,{notify:!navigate});
      else await this.workspace.refresh({checkpoint:false});
    });
    const session = await this.workspace.backend.session();
    assertCurrent();
    this.assert(binding);
    binding.projectId = session.workspace?.id || null;
    binding.revisionId = session.revision?.id || null;
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
    return null;
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
module.exports = {DirectAgentWorkspace};
