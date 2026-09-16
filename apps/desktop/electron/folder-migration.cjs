'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {hash}=require('./folder-workspace.cjs');

// Existing stores remain intact. Only user-imported references are copied to
// ordinary files; credentials and generated agent profiles are never migrated.
function migrateReferences(folder, materials, projectId) {
  if(!projectId)return;
  const record=folder.current;
  record.documentIds ||= [];
  if(record.documentIds.includes(projectId))return;
  const items=materials.list(projectId).filter(item=>!item.removedAt);
  record.legacyReferences ||= {};
  for(const item of items) {
    const directory=path.join(record.root,'参考资料');fs.mkdirSync(directory,{recursive:true});
    const bytes=materials.read(projectId,item.id).bytes;
    let relative=path.join('参考资料',item.name),target=folder.resolve(relative,{exists:false});
    if(fs.existsSync(target) && hash(fs.readFileSync(target))!==item.sha256){relative=path.join('参考资料',item.id+'-'+item.name);target=folder.resolve(relative,{exists:false});}
    if(!fs.existsSync(target))fs.writeFileSync(target,bytes,{flag:'wx'});
    record.legacyReferences[item.id]=relative;
  }
  record.documentIds.push(projectId);record.legacyProjectId ||= projectId;folder.persist();
}
function migrateDraft(store, folder) {
  if(!folder?.legacyProjectId)return;
  const target=store.file(folder.id),source=store.file(folder.legacyProjectId);
  if(fs.existsSync(target)||!fs.existsSync(source))return;
  const saved=JSON.parse(fs.readFileSync(source,'utf8'));
  for(const ref of saved.draft?.moments||[])ref.projectId ||= folder.legacyProjectId;
  for(const ref of saved.draft?.materials||[])ref.id=folder.legacyReferences?.[ref.id]||ref.id;
  fs.writeFileSync(target,JSON.stringify(saved),{flag:'wx',mode:0o600});
}
module.exports={migrateReferences,migrateDraft};
