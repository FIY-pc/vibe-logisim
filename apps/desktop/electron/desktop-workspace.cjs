'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {FolderWorkspace, hash} = require('./folder-workspace.cjs');
const {migrateReferences} = require('./folder-migration.cjs');
const {FolderHistory} = require('./folder-history.cjs');

// Owns the relationship between one real folder, its selected document, and
// the runtime. All filesystem refreshes share a queue with explicit operations.
class DesktopWorkspace extends EventEmitter {
  constructor({stateRoot, backend, materials}) {
    super(); this.folder = new FolderWorkspace(stateRoot); this.backend = backend; this.materials=materials;
    this.history = new FolderHistory(this.folder); this.queue = Promise.resolve();
    this.digest = null; this.error = ''; this.turnActive = false;
    this.folder.on('changed', () => this.run(() => this.refresh()).catch(e => this.report(e)));
  }
  run(operation) { const result = this.queue.catch(() => {}).then(operation); this.queue = result.catch(() => {}); return result; }
  snapshot() { return {folder:this.folder.snapshot(), error:this.error}; }
  report(error) { this.error = error.message; this.emit('changed', this.snapshot()); }
  async open(root, options = {}) {
    const previous = this.folder.snapshot();
    try {
      await this.folder.open(root, options);
      await this.history.open();
      await this.backend.setFolder(this.folder.snapshot(), true);
      this.digest = null;
      if (this.folder.current.activeFile) await this.select(this.folder.current.activeFile);
      this.error = ''; this.emit('changed', this.snapshot()); return this.snapshot();
    } catch (error) {
      if (previous) { await this.folder.open(previous.root); await this.history.open(); await this.backend.setFolder(previous, true); if(previous.activeFile)await this.select(previous.activeFile); }
      else { this.folder.close(); await this.backend.setFolder(null, true); }
      throw error;
    }
  }
  async select(relative) {
    const file = this.folder.resolve(relative);
    if (path.extname(file).toLowerCase() !== '.circ') throw new Error('请选择 .circ 电路文件');
    await this.backend.openPath(file);
    // Opening a known document preserves its local editing history. Only reload
    // disk when there are no unsaved edits to protect.
    let session = await this.backend.session();
    if (!session.workspace?.dirty && session.sourceStatus?.stale) await this.backend.reload();
    this.folder.select(relative);
    if(this.materials)migrateReferences(this.folder,this.materials,session.workspace?.id);
    await this.backend.setFolder(this.folder.snapshot());
    this.digest = hash(fs.readFileSync(file)); this.error = '';
    this.emit('changed', {...this.snapshot(), documentChanged:true}); return this.snapshot();
  }
  async saveWorking() {
    const session = await this.backend.session();
    if (session.workspace?.dirty) await this.backend.projectAction('save', {projectId:session.workspace.id, revisionId:session.revision.id});
    if (this.folder.current?.activeFile) this.digest = hash(fs.readFileSync(this.folder.resolve(this.folder.current.activeFile)));
  }
  async refresh({checkpoint = !this.turnActive, title = '文件改动'} = {}) {
    if (!this.folder.current) return this.snapshot();
    if (checkpoint) this.history.checkpoint(title);
    let documentChanged = false;
    const relative = this.folder.current.activeFile;
    if (relative) {
      let digest;
      try { digest = hash(fs.readFileSync(this.folder.resolve(relative))); }
      catch (error) {
        if(error.code !== 'ENOENT')throw error;
        const session = await this.backend.session();
        if(session.workspace?.dirty)throw new Error('当前电路文件被移走，未保存的编辑仍在画布和历史中');
        this.folder.clearDocument(); await this.backend.setFolder(this.folder.snapshot(), true); this.digest = null; documentChanged = true;
      }
      const session = digest ? await this.backend.session() : null;
      if(digest && (digest !== this.digest || session.sourceStatus?.stale)) {
        if(session.workspace?.dirty) throw new Error('文件已在外部修改，画布还有未保存编辑。请在画布上选择读取磁盘版本，原编辑保留在电路历史中。');
        await this.backend.reload(); this.digest = digest; documentChanged = true;
      }
    }
    this.error = ''; const result = {...this.snapshot(), documentChanged}; this.emit('changed',result); return result;
  }
  references(refs = []) {
    if(!Array.isArray(refs)||refs.length>8)throw new Error('每条问题最多引用 8 处文件');
    return refs.map(ref => {
      const item = this.folder.reference(ref);
      if(typeof ref.quote!=='string'||ref.quote.length>2000)throw new Error('文件摘录无效');
      return {...item,page:ref.page||null,quote:ref.quote,reference:'workspace://file?'+new URLSearchParams({folderId:this.folder.current.id,path:item.path,pathVersion:item.pathVersion,...(ref.page?{page:ref.page}:{})})};
    });
  }
}
module.exports = {DesktopWorkspace};
