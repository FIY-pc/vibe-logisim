//! Durable logical file bindings, independent of the bounded content history.
use crate::{Host, HostError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
};
use vibe_workspace_core::{Folder, digest};
#[derive(Serialize, Deserialize)]
struct Anchor {
    path: String,
    node: String,
}
#[derive(Serialize, Deserialize)]
struct FileIdentity {
    path: String,
    key: String,
    retired: bool,
}
#[derive(Serialize, Deserialize)]
struct Movement {
    version: u32,
    from: String,
    to: Option<String>,
}
#[derive(Default, Serialize, Deserialize)]
struct Journal {
    version: u32,
    anchors: BTreeMap<u32, Anchor>,
    nodes: BTreeMap<String, FileIdentity>,
    movements: Vec<Movement>,
}
pub(crate) struct References {
    file: PathBuf,
    journal: Journal,
}
#[cfg(unix)]
fn file_key(file: &fs::File) -> Result<String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    // Birth time also detects inode reuse after an out-of-app deletion.
    Ok(format!(
        "{}:{}:{:?}",
        metadata.dev(),
        metadata.ino(),
        metadata.created().ok()
    ))
}
#[cfg(windows)]
fn file_key(file: &fs::File) -> Result<String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{FILE_ID_INFO, FileIdInfo, GetFileInformationByHandleEx},
    };
    let mut info = FILE_ID_INFO::default();
    // The handle remains open throughout this query. Unsupported file systems fail
    // explicitly; a same-name file must never be accepted as an identity fallback.
    unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    }
    .map_err(|e| format!("无法确认文件身份：{e}"))?;
    Ok(format!(
        "{}:{:?}",
        info.VolumeSerialNumber, info.FileId.Identifier
    ))
}
fn under(path: &str, parent: &str) -> bool {
    path == parent || path.starts_with(&(parent.to_owned() + "/"))
}
fn relative_path(folder: &Folder, path: &Path) -> Result<String> {
    Ok(path
        .strip_prefix(&folder.path)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/"))
}
fn path_key(folder: &Folder, path: &str) -> Result<String> {
    let path = folder.resolve(path, true).map_err(|e| e.to_string())?;
    file_key(&fs::File::open(path).map_err(|e| e.to_string())?)
}
fn reference_url(path: &str, version: u32) -> String {
    let mut encoded = String::new();
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    format!("workspace://{encoded}?pathVersion={version}")
}
impl References {
    pub fn open(state: &Path, folder: &Folder) -> Result<Self> {
        let directory = state.join("file-references");
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let file = directory.join(format!("{}.json", digest(folder.id.as_bytes())));
        let journal = if file.exists() {
            let bytes = fs::read(&file).map_err(|e| e.to_string())?;
            serde_json::from_slice(&bytes).map_err(|e| format!("文件路径记录无法读取：{e}"))?
        } else {
            Journal::default()
        };
        Ok(Self { file, journal })
    }
    fn next(&mut self) -> Result<u32> {
        self.journal.version = self
            .journal
            .version
            .checked_add(1)
            .ok_or("文件路径版本已达到上限")?;
        Ok(self.journal.version)
    }
    fn save(&self) -> Result<()> {
        let mut staged = tempfile::NamedTempFile::new_in(self.file.parent().ok_or("无效状态目录")?)
            .map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut staged, &self.journal).map_err(|e| e.to_string())?;
        staged.as_file().sync_all().map_err(|e| e.to_string())?;
        staged.persist(&self.file).map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn changed(&mut self, from: &str, to: Option<&str>) -> Result<()> {
        let from = from.replace('\\', "/");
        let to = to.map(|p| p.replace('\\', "/"));
        for node in self
            .journal
            .nodes
            .values_mut()
            .filter(|n| !n.retired && under(&n.path, &from))
        {
            if let Some(to) = &to {
                node.path = to.clone() + &node.path[from.len()..];
            } else {
                node.retired = true;
            }
        }
        let version = self.next()?;
        self.journal.movements.push(Movement { version, from, to });
        self.save()
    }
    pub fn bindings(&self, folder: &Folder) -> BTreeMap<String, String> {
        self.journal
            .nodes
            .iter()
            .filter(|(_, node)| {
                !node.retired && path_key(folder, &node.path).is_ok_and(|key| key == node.key)
            })
            .map(|(id, node)| (node.path.clone(), id.clone()))
            .collect()
    }
    /// Only call after an app-controlled write whose original document/source
    /// revisions were checked. External replacements never pass through this path.
    pub fn refresh_known(&mut self, folder: &Folder, path: &str) -> Result<()> {
        let key = path_key(folder, path)?;
        let mut changed = false;
        for node in self
            .journal
            .nodes
            .values_mut()
            .filter(|n| !n.retired && n.path == path)
        {
            node.key = key.clone();
            changed = true;
        }
        if changed {
            self.save()?;
        }
        Ok(())
    }
    pub fn restore(&mut self, folder: &Folder, path: &str, binding: Option<&str>) -> Result<()> {
        for node in self
            .journal
            .nodes
            .values_mut()
            .filter(|n| !n.retired && n.path == path)
        {
            node.retired = true;
        }
        if let Some(binding) = binding {
            let key = path_key(folder, path)?;
            let node = self
                .journal
                .nodes
                .get_mut(binding)
                .ok_or("原文件的身份记录不存在，无法恢复引用")?;
            node.path = path.into();
            node.key = key;
            node.retired = false;
        }
        self.save()
    }
    pub fn read(
        &mut self,
        folder: &Folder,
        relative: &str,
        limit: u64,
    ) -> Result<(Vec<u8>, Value)> {
        let path = folder.resolve(relative, true).map_err(|e| e.to_string())?;
        let file = fs::File::open(&path).map_err(|e| e.to_string())?;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if !metadata.is_file() {
            return Err("请选择普通文件".into());
        }
        if metadata.len() > limit {
            return Err(format!("文件超过 {} MB，无法预览", limit / 1024 / 1024).into());
        }
        let key = file_key(&file)?;
        let mut bytes = Vec::new();
        file.take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > limit {
            return Err("文件在读取时增大，请重试".into());
        }
        if file_key(&fs::File::open(&path).map_err(|e| e.to_string())?)? != key {
            return Err("文件在读取时被替换，请重试".into());
        }
        let relative = relative_path(folder, &path)?;
        let existing = self
            .journal
            .nodes
            .iter()
            .find(|(_, node)| !node.retired && node.path == relative && node.key == key)
            .map(|(id, _)| id.clone());
        let node = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        for (id, other) in self
            .journal
            .nodes
            .iter_mut()
            .filter(|(_, other)| !other.retired && other.path == relative)
        {
            if id != &node {
                other.retired = true;
            }
        }
        self.journal.nodes.insert(
            node.clone(),
            FileIdentity {
                path: relative.clone(),
                key,
                retired: false,
            },
        );
        let version = self.next()?;
        self.journal.anchors.insert(
            version,
            Anchor {
                path: relative.clone(),
                node,
            },
        );
        self.save()?;
        Ok((
            bytes.clone(),
            json!({"path":relative,"relativePath":relative,"folderId":folder.id,"pathVersion":version,"revision":digest(&bytes),"url":reference_url(&relative,version)}),
        ))
    }
    pub fn resolve(&self, folder: &Folder, path: &str, version: Option<u32>) -> Result<Value> {
        let version = version.ok_or("此引用缺少路径版本，无法确认原文件")?;
        let anchor = self
            .journal
            .anchors
            .get(&version)
            .filter(|a| a.path == path.replace('\\', "/"))
            .ok_or("此引用的路径记录不存在，无法确认原文件")?;
        let node = self
            .journal
            .nodes
            .get(&anchor.node)
            .ok_or("文件身份记录不存在")?;
        if node.retired {
            return Err("原引用文件已删除或被覆盖".into());
        }
        if path_key(folder, &node.path).map_err(|_| "原引用文件不存在，请从文件树确认当前位置")?
            != node.key
        {
            return Err("文件身份已改变，未打开同名的新文件".into());
        }
        Ok(json!({"path":node.path,"folderId":folder.id,"pathVersion":version}))
    }
}
impl Host {
    /// A successful structural edit remains a success even if writing its source fails.
    pub(crate) async fn auto_save_edit(&self, result: &mut Value) {
        let (Some(id), Some(revision)) = (result["id"].as_str(), result["revision"].as_str())
        else {
            return;
        };
        let (id, revision) = (id.to_owned(), revision.to_owned());
        let guard = self.folder.lock().await;
        let Some(folder) = guard.as_ref() else {
            return;
        };
        let mut workspace = self.workspace.lock().await;
        let Ok(document) = workspace.get(&id) else {
            return;
        };
        let Some(path) = document
            .path
            .as_ref()
            .filter(|path| path.starts_with(&folder.path))
            .cloned()
        else {
            return;
        };
        // Resolve the real target again: a replaced parent symlink must never redirect an automatic write.
        let check = relative_path(folder, &path).and_then(|relative| {
            let resolved = folder.resolve(&relative, true).map_err(|e| e.to_string())?;
            if resolved != path {
                return Err("源文件位置已改变，请重新确认保存位置".into());
            }
            Ok(relative)
        });
        let saved = check.and_then(|relative| {
            workspace
                .save_checked(&id, &revision, None, None)
                .map(|saved| (relative, saved))
                .map_err(HostError::from)
        });
        drop(workspace);
        match saved {
            Ok((relative, saved)) => {
                if let Ok(value) = serde_json::to_value(saved) {
                    *result = value;
                }
                if let Err(error) = References::open(&self.state, folder)
                    .and_then(|mut references| references.refresh_known(folder, &relative))
                {
                    result["referenceWarning"] = json!(error.to_string());
                }
            }
            Err(error) => {
                result["saveError"] = json!(error.to_string());
            }
        }
    }
    pub(crate) async fn save_with_references(
        &self,
        id: &str,
        revision: &str,
        path: Option<&Path>,
        target_revision: Option<&str>,
    ) -> Result<Value> {
        // All file operations acquire folder before workspace. Holding the folder
        // guard also prevents a read from rebinding the new inode midway through save.
        let guard = self.folder.lock().await;
        let mut workspace = self.workspace.lock().await;
        let original = workspace.get(id).map_err(|e| e.to_string())?.path.clone();
        let saved = workspace
            .save_checked(id, revision, path, target_revision)
            .map_err(|e| e.to_string())?;
        drop(workspace);
        let mut result = serde_json::to_value(&saved).map_err(|e| e.to_string())?;
        if let Some(path) = saved
            .path
            .as_ref()
            .filter(|path| Some(*path) == original.as_ref())
            && let Some(folder) = guard.as_ref().filter(|f| path.starts_with(&f.path))
        {
            let relative = relative_path(folder, path)?;
            if let Err(error) = References::open(&self.state, folder)
                .and_then(|mut references| references.refresh_known(folder, &relative))
            {
                result["referenceWarning"] = json!(error.to_string());
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod autosave_tests {
    use crate::{EditingRequest, FolderRequest, Host, WorkspaceRequest};
    use serde_json::Value;
    use vibe_workspace_core::{EMPTY_CIRCUIT, Edit};
    async fn rename(host: &Host, doc: &Value, name: &str) -> Value {
        let result = host
            .dispatch(EditingRequest::Edit {
                id: doc["id"].as_str().unwrap().into(),
                revision: doc["revision"].as_str().unwrap().into(),
                circuit: doc["main"].as_str().unwrap().into(),
                edit: Edit::RenameCircuit { name: name.into() },
            })
            .await
            .unwrap();
        // Edits answer with what changed plus the resulting view.
        result.get("view").cloned().unwrap_or(result)
    }
    #[tokio::test]
    async fn structural_edits_save_only_project_sources_and_conflicts_keep_drafts() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let source = project.join("main.circ");
        std::fs::write(&source, EMPTY_CIRCUIT).unwrap();
        let host = Host::new(temp.path().into(), temp.path().join("state"), None).unwrap();
        let folder = host
            .dispatch(FolderRequest::FolderOpen {
                path: project.clone(),
            })
            .await
            .unwrap();
        let original = host
            .dispatch(WorkspaceRequest::Open {
                path: source.clone(),
            })
            .await
            .unwrap();
        let reference = host
            .dispatch(FolderRequest::FolderRead {
                path: "main.circ".into(),
                folder_id: Some(folder["id"].as_str().unwrap().into()),
            })
            .await
            .unwrap();
        let saved = rename(&host, &original, "changed").await;
        assert_eq!(saved["dirty"], false);
        assert!(saved["saveError"].is_null());
        assert!(
            std::fs::read_to_string(&source)
                .unwrap()
                .contains("changed")
        );
        host.dispatch(FolderRequest::FolderResolve {
            folder_id: folder["id"].as_str().unwrap().into(),
            path: "main.circ".into(),
            path_version: Some(reference["pathVersion"].as_u64().unwrap() as u32),
        })
        .await
        .unwrap();
        let undone = host
            .dispatch(EditingRequest::Undo {
                id: saved["id"].as_str().unwrap().into(),
                revision: saved["revision"].as_str().unwrap().into(),
            })
            .await
            .unwrap();
        let undone = undone.get("view").cloned().unwrap_or(undone);
        assert_eq!(undone["dirty"], false);
        assert_eq!(undone["main"], original["main"]);
        let prior = std::fs::read(&source).unwrap();
        std::fs::write(&source, b"external user content").unwrap();
        let draft = rename(&host, &undone, "preserved").await;
        assert_eq!(draft["dirty"], true);
        assert!(draft["saveError"].is_string());
        assert_eq!(draft["main"], "preserved");
        assert_eq!(std::fs::read(&source).unwrap(), b"external user content");
        assert!(host.state.join("workspace.json").exists());
        std::fs::write(&source, prior).unwrap();
        let retry = host
            .dispatch(WorkspaceRequest::Save {
                id: draft["id"].as_str().unwrap().into(),
                revision: draft["revision"].as_str().unwrap().into(),
                path: None,
                target_revision: None,
            })
            .await
            .unwrap();
        assert_eq!(retry["dirty"], false);
        let outside = temp.path().join("outside.circ");
        std::fs::write(&outside, EMPTY_CIRCUIT).unwrap();
        let external = host
            .dispatch(WorkspaceRequest::Open {
                path: outside.clone(),
            })
            .await
            .unwrap();
        let external = rename(&host, &external, "outsideDraft").await;
        assert_eq!(external["dirty"], true);
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), EMPTY_CIRCUIT);
        let untitled = host
            .dispatch(WorkspaceRequest::New {
                name: "untitled.circ".into(),
            })
            .await
            .unwrap();
        let untitled = rename(&host, &untitled, "untitledDraft").await;
        assert_eq!(untitled["dirty"], true);
        assert!(untitled["saveError"].is_null());
        let report = host.diagnostics().await;
        assert!(
            report["failures"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["stage"] == "save")
        );
        assert!(!report.to_string().contains(temp.path().to_str().unwrap()));
    }
}
