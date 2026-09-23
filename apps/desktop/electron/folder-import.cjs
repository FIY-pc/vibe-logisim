'use strict';
const fs = require('node:fs');
const path = require('node:path');
const fsp = fs.promises;

// Copy external drops, never move their source or overwrite workspace files.
// Validate and stage the entire drop before publishing any entries.
const profiles = new Set(['.codex', '.ssh', 'codex-home', 'circuit-agent']);
async function validate(source) {
  if (profiles.has(path.basename(source))) throw new Error('认证或 AI 配置目录不能作为工程资料导入');
  const stat = await fsp.lstat(source);
  if (stat.isSymbolicLink()) throw new Error('暂不复制符号链接：' + path.basename(source));
  if (stat.isDirectory()) {
    for (const name of await fsp.readdir(source)) await validate(path.join(source, name));
  } else if (!stat.isFile()) throw new Error('只能拖入普通文件或文件夹：' + path.basename(source));
  return stat;
}

async function importFiles(folder, {folderId, path:relative = '', sources, filesOnly=false}) {
  folder.assert(folderId);
  if (!Array.isArray(sources) || !sources.length || sources.some(p => typeof p !== 'string' || !path.isAbsolute(p))) {
    throw new Error('请从系统文件管理器拖入文件或文件夹');
  }
  const destination = await fsp.realpath(folder.resolve(relative));
  if (!(await fsp.stat(destination)).isDirectory()) throw new Error('请拖到文件夹或文件列表的空白处');
  const inputs = [];
  for (const source of new Set(sources)) {
    const real = await fsp.realpath(source);
    // Check before traversing: never copy a directory into itself.
    if (destination === real || destination.startsWith(real + path.sep)) throw new Error('不能把文件夹复制到它自己里面');
    if(filesOnly&&!(await fsp.lstat(source)).isFile())throw new Error('请拖入要引用的文件；文件夹可以拖入左侧文件列表');
    const stat = await validate(source);
    inputs.push({source, name:path.basename(source), directory:stat.isDirectory()});
  }
  const stage = await fsp.mkdtemp(path.join(destination, '.vibe-import-'));
  const items = [];
  try {
    for (const [index, input] of inputs.entries()) {
      input.staged = path.join(stage, String(index));
      await fsp.cp(input.source, input.staged, {recursive:true, force:false, errorOnExist:true,
        // Re-check each entry, so a link introduced during staging is not copied.
        filter:async source => {const s=await fsp.lstat(source);if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile()))throw new Error('文件在复制期间发生变化，请重试');return true;}});
    }
    folder.assert(folderId);
    if (await fsp.realpath(folder.resolve(relative)) !== destination) throw new Error('目标文件夹已变化，请重试');
    for (const input of inputs) {
      const ext = input.directory ? '' : path.extname(input.name), stem = input.name.slice(0, input.name.length - ext.length);
      for (let number = 1; ; number++) {
        const name = number === 1 ? input.name : `${stem} (${number})${ext}`;
        const target = path.join(destination, name);
        try {
          if (input.directory) {
            await fsp.mkdir(target); // Exclusive reservation; no existing directory is merged.
            try {await fsp.rename(input.staged, target);}
            catch (error) {await fsp.rmdir(target).catch(()=>{});throw error;}
          } else await fsp.link(input.staged, target); // Atomic no-clobber publication.
        } catch (error) {if (error.code === 'EEXIST') continue;throw error;}
        items.push({name, path:path.join(relative, name).split(path.sep).join('/'), kind:input.directory?'directory':'file'});
        break;
      }
    }
    return {items,pathVersion:(folder.current.moves||[]).length};
  } catch (error) {
    // Already published files are kept. Never roll back by deleting paths a
    // user or another application may have started editing in the meantime.
    if (items.length) error.message = `已复制 ${items.length} 项，其余未完成：${error.message}`;
    throw error;
  } finally {
    await fsp.rm(stage, {recursive:true, force:true});
    folder.changed();
  }
}
module.exports = {importFiles};
