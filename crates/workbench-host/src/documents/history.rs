use crate::{Host, Result, api::document::fitted_viewport, value};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    time::SystemTime,
};
use vibe_circuit_document::{
    Document, Edit, SourceStatus,
    history::{DocumentHistory, HistoricalSnapshot, HistoryEntry},
};

/// Library digests by path, valid while the file's length and modification
/// time stay the same.
pub(crate) type Digests = HashMap<PathBuf, (u64, SystemTime, String)>;

#[derive(Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryList {
    entries: Vec<HistoryEntry>,
    current_revision: String,
    saved_revision: Option<String>,
}
/// One history entry with the source before and after it.
#[derive(Serialize, ts_rs::TS)]
pub struct HistoryReview {
    entry: HistoryEntry,
    mode: String,
    original: String,
    xml: String,
}
#[derive(Clone)]
pub(crate) struct Action {
    pub kind: &'static str,
    pub title: String,
    pub target: Option<String>,
    pub restored: Option<String>,
}
impl Action {
    pub(crate) fn open() -> Self {
        Self {
            kind: "open",
            title: "打开工程".into(),
            target: None,
            restored: None,
        }
    }
    pub(crate) fn files() -> Self {
        Self {
            kind: "files",
            title: "工程文件更新".into(),
            target: None,
            restored: None,
        }
    }
    pub(crate) fn document(kind: &'static str, title: &str, id: &str) -> Self {
        Self {
            kind,
            title: title.into(),
            target: Some(id.to_string()),
            restored: None,
        }
    }
    pub(crate) fn edit(id: &str, edit: &Edit) -> Self {
        let title = match edit {
            Edit::Place { .. } => "放置元件",
            Edit::Wire { .. } => "绘制导线",
            Edit::Move { .. } => "移动对象",
            Edit::Attributes { .. } => "修改元件属性",
            Edit::Replace { .. } => "替换电路内容",
            Edit::AddCircuit { .. } => "添加电路",
            Edit::RenameCircuit { .. } => "重命名电路",
            Edit::DeleteCircuit => "删除电路",
            Edit::SetMain => "设置主电路",
            _ => "编辑电路",
        };
        Self::document("edit", title, id)
    }
    /// The same action under the title the edit or undo reported.
    pub(crate) fn entitled(mut self, title: String) -> Self {
        self.title = title;
        self
    }
    pub(crate) fn restore(id: &str, entry: &str) -> Self {
        Self {
            restored: Some(entry.to_string()),
            ..Self::document("restore", "恢复历史版本", id)
        }
    }
}
impl Host {
    pub(crate) fn history_store(&self) -> &DocumentHistory {
        &self.history
    }
    pub(crate) fn history_snapshot(&self, doc: &Document) -> Result<HistoricalSnapshot> {
        Ok(HistoricalSnapshot {
            name: doc.name().to_string(),
            path: doc.path.clone(),
            revision: doc.revision(),
            dependencies: self.dependencies(doc).ok(),
            bytes: doc.bytes().into(),
        })
    }
    /// The library files a document loads, with the digest of each, resolved
    /// the way the native loader does: relative to the document's folder, or
    /// by file name in that folder. A circuit library brings its own
    /// libraries. A file that cannot be found is recorded as `missing`.
    pub(crate) fn dependencies(&self, doc: &Document) -> Result<BTreeMap<PathBuf, String>> {
        let directory = doc.path.as_deref().and_then(Path::parent);
        let mut dependencies = BTreeMap::new();
        for desc in doc.library_descriptors() {
            let (name, circuit) = if let Some(name) = desc.strip_prefix("file#") {
                (name, true)
            } else if let Some(name) = desc.strip_prefix("jar#") {
                (name.split_once('#').map_or(name, |(file, _)| file), false)
            } else {
                continue;
            };
            let mut path = match directory {
                Some(directory) => directory.join(name),
                None => PathBuf::from(name),
            };
            if let Some(directory) = directory
                && !path.is_file()
            {
                path = directory.join(name.replace('\\', "/").rsplit('/').next().unwrap_or(name));
            }
            // An untitled document has no folder to resolve a relative path in.
            if !path.is_absolute() || !path.is_file() {
                dependencies.insert(path, "missing".into());
                continue;
            }
            let path = path.canonicalize().map_err(|e| e.to_string())?;
            dependencies.insert(path.clone(), self.file_digest(&path)?);
            if circuit {
                dependencies.extend(vibe_logisim_runtime::artifact_dependencies(&path)?);
            }
        }
        Ok(dependencies)
    }
    fn file_digest(&self, path: &Path) -> Result<String> {
        let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
        let stamp = metadata.modified().ok().map(|time| (metadata.len(), time));
        let mut digests = self.digests.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((len, time)) = stamp
            && let Some((known_len, known_time, digest)) = digests.get(path)
            && (*known_len, *known_time) == (len, time)
        {
            return Ok(digest.clone());
        }
        let digest =
            vibe_circuit_document::digest(&std::fs::read(path).map_err(|e| e.to_string())?);
        if let Some((len, time)) = stamp {
            digests.insert(path.to_path_buf(), (len, time, digest.clone()));
        }
        Ok(digest)
    }
    pub(crate) async fn history_before(
        &self,
        action: &Action,
    ) -> Result<BTreeMap<String, (Document, HistoricalSnapshot)>> {
        let documents = self
            .workspace
            .lock()
            .await
            .documents
            .iter()
            .filter(|(id, _)| action.target.as_ref().is_none_or(|target| *id == target))
            .map(|(id, d)| (id.clone(), d.clone()))
            .collect::<Vec<_>>();
        documents
            .into_iter()
            .map(|(id, doc)| {
                let snapshot = self.history_snapshot(&doc)?;
                Ok((id, (doc, snapshot)))
            })
            .collect()
    }
    pub(crate) async fn history_after(
        &self,
        action: &Action,
        before: BTreeMap<String, (Document, HistoricalSnapshot)>,
    ) -> Result<()> {
        let documents = self
            .workspace
            .lock()
            .await
            .documents
            .iter()
            .filter(|(id, _)| action.target.as_ref().is_none_or(|target| *id == target))
            .map(|(id, d)| (id.clone(), d.clone()))
            .collect::<Vec<_>>();
        let store = self.history_store();
        for (id, doc) in documents {
            let previous = before.get(&id);
            let changed = previous
                .is_none_or(|(old, _)| old.revision() != doc.revision() || old.path != doc.path);
            if !changed && action.kind != "save" {
                continue;
            }
            let after = self.history_snapshot(&doc)?;
            let kind = if previous.is_none() {
                "open"
            } else {
                action.kind
            };
            store
                .append(
                    &id,
                    previous.map(|(_, s)| s),
                    &after,
                    kind,
                    if kind == "open" {
                        "打开工程"
                    } else {
                        &action.title
                    },
                    action.restored.clone(),
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub(crate) async fn history_list(&self, id: &str) -> Result<Value> {
        let _gate = self.history_gate.lock().await;
        let doc = self
            .workspace
            .lock()
            .await
            .get(id)
            .map_err(|e| e.to_string())?
            .clone();
        let entries = self
            .history_store()
            .entries(id)
            .map_err(|e| e.to_string())?;
        value(HistoryList {
            entries,
            current_revision: doc.revision(),
            saved_revision: doc.saved_revision().map(str::to_string),
        })
    }
    async fn history_pair(
        &self,
        id: &str,
        revision: &str,
        entry: &str,
        mode: &str,
    ) -> Result<(HistoryEntry, HistoricalSnapshot, HistoricalSnapshot)> {
        if !matches!(mode, "change" | "current") {
            return Err("无效对照方式".into());
        }
        let doc = self
            .workspace
            .lock()
            .await
            .get(id)
            .map_err(|e| e.to_string())?
            .clone();
        doc.check(revision).map_err(|e| e.to_string())?;
        let (entry, before, after) = self
            .history_store()
            .resolve(id, entry, mode == "change")
            .map_err(|e| e.to_string())?;
        if mode == "current" {
            Ok((entry, after, self.history_snapshot(&doc)?))
        } else {
            Ok((entry, before.unwrap_or_else(|| after.clone()), after))
        }
    }
    pub(crate) fn historical_native(
        &self,
        id: &str,
        snapshot: &HistoricalSnapshot,
    ) -> Result<Document> {
        let doc = snapshot.document(id).map_err(|e| e.to_string())?;
        let expected = snapshot
            .dependencies
            .as_ref()
            .ok_or("这个历史版本没有冻结的组件库身份，无法精确重放；源码仍可查看和恢复")?;
        if &self.dependencies(&doc)? != expected {
            return Err("此版本引用的组件库已改变，不能用当前库冒充历史运行结果".into());
        }
        Ok(doc)
    }
    pub(crate) async fn history_review(
        &self,
        id: &str,
        revision: &str,
        entry: &str,
        mode: &str,
    ) -> Result<Value> {
        let (entry, before, after) = self.history_pair(id, revision, entry, mode).await?;
        value(HistoryReview {
            entry,
            mode: mode.into(),
            original: before.xml(),
            xml: after.xml(),
        })
    }
    pub(crate) async fn history_preview(
        &self,
        id: &str,
        revision: &str,
        entry: &str,
        mode: &str,
        circuit: &str,
        candidate: bool,
    ) -> Result<Value> {
        let (_, before, after) = self.history_pair(id, revision, entry, mode).await?;
        let chosen = if candidate { after } else { before };
        let doc = self.historical_native(id, &chosen)?;
        self.preview_document(&doc, circuit).await
    }
    /// A fitted image of one circuit of a document that is not open: a
    /// historical version. Static observation and rendering use the circuit
    /// worker, independently of the live simulation.
    async fn preview_document(&self, doc: &Document, circuit: &str) -> Result<Value> {
        if doc
            .circuit_view(circuit)
            .map_err(|e| e.to_string())?
            .is_none()
        {
            return Ok(json!({"image":null,"missing":true,"warnings":[]}));
        }
        let path = self.materialize(doc)?;
        let mut native = self.native.lock().await;
        let observed = native.observe(&path, circuit).await?;
        let viewport = fitted_viewport(&observed);
        let image = native.render(&path, circuit, viewport).await?;
        Ok(json!({
            "image":image,
            "missing":false,
            "warnings":observed["project"]["loaderMessages"],
            "bounds":{"x":viewport.x,"y":viewport.y,"width":viewport.width,"height":viewport.height},
        }))
    }
    pub(crate) async fn history_restore(
        &self,
        id: &str,
        revision: &str,
        entry: &str,
    ) -> Result<Value> {
        let (_, _, snapshot) = self
            .history_store()
            .resolve(id, entry, false)
            .map_err(|e| e.to_string())?;
        let historical = snapshot.document(id).map_err(|e| e.to_string())?;
        if snapshot.dependencies.is_some() {
            self.historical_native(id, &snapshot)?;
        }
        let mut workspace = self.workspace.lock().await;
        let current = workspace.get_mut(id).map_err(|e| e.to_string())?;
        current.check(revision).map_err(|e| e.to_string())?;
        if !matches!(
            current.source_status(),
            SourceStatus::Untitled | SourceStatus::Unchanged { .. }
        ) {
            return Err("磁盘源文件已改变，请先处理外部改动".into());
        }
        let xml = String::from_utf8(
            historical
                .bytes_at_path(current.path.as_deref())
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let main = current.view().map_err(|e| e.to_string())?.main;
        current
            .edit(revision, &main, Edit::Replace { xml })
            .map_err(|e| e.to_string())?;
        value(current.view().map_err(|e| e.to_string())?)
    }
}
