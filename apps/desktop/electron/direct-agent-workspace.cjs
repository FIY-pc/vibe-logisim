'use strict';
const fs = require('node:fs');

// Codex writes the same directory the human sees. The host keeps optional
// history and native runtime observations; there is no staging design.circ.
class DirectAgentWorkspace {
  constructor(workspace) { this.workspace = workspace; }
  async prepare(revisionId) {
    const w = this.workspace;
    await w.run(async () => {
      const session=await w.backend.session();
      if(!session.sourceStatus?.stale)await w.saveWorking();
      try{await w.refresh({checkpoint:true});}catch(error){w.report(error);}
    });
    w.turnActive = true;
    return {folderId:w.folder.current.id, revisionId, relative:'.', sourceName:w.folder.current.activeFile};
  }
  assert(binding) { this.workspace.folder.assert(binding.folderId); }
  async synchronize(binding, relative = null) {
    this.assert(binding);
    await this.workspace.run(async () => {
      if(relative) await this.workspace.select(relative);
      else await this.workspace.refresh({checkpoint:false});
    });
    const session = await this.workspace.backend.session();
    binding.revisionId = session.revision?.id || null;
    binding.sourceName = this.workspace.folder.current.activeFile;
    return session;
  }
  async submit(binding) { return this.synchronize(binding); }
  async checkout(binding, candidateId) {
    this.assert(binding);
    if(!binding.sourceName)throw new Error('先用 open_circuit 选择电路文件');
    const bundle = await this.workspace.backend.agentBundle(binding.revisionId, candidateId);
    fs.writeFileSync(this.workspace.folder.resolve(binding.sourceName), Buffer.from(bundle.files['design.circ'],'base64'));
    return this.synchronize(binding);
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
