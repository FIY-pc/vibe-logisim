pub(crate) mod file_history;
pub(crate) mod file_references;
mod recycle;
use crate::{Host, Result};
use file_history::{History, Version, replace_checked, version, write_new};
use file_references::References;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};
use vibe_circuit_document::{Document, Folder, Workspace, digest};

struct Recording {
    history: Option<History>,
    warning: Option<String>,
}
impl Recording {
    fn start(state: &Path, folder: &Folder) -> Self {
        match History::open(state, folder).and_then(|mut history| {
            history.checkpoint(folder, "文件改动", None)?;
            Ok(history)
        }) {
            Ok(history) => Self {
                history: Some(history),
                warning: None,
            },
            Err(warning) => Self {
                history: None,
                warning: Some(warning.to_string()),
            },
        }
    }
    fn finish(
        mut self,
        folder: &Folder,
        title: &str,
        movement: Option<(String, String)>,
    ) -> Option<String> {
        if let Some(history) = &mut self.history
            && let Err(error) = history.checkpoint(folder, title, movement)
        {
            self.warning = Some(error.to_string());
        }
        self.warning
    }
}
fn target_key(path: &Path) -> String {
    let key = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        key.to_lowercase()
    } else {
        key
    }
}

impl Host {
    pub(crate) async fn move_project_entry(
        &self,
        folder_id: &str,
        from: &str,
        to: &str,
    ) -> Result<Value> {
        let folder = self.folder.lock().await;
        let folder = folder.as_ref().ok_or("请先打开工程文件夹")?;
        if folder.id != folder_id {
            return Err("工程文件夹已改变，请重新操作".into());
        }
        let target = folder
            .resolve(to, false)
            .map_err(|error| error.to_string())?;
        let mut workspace = self.workspace.lock().await;
        if workspace.documents.values().any(|document| {
            document
                .path
                .as_ref()
                .is_some_and(|path| path.starts_with(&target))
        }) {
            return Err("目标路径已有打开的文档，请先关闭该文档".into());
        }
        let history = Recording::start(&self.state, folder);
        let movement = (from.to_owned(), to.to_owned());
        let mut references = References::open(&self.state, folder)?;
        let (from, to) = folder.rename(from, to).map_err(|error| error.to_string())?;
        workspace.relocate(&from, &to);
        references.changed(&movement.0, Some(&movement.1))?;
        let warning = history.finish(folder, "移动文件", Some(movement));
        Ok(json!({"from":from,"to":to,"historyWarning":warning}))
    }

