'use strict';
const fs = require('node:fs');

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
      try{await w.refresh({checkpoint:true});}catch(error){w.report(error);}
      session = await w.backend.session();
    });
    w.turnActive = true;
    return {folderId:w.folder.current.id, projectId:session?.workspace?.id || null,
      revisionId, relative:'.', sourceName:w.folder.current.activeFile};
  }
  assert(binding) { this.workspace.folder.assert(binding.folderId); }
  async synchronize(binding, relative = null, assertCurrent = () => {}) {
    this.assert(binding);
    assertCurrent();
    await this.workspace.run(async () => {
      assertCurrent();
      if(relative) await this.workspace.select(relative);
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
  listRecoveries(){ return []; }
  clearRecovery(){}
}
module.exports = {DirectAgentWorkspace};
