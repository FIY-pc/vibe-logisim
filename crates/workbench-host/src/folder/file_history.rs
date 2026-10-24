//! Content-addressed file history. It lives in application state, never in the project.
use crate::Result;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use vibe_circuit_document::{Folder, digest};

const FILE_LIMIT: u64 = 32 * 1024 * 1024;
const TREE_LIMIT: u64 = 256 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Version {
    pub directory: bool,
    pub digest: String,
    pub stored: bool,
    #[serde(default)]
    pub binding: Option<String>,
}
impl PartialEq for Version {
    fn eq(&self, other: &Self) -> bool {
        self.directory == other.directory
            && self.digest == other.digest
            && self.stored == other.stored
    }
}
impl Eq for Version {}
pub(crate) type Manifest = BTreeMap<String, Version>;
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Change {
    pub id: String,
    pub title: String,
    pub at: u64,
    pub before: Manifest,
    pub after: Manifest,
    #[serde(default)]
    pub movement: Option<(String, String)>,
}
#[derive(Default, Serialize, Deserialize)]
struct Index {
    head: Manifest,
    entries: Vec<Change>,
}
pub(crate) struct History {
    directory: PathBuf,
    index: Index,
}

fn ignored(name: &str) -> bool {
    [".git", "node_modules", "target", ".workbench-state", ".ssh"].contains(&name)
        || name.starts_with(".vibe-file-")
}
pub(crate) fn version(path: &Path) -> Result<Option<Version>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if metadata.is_symlink() {
        return Err("符号链接不能用于覆盖或历史恢复".into());
    }
    if metadata.is_dir() {
        return Ok(Some(Version {
            directory: true,
            digest: String::new(),
            stored: true,
            binding: None,
        }));
    }
    if !metadata.is_file() {
        return Err("只支持普通文件和文件夹".into());
    }
    let stored = metadata.len() <= FILE_LIMIT;
    let signature = if stored {
        digest(&fs::read(path).map_err(|e| e.to_string())?)
    } else {
        format!(
            "large:{}:{:?}",
            metadata.len(),
            metadata.modified().map_err(|e| e.to_string())?
        )
    };
    Ok(Some(Version {
        directory: false,
        digest: signature,
        stored,
        binding: None,
    }))
}
fn scan(
    root: &Path,
    path: &Path,
    blobs: &Path,
    result: &mut Manifest,
    total: &mut u64,
) -> Result<()> {
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if ignored(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if metadata.is_symlink() || (!metadata.is_dir() && !metadata.is_file()) {
            continue;
        }
        if result.len() >= 20_000 {
            return Err("工程文件过多，无法记录文件历史".into());
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let mut value = version(&entry.path())?.ok_or("文件在扫描时已删除，请重试")?;
        if !value.directory && value.stored {
            *total += metadata.len();
            value.stored = *total <= TREE_LIMIT;
            if value.stored {
                let bytes = fs::read(entry.path()).map_err(|e| e.to_string())?;
                if digest(&bytes) != value.digest {
                    return Err("文件正在被其他程序修改，请重试".into());
                }
                let blob = blobs.join(&value.digest);
                if !blob.exists() {
                    write_blob(&blob, &bytes)?;
                }
            }
        }
        result.insert(relative, value);
        if metadata.is_dir() {
            scan(root, &entry.path(), blobs, result, total)?;
        }
    }
    Ok(())
}
/// Publishes `bytes` as a new file of the user's folder (`path` must not exist),
/// with `permissions` when it takes the place of a file.
pub(crate) fn write_new(
    path: &Path,
    bytes: &[u8],
    permissions: Option<fs::Permissions>,
) -> Result<()> {
    let staged = stage(path, bytes, true)?;
    #[cfg(unix)]
    if let Some(permissions) = permissions {
        staged
            .as_file()
            .set_permissions(permissions)
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = permissions;
    publish(staged, path)
}
/// Stores a history blob (`path` must not exist).
fn write_blob(path: &Path, bytes: &[u8]) -> Result<()> {
    publish(stage(path, bytes, false)?, path)
}
/// The bytes in a temporary file next to `path`: private to the user (0600), or
/// with a new file's permissions for a file of the user's folder.
fn stage(path: &Path, bytes: &[u8], user_file: bool) -> Result<tempfile::NamedTempFile> {
    let parent = path.parent().ok_or("无效文件路径")?;
    let mut staged = if user_file {
        crate::staged_user_file(parent)
    } else {
        tempfile::Builder::new()
            .prefix(".vibe-file-")
            .tempfile_in(parent)
    }
    .map_err(|e| e.to_string())?;
    staged.write_all(bytes).map_err(|e| e.to_string())?;
    Ok(staged)
}
fn publish(staged: tempfile::NamedTempFile, path: &Path) -> Result<()> {
    staged.as_file().sync_all().map_err(|e| e.to_string())?;
    staged.persist_noclobber(path).map_err(|e| e.to_string())?;
    Ok(())
}
/// Never overwrite an entry that changed after the user's review. Even the final
/// publish is exclusive, so a concurrent writer keeps its newly-created file.
pub(crate) fn replace_checked(
    path: &Path,
    expected: Option<&Version>,
    bytes: Option<&[u8]>,
) -> Result<()> {
    if version(path)?.as_ref() != expected {
        return Err("文件在此之后又有改动，未覆盖当前内容".into());
    }
    let permissions = fs::metadata(path).ok().map(|m| m.permissions());
    let backup = if expected.is_some() {
        let directory = tempfile::Builder::new()
            .prefix(".vibe-file-")
            .tempdir_in(path.parent().ok_or("无效路径")?)
            .map_err(|e| e.to_string())?;
        let saved = directory.path().join("previous");
        fs::rename(path, &saved).map_err(|e| e.to_string())?;
        if version(&saved).ok().flatten().as_ref() != expected {
            if let Ok(bytes) = fs::read(&saved)
                && write_new(path, &bytes, permissions.clone()).is_ok()
            {
                let _ = fs::remove_file(&saved);
            }
            // Preserve the unexpected content if another writer also recreated the path.
            if saved.exists() {
                let retained = directory.keep();
                return Err(format!(
                    "文件正在被其他程序修改；原内容保留在 {}",
                    retained.display()
                )
                .into());
            }
            return Err("文件正在被其他程序修改，请重试".into());
        }
        Some((directory, saved))
    } else {
        None
    };
    if let Some(bytes) = bytes
        && let Err(error) = write_new(path, bytes, permissions.clone())
    {
        if let Some((directory, saved)) = backup {
            if let Ok(bytes) = fs::read(&saved)
                && write_new(path, &bytes, permissions.clone()).is_ok()
            {
                let _ = fs::remove_file(&saved);
            }
            if saved.exists() {
                let retained = directory.keep();
                return Err(format!("{error}；原内容保留在 {}", retained.display()).into());
            }
        }
        return Err(error);
    }
    Ok(())
}
/// Resolve without accepting a symlink at any level, including internal aliases.
/// Missing parents are permitted during preflight and created by the restore.
fn restore_path(folder: &Folder, relative: &str) -> Result<PathBuf> {
    let mut path = folder.path.clone();
    for component in Path::new(relative).components() {
        let std::path::Component::Normal(name) = component else {
            return Err("无效的历史路径".into());
        };
        path.push(name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_symlink() => {
                return Err("历史路径现为符号链接，未恢复文件".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(path)
}
impl History {
    pub fn open(state: &Path, folder: &Folder) -> Result<Self> {
        let directory = state
            .join("file-history")
            .join(digest(folder.id.as_bytes()));
        fs::create_dir_all(directory.join("blobs")).map_err(|e| e.to_string())?;
        let index_path = directory.join("index.json");
        let index = if index_path.exists() {
            serde_json::from_slice(&fs::read(index_path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("文件历史无法读取：{e}"))?
        } else {
            Index::default()
        };
        let mut history = Self { directory, index };
        if !history.directory.join("index.json").exists() {
            history.index.head = history.snapshot(folder)?;
            history.save()?;
        }
        Ok(history)
    }
    pub fn snapshot(&self, folder: &Folder) -> Result<Manifest> {
        let mut result = BTreeMap::new();
        scan(
            &folder.path,
            &folder.path,
            &self.directory.join("blobs"),
            &mut result,
            &mut 0,
        )?;
        let state = self
            .directory
            .parent()
            .and_then(Path::parent)
            .ok_or("无效历史目录")?;
        let bindings = super::file_references::References::open(state, folder)?.bindings(folder);
        for (path, version) in &mut result {
            version.binding = bindings.get(path).cloned();
        }
        Ok(result)
    }
    fn save(&self) -> Result<()> {
        let mut file =
            tempfile::NamedTempFile::new_in(&self.directory).map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut file, &self.index).map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        file.persist(self.directory.join("index.json"))
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    /// Records what changed since the last checkpoint. The entry comes back
    /// when a difference was recorded; an unchanged folder records nothing.
    pub fn checkpoint(
        &mut self,
        folder: &Folder,
        title: &str,
        movement: Option<(String, String)>,
    ) -> Result<Option<Change>> {
        let current = self.snapshot(folder)?;
        if current == self.index.head && movement.is_none() {
            self.index.head = current;
            self.save()?;
            return Ok(None);
        }
        let mut before = Manifest::new();
        let mut after = Manifest::new();
        for path in self.index.head.keys().chain(current.keys()) {
            if self.index.head.get(path) != current.get(path) {
                if let Some(value) = self.index.head.get(path) {
                    before.insert(path.clone(), value.clone());
                }
                if let Some(value) = current.get(path) {
                    after.insert(path.clone(), value.clone());
                }
            }
        }
        let change = Change {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.into(),
            at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            before,
            after,
            movement,
        };
        self.index.entries.insert(0, change.clone());
        self.index.entries.truncate(100);
        self.index.head = current;
        self.save()?;
        // Bound retained history by references, rather than leaking abandoned blobs.
        let used: std::collections::BTreeSet<&str> = self
            .index
            .head
            .values()
            .chain(
                self.index
                    .entries
                    .iter()
                    .flat_map(|c| c.before.values().chain(c.after.values())),
            )
            .filter(|v| v.stored && !v.directory)
            .map(|v| v.digest.as_str())
            .collect();
        for blob in fs::read_dir(self.directory.join("blobs")).map_err(|e| e.to_string())? {
            let blob = blob.map_err(|e| e.to_string())?;
            if !used.contains(blob.file_name().to_string_lossy().as_ref()) {
                fs::remove_file(blob.path()).map_err(|e| e.to_string())?;
            }
        }
        Ok(Some(change))
    }
    pub fn change(&self, id: &str) -> Result<Change> {
        self.index
            .entries
            .iter()
            .find(|e| e.id == id)
            .cloned()
            .ok_or("文件历史已更新，请刷新".into())
    }
    pub fn paths(change: &Change) -> Vec<String> {
        change
            .before
            .keys()
            .chain(change.after.keys())
            .cloned()
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect()
    }
    pub fn undoable(change: &Change) -> bool {
        change.movement.is_some()
            || change
                .before
                .values()
                .chain(change.after.values())
                .all(|v| v.stored)
    }
    /// One change as the history lists it: what it was called, when, whether
    /// it can be undone and the files it touched.
    pub fn entry(change: &Change) -> serde_json::Value {
        serde_json::json!({ "id":change.id,"title":change.title,"at":change.at,"undoable":Self::undoable(change),"files":Self::paths(change).iter().map(|path| serde_json::json!({"path":path,"kind":if !change.before.contains_key(path){"added"}else if !change.after.contains_key(path){"deleted"}else{"modified"}})).collect::<Vec<_>>() })
    }
    pub fn list(&self) -> serde_json::Value {
        serde_json::json!(
            self.index
                .entries
                .iter()
                .map(Self::entry)
                .collect::<Vec<_>>()
        )
    }
    pub fn bytes(&self, value: &Version) -> Result<Vec<u8>> {
        if !value.stored || value.directory {
            return Err("此项没有可恢复的文件内容".into());
        }
        let bytes = fs::read(self.directory.join("blobs").join(&value.digest))
            .map_err(|e| e.to_string())?;
        if digest(&bytes) != value.digest {
            return Err("文件历史内容损坏，未改动当前文件".into());
        }
        Ok(bytes)
    }
    pub fn detail(&self, id: &str, path: &str) -> Result<serde_json::Value> {
        let change = self.change(id)?;
        if !Self::paths(&change).iter().any(|p| p == path) {
            return Err("此文件不属于所选改动".into());
        }
        let preview = |v: Option<&Version>| -> Result<serde_json::Value> {
            let Some(v) = v else {
                return Ok(serde_json::Value::Null);
            };
            if v.directory {
                return Ok(serde_json::json!({"kind":"directory"}));
            }
            if !v.stored {
                return Ok(serde_json::json!({"kind":"large"}));
            }
            let bytes = self.bytes(v)?;
            if bytes.contains(&0) {
                return Ok(serde_json::json!({"kind":"binary"}));
            }
            let Ok(text) = String::from_utf8(bytes) else {
                return Ok(serde_json::json!({"kind":"binary"}));
            };
            let clipped: String = text.chars().take(200_000).collect();
            Ok(
                serde_json::json!({"kind":"text","truncated":clipped.len()!=text.len(),"text":clipped}),
            )
        };
        Ok(
            serde_json::json!({"before":preview(change.before.get(path))?,"after":preview(change.after.get(path))?}),
        )
    }
    pub fn validate_undo(&self, folder: &Folder, change: &Change) -> Result<()> {
        if !Self::undoable(change) {
            return Err("此改动包含未保留内容的大文件，无法撤销".into());
        }
        let current = self.snapshot(folder)?;
        for relative in Self::paths(change) {
            restore_path(folder, &relative)?;
            if let Some(value) = change.before.get(&relative).filter(|v| !v.directory) {
                self.bytes(value)?;
            }
            if current.get(&relative) != change.after.get(&relative) {
                return Err(format!("“{relative}”在此之后又有改动，未覆盖当前内容").into());
            }
            // A newly added directory may now contain unrelated files, including
            // ignored entries. Never remove it recursively while undoing an import.
            if change.after.get(&relative).is_some_and(|v| v.directory)
                && !change.before.contains_key(&relative)
            {
                // read_dir also sees ignored and symlink entries omitted by snapshots.
                for child in fs::read_dir(folder.path.join(&relative)).map_err(|e| e.to_string())? {
                    let child = child.map_err(|e| e.to_string())?;
                    let path = format!("{relative}/{}", child.file_name().to_string_lossy());
                    if !change.after.contains_key(&path) {
                        return Err(format!("“{relative}”含有后续新增文件，无法撤销").into());
                    }
                }
            }
        }
        Ok(())
    }
    pub fn restore(&self, folder: &Folder, change: &Change) -> Result<()> {
        self.validate_undo(folder, change)?;
        let paths = Self::paths(change);
        // Remove files before directories; restore directories before their children.
        for relative in paths.iter().rev() {
            if change.before.get(relative).is_none_or(|v| v.directory) {
                if let Some(value) = change.after.get(relative).filter(|v| !v.directory) {
                    let path = restore_path(folder, relative)?;
                    replace_checked(&path, Some(value), None)?;
                }
                if !change.before.contains_key(relative)
                    && change.after.get(relative).is_some_and(|v| v.directory)
                {
                    let path = restore_path(folder, relative)?;
                    fs::remove_dir(path)
                        .map_err(|e| format!("文件夹已有其他内容或正在使用：{e}"))?;
                }
            }
        }
        for relative in &paths {
            if let Some(value) = change.before.get(relative) {
                let path = restore_path(folder, relative)?;
                if value.directory {
                    if !path.exists() {
                        fs::create_dir(path).map_err(|e| e.to_string())?;
                    }
                } else {
                    if change.after.get(relative).is_some_and(|v| v.directory) {
                        fs::remove_dir(&path).map_err(|e| e.to_string())?;
                    }
                    let expected = change.after.get(relative).filter(|v| !v.directory);
                    replace_checked(&path, expected, Some(&self.bytes(value)?))?;
                }
            }
        }
        Ok(())
    }
}