    pub(crate) async fn trash_project_entry(
        &self,
        folder_id: &str,
        relative: &str,
    ) -> Result<Value> {
        let folder = self.folder.lock().await;
        let folder = folder.as_ref().ok_or("请先打开工程文件夹")?;
        if folder.id != folder_id {
            return Err("工程文件夹已改变，请重新操作".into());
        }
        let path = folder
            .entry_path(relative)
            .map_err(|error| error.to_string())?;
        let mut workspace = self.workspace.lock().await;
        let mut closed = Vec::new();
        for document in workspace.documents.values() {
            if document
                .path
                .as_ref()
                .is_some_and(|source| source.starts_with(&path))
            {
                if document.dirty() {
                    return Err(format!(
                        "“{}”还有未保存的修改，请先保存或关闭该文档",
                        document.view()?.name
                    )
                    .into());
                }
                closed.push(document.id.clone());
            }
        }
        let history = Recording::start(&self.state, folder);
        let mut references = References::open(&self.state, folder)?;
        // Hold the document lock until the OS operation finishes: an edit cannot race
        // the dirty check and turn a clean close into a silent discard.
        tokio::task::spawn_blocking(move || recycle::send(&path))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| format!("无法移入回收站：{error}"))?;
        for id in &closed {
            workspace
                .close(id, false)
                .map_err(|error| error.to_string())?;
        }
        references.changed(relative, None)?;
        let warning = history.finish(folder, "移入回收站", None);
        drop(workspace);
        // Dispatch ends a run of any document this request closed.
        Ok(json!({"trashed":true,"closed":closed,"historyWarning":warning}))
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub enum ImportAction {
    KeepBoth,
    Replace,
    Skip,
}
#[derive(Debug, Clone, Deserialize, Serialize, ts_rs::TS)]
pub struct ImportChoice {
    pub index: usize,
    pub action: ImportAction,
}
#[derive(Serialize, Deserialize)]
struct ImportItem {
    name: String,
    path: String,
    directory: bool,
    existing: Option<Version>,
}
#[derive(Serialize, Deserialize)]
struct ImportPlan {
    folder_id: String,
    destination: String,
    items: Vec<ImportItem>,
}

fn copy_source(
    root: &Path,
    source: &Path,
    target: &Path,
    count: &mut usize,
    total: &mut u64,
) -> Result<()> {
    let metadata = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if metadata.is_symlink() {
        return Err("导入内容包含符号链接，请直接选择实际文件或文件夹".into());
    }
    if !source
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(root)
    {
        return Err("导入内容指向所选文件夹之外".into());
    }
    let name = source.file_name().unwrap_or_default().to_string_lossy();
    if name == ".ssh" {
        return Err("不能导入身份配置目录".into());
    }
    *count += 1;
    if *count > 20_000 {
        return Err("导入项目超过 20000 项，请分批导入".into());
    }
    if metadata.is_dir() {
        fs::create_dir(target).map_err(|e| e.to_string())?;
        for child in fs::read_dir(source).map_err(|e| e.to_string())? {
            let child = child.map_err(|e| e.to_string())?;
            copy_source(
                root,
                &child.path(),
                &target.join(child.file_name()),
                count,
                total,
            )?;
        }
    } else if metadata.is_file() {
        *total += metadata.len();
        if *total > 256 * 1024 * 1024 {
            return Err("本次导入超过 256 MB，请分批导入".into());
        }
        let bytes = fs::read(source).map_err(|e| e.to_string())?;
        if fs::symlink_metadata(source)
            .map_err(|e| e.to_string())?
            .is_symlink()
            || !source
                .canonicalize()
                .map_err(|e| e.to_string())?
                .starts_with(root)
        {
            return Err("导入文件的来源在复制时发生改变，请重试".into());
        }
        write_new(target, &bytes)?;
    } else {
        return Err("只支持导入普通文件和文件夹".into());
    }
    Ok(())
}
fn publish_tree(source: &Path, target: &Path) -> Result<()> {
    if source.is_dir() {
        fs::create_dir(target).map_err(|e| e.to_string())?;
        for child in fs::read_dir(source).map_err(|e| e.to_string())? {
            let child = child.map_err(|e| e.to_string())?;
            publish_tree(&child.path(), &target.join(child.file_name()))?;
        }
    } else {
        write_new(target, &fs::read(source).map_err(|e| e.to_string())?)?;
    }
    Ok(())
}
fn ensure_clean(workspace: &Workspace, paths: &[PathBuf]) -> Result<()> {
    if workspace.documents.values().any(|doc| {
        doc.dirty()
            && doc
                .path
                .as_ref()
                .is_some_and(|p| paths.iter().any(|target| p.starts_with(target)))
    }) {
        return Err("相关文件还有未保存的修改，请先保存或关闭文档".into());
    }
    Ok(())
}
/// Reload clean documents only. The caller holds the workspace lock throughout
/// validation and publication, so an editor cannot gain an unseen dirty draft.
fn refresh_documents(workspace: &mut Workspace, paths: &[PathBuf]) -> Result<Vec<String>> {
    let mut closed = Vec::new();
    for doc in workspace.documents.values_mut() {
        if let Some(path) = &doc.path {
            if !paths.iter().any(|target| path.starts_with(target)) {
                continue;
            }
            if !path.exists() {
                closed.push(doc.id.clone());
                continue;
            }
            let source = fs::read(path).map_err(|e| e.to_string())?;
            if digest(&source) != doc.revision() {
                doc.reload(&doc.revision(), &digest(&source), false)
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    for id in &closed {
        workspace.close(id, false).map_err(|e| e.to_string())?;
    }
    Ok(closed)
}
impl Host {
    pub(crate) async fn create_project_entry(
        &self,
        folder_id: &str,
        path: &str,
        directory: bool,
    ) -> Result<Value> {
        let guard = self.folder.lock().await;
        let folder = guard
            .as_ref()
            .filter(|f| f.id == folder_id)
            .ok_or("工程文件夹已改变，请重新操作")?;
        let history = Recording::start(&self.state, folder);
        let result = folder.create(path, directory).map_err(|e| e.to_string())?;
        let warning = history.finish(
            folder,
            if directory {
                "新建文件夹"
            } else {
                "新建文件"
            },
            None,
        );
        Ok(json!({"path":result,"historyWarning":warning}))
    }

    fn import_directory(&self, id: &str) -> Result<PathBuf> {
        let id = uuid::Uuid::parse_str(id).map_err(|_| "无效的导入记录")?;
        Ok(self.state.join("file-imports").join(id.to_string()))
    }
    pub(crate) async fn prepare_file_import(
        &self,
        folder_id: &str,
        sources: Vec<PathBuf>,
        destination: &str,
    ) -> Result<Value> {
        let guard = self.folder.lock().await;
        let folder = guard
            .as_ref()
            .filter(|f| f.id == folder_id)
            .ok_or("工程文件夹已改变，请重新操作")?;
        let target = folder
            .resolve(destination, true)
            .map_err(|e| e.to_string())?;
        if !target.is_dir() {
            return Err("请选择目标文件夹".into());
        }
        if sources.is_empty() || sources.len() > 1000 {
            return Err("请选择 1 至 1000 个导入项".into());
        }
        let base = self.state.join("file-imports");
        fs::create_dir_all(&base).map_err(|e| e.to_string())?;
        let staged = tempfile::tempdir_in(&base).map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        let (mut count, mut total) = (0, 0);
        for (index, source) in sources.iter().enumerate() {
            if !source.is_absolute() {
                return Err("请选择完整的文件来源路径".into());
            }
            if fs::symlink_metadata(source)
                .map_err(|e| e.to_string())?
                .is_symlink()
            {
                return Err("请选择实际文件或文件夹，不支持符号链接".into());
            }
            let source = source.canonicalize().map_err(|e| e.to_string())?;
            if target.starts_with(&source) {
                return Err("不能将文件夹导入自身或子目录".into());
            }
            let name = source
                .file_name()
                .ok_or("不能导入文件系统根目录")?
                .to_string_lossy()
                .to_string();
            let path = target
                .join(&name)
                .strip_prefix(&folder.path)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            // A linked destination is an explicit conflict, never a writable alias.
            let existing = version(&target.join(&name))?;
            copy_source(
                &source,
                &source,
                &staged.path().join(index.to_string()),
                &mut count,
                &mut total,
            )?;
            items.push(ImportItem {
                name,
                path,
                directory: source.is_dir(),
                existing,
            });
        }
        let id = uuid::Uuid::new_v4().to_string();
        let result = json!({"id":id,"items":items.iter().enumerate().map(|(index,item)|json!({"index":index,"name":item.name,"path":item.path,"directory":item.directory,"conflict":item.existing.is_some() || items[..index].iter().any(|other| target_key(Path::new(&other.name))==target_key(Path::new(&item.name))),"replaceable":!item.directory && item.existing.as_ref().is_some_and(|v|!v.directory&&v.stored)})).collect::<Vec<_>>()});
        let plan = ImportPlan {
            folder_id: folder.id.clone(),
            destination: target
                .strip_prefix(&folder.path)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/"),
            items,
        };
        fs::write(
            staged.path().join("plan.json"),
            serde_json::to_vec(&plan).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(staged.path(), self.import_directory(&id)?).map_err(|e| e.to_string())?;
        Ok(result)
    }
    pub(crate) async fn cancel_file_import(&self, folder_id: &str, id: &str) -> Result<Value> {
        let _guard = self.folder.lock().await;
        let directory = self.import_directory(id)?;
        if !directory.exists() {
            return Ok(json!({"cancelled":true}));
        }
        let plan: ImportPlan = serde_json::from_slice(
            &fs::read(directory.join("plan.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if plan.folder_id != folder_id {
            return Err("导入记录不属于当前工程".into());
        }
        fs::remove_dir_all(directory).map_err(|e| e.to_string())?;
        Ok(json!({"cancelled":true}))
    }
    pub(crate) async fn apply_file_import(
        &self,
        folder_id: &str,
        id: &str,
        choices: Vec<ImportChoice>,
    ) -> Result<Value> {
        let guard = self.folder.lock().await;
        let folder = guard
            .as_ref()
            .filter(|f| f.id == folder_id)
            .ok_or("工程文件夹已改变，请重新操作")?;
        let directory = self.import_directory(id)?;
        let plan: ImportPlan = serde_json::from_slice(
            &fs::read(directory.join("plan.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if plan.folder_id != folder_id {
            return Err("导入记录不属于当前工程".into());
        }
        if choices.len() != plan.items.len() {
            return Err("请确认每个导入项的处理方式".into());
        }
        let destination = folder
            .resolve(&plan.destination, true)
            .map_err(|e| e.to_string())?;
        let mut workspace = self.workspace.lock().await;
        let mut targets = Vec::new();
        let mut reserved = std::collections::BTreeSet::new();
        for (index, item) in plan.items.iter().enumerate() {
            let selected: Vec<_> = choices.iter().filter(|c| c.index == index).collect();
            if selected.len() != 1 {
                return Err("导入选择不完整".into());
            }
            let choice = selected[0];
            if matches!(choice.action, ImportAction::Skip) {
                continue;
            }
            let mut target = destination.join(&item.name);
            if matches!(choice.action, ImportAction::Replace) {
                if item.directory
                    || !item
                        .existing
                        .as_ref()
                        .is_some_and(|v| !v.directory && v.stored)
                {
                    return Err("文件夹和大文件不能直接覆盖，请保留两者".into());
                }
                if version(&target)? != item.existing {
                    return Err(format!("“{}”在确认后发生改变，请重新导入", item.name).into());
                }
                ensure_clean(&workspace, std::slice::from_ref(&target))?;
                if workspace
                    .documents
                    .values()
                    .any(|doc| doc.path.as_ref() == Some(&target))
                {
                    Document::from_bytes(
                        item.name.clone(),
                        None,
                        fs::read(directory.join(index.to_string())).map_err(|e| e.to_string())?,
                        true,
                    )
                    .map_err(|e| format!("不能替换打开的电路：{e}"))?;
                }
            } else {
                let name = Path::new(&item.name);
                let stem = if item.directory {
                    item.name.clone()
                } else {
                    name.file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string()
                };
                let extension = if item.directory {
                    String::new()
                } else {
                    name.extension()
                        .map(|s| format!(".{}", s.to_string_lossy()))
                        .unwrap_or_default()
                };
                let mut n = 2;
                while fs::symlink_metadata(&target).is_ok()
                    || reserved.contains(&target_key(&target))
                {
                    target = destination.join(format!("{stem} ({n}){extension}"));
                    n += 1;
                }
            }
            if !reserved.insert(target_key(&target)) {
                return Err("多个导入项不能覆盖同一个目标".into());
            }
            targets.push((index, target, choice.action.clone()));
        }
        let history = Recording::start(&self.state, folder);
        let mut references = References::open(&self.state, folder)?;
        let mut imported = Vec::new();
        let publish = (|| -> Result<()> {
            for (index, target, action) in &targets {
                if matches!(action, ImportAction::Replace) {
                    replace_checked(
                        target,
                        plan.items[*index].existing.as_ref(),
                        Some(
                            &fs::read(directory.join(index.to_string()))
                                .map_err(|e| e.to_string())?,
                        ),
                    )?;
                    references.changed(
                        &target
                            .strip_prefix(&folder.path)
                            .map_err(|e| e.to_string())?
                            .to_string_lossy(),
                        None,
                    )?;
                } else {
                    publish_tree(&directory.join(index.to_string()), target)?;
                }
                imported.push(
                    target
                        .strip_prefix(&folder.path)
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
            Ok(())
        })();
        let warning = history.finish(folder, "导入文件", None);
        refresh_documents(
            &mut workspace,
            &targets
                .iter()
                .map(|(_, p, _)| p.clone())
                .collect::<Vec<_>>(),
        )?;
        // Consume plans on publication, including partial failure. Retrying a consumed
        // batch would silently create another copy of already-imported entries.
        fs::remove_dir_all(directory).map_err(|e| e.to_string())?;
        // Partial failures return an error, so record recovery state here as well.
        self.persist(&mut workspace).await;
        publish.map_err(|e| format!("已导入 {} 项，其余未完成：{e}", imported.len()))?;
        Ok(json!({"imported":imported,"historyWarning":warning}))
    }
    pub(crate) async fn file_history(&self, folder_id: &str) -> Result<Value> {
        let guard = self.folder.lock().await;
        let folder = guard
            .as_ref()
            .filter(|f| f.id == folder_id)
            .ok_or("工程文件夹已改变，请重新操作")?;
        let mut history = History::open(&self.state, folder)?;
        history.checkpoint(folder, "文件改动", None)?;
        Ok(history.list())
    }
    pub(crate) async fn file_history_detail(
        &self,
        folder_id: &str,
        id: &str,
        path: &str,
    ) -> Result<Value> {
        let guard = self.folder.lock().await;
        let folder = guard
            .as_ref()
            .filter(|f| f.id == folder_id)
            .ok_or("工程文件夹已改变，请重新操作")?;
        History::open(&self.state, folder)?.detail(id, path)
    }
    pub(crate) async fn undo_file_history(&self, folder_id: &str, id: &str) -> Result<Value> {
        let guard = self.folder.lock().await;
        let folder = guard
            .as_ref()
            .filter(|f| f.id == folder_id)
            .ok_or("工程文件夹已改变，请重新操作")?;
        let mut history = History::open(&self.state, folder)?;
        history.checkpoint(folder, "文件改动", None)?;
        let change = history.change(id)?;
        history.validate_undo(folder, &change)?;
        let paths = History::paths(&change)
            .iter()
            .map(|p| folder.path.join(p))
            .collect::<Vec<_>>();
        let mut workspace = self.workspace.lock().await;
        let mut references = References::open(&self.state, folder)?;
        // Moving preserves drafts and document identity. Content restoration must not.
        if let Some((from, to)) = &change.movement {
            let target = folder.resolve(from, false).map_err(|e| e.to_string())?;
            if workspace
                .documents
                .values()
                .any(|doc| doc.path.as_ref().is_some_and(|p| p.starts_with(&target)))
            {
                return Err("目标路径已有打开的文档，请先关闭该文档".into());
            }
            let (source, target) = folder.rename(to, from).map_err(|e| e.to_string())?;
            workspace.relocate(&source, &target);
            references.changed(to, Some(from))?;
            history.checkpoint(
                folder,
                &format!("撤销：{}", change.title),
                Some((to.clone(), from.clone())),
            )?;
        } else {
            ensure_clean(&workspace, &paths)?;
            for doc in workspace.documents.values() {
                if let Some(path) = &doc.path
                    && let Ok(relative) = path.strip_prefix(&folder.path)
                    && let Some(value) = change
                        .before
                        .get(&relative.to_string_lossy().replace('\\', "/"))
                    && !value.directory
                {
                    Document::from_bytes(String::new(), None, history.bytes(value)?, true)
                        .map_err(|e| e.to_string())?;
                }
            }
            let result = history.restore(folder, &change);
            if result.is_ok() {
                for path in History::paths(&change) {
                    let before = change.before.get(&path);
                    if before.is_some_and(|v| v.directory) {
                        continue;
                    }
                    references.restore(folder, &path, before.and_then(|v| v.binding.as_deref()))?;
                }
            }
            history.checkpoint(folder, &format!("撤销：{}", change.title), None)?;
            refresh_documents(&mut workspace, &paths)?;
            self.persist(&mut workspace).await;
            result.map_err(|e| format!("撤销未能全部完成，请刷新文件改动：{e}"))?;
        }
        Ok(json!({"restored":true}))
    }
}
