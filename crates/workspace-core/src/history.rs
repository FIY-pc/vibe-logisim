//! Immutable document versions, independent of the editor's undo/redo stacks.
use crate::{Document, Error, Result, digest};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoricalSnapshot {
    pub name: String,
    pub path: Option<PathBuf>,
    pub xml: String,
    pub revision: String,
    pub dependencies: Option<BTreeMap<PathBuf, String>>,
}
impl HistoricalSnapshot {
    pub fn document(&self, id: &str) -> Result<Document> {
        if digest(self.xml.as_bytes()) != self.revision {
            return Err(Error::InvalidDocument("历史快照内容已改变".into()));
        }
        let mut d = Document::from_bytes(
            self.name.clone(),
            self.path.clone(),
            self.xml.as_bytes().to_vec(),
            false,
        )?;
        d.id = format!("{id}-history");
        Ok(d)
    }
}
#[derive(Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub created_at: f64,
    pub before_revision: Option<String>,
    pub revision: String,
    pub baseline: bool,
    pub saved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub restored_from: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct StoredEntry {
    entry: HistoryEntry,
    before: Option<String>,
    after: String,
}
#[derive(Default, Serialize, Deserialize)]
struct Record {
    entries: Vec<StoredEntry>,
    saved: Option<String>,
}
pub struct DocumentHistory {
    root: PathBuf,
}
impl DocumentHistory {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
    fn directory(&self, id: &str) -> Result<PathBuf> {
        uuid::Uuid::parse_str(id).map_err(|_| Error::InvalidCommand("无效文档标识".into()))?;
        Ok(self.root.join(id))
    }
    fn read(&self, id: &str) -> Result<Record> {
        let file = self.directory(id)?.join("history.json");
        match std::fs::read(file) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| Error::InvalidDocument("工程历史无法读取，原记录已保留".into())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Record::default()),
            Err(e) => Err(e.into()),
        }
    }
    pub fn is_empty(&self, id: &str) -> Result<bool> {
        Ok(self.read(id)?.entries.is_empty())
    }
    pub fn find_revision(&self, id: &str, revision: &str) -> Result<Option<HistoricalSnapshot>> {
        let record = self.read(id)?;
        for stored in record.entries.iter().rev() {
            if stored.entry.revision == revision {
                return self.snapshot(id, &stored.after).map(Some);
            }
            if stored.entry.before_revision.as_deref() == Some(revision)
                && let Some(key) = &stored.before
            {
                return self.snapshot(id, key).map(Some);
            }
        }
        Ok(None)
    }
    pub fn entries(&self, id: &str) -> Result<Vec<HistoryEntry>> {
        let record = self.read(id)?;
        Ok(record
            .entries
            .into_iter()
            .rev()
            .map(|mut e| {
                e.entry.saved = record.saved.as_deref() == Some(e.after.as_str());
                e.entry
            })
            .collect())
    }
    fn put_snapshot(&self, id: &str, snapshot: &HistoricalSnapshot) -> Result<String> {
        snapshot.document(id)?;
        let bytes = serde_json::to_vec(snapshot).map_err(|e| Error::Io(e.to_string()))?;
        let key = digest(&bytes);
        let directory = self.directory(id)?.join("versions");
        std::fs::create_dir_all(&directory)?;
        let path = directory.join(format!("{key}.json"));
        if !path.exists() {
            atomic(&path, &bytes)?;
        } else if std::fs::read(&path)? != bytes {
            return Err(Error::InvalidDocument("历史快照已改变".into()));
        }
        Ok(key)
    }
    fn snapshot(&self, id: &str, key: &str) -> Result<HistoricalSnapshot> {
        if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::InvalidDocument("无效历史快照".into()));
        }
        let bytes = std::fs::read(
            self.directory(id)?
                .join("versions")
                .join(format!("{key}.json")),
        )?;
        if digest(&bytes) != key {
            return Err(Error::InvalidDocument("历史快照已改变".into()));
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| Error::InvalidDocument("历史快照无法读取".into()))
    }
    pub fn resolve(
        &self,
        id: &str,
        entry: &str,
        change: bool,
    ) -> Result<(HistoryEntry, Option<HistoricalSnapshot>, HistoricalSnapshot)> {
        let record = self.read(id)?;
        let found = record
            .entries
            .iter()
            .find(|e| e.entry.id == entry)
            .ok_or_else(|| Error::InvalidCommand("历史节点不属于当前文档".into()))?;
        Ok((
            found.entry.clone(),
            if change {
                found
                    .before
                    .as_ref()
                    .map(|key| self.snapshot(id, key))
                    .transpose()?
            } else {
                None
            },
            self.snapshot(id, &found.after)?,
        ))
    }
    pub fn append(
        &self,
        id: &str,
        before: Option<&HistoricalSnapshot>,
        after: &HistoricalSnapshot,
        kind: &str,
        title: &str,
        restored_from: Option<String>,
    ) -> Result<()> {
        let mut record = self.read(id)?;
        let before_revision = before.map(|s| s.revision.clone());
        let before = before.map(|s| self.put_snapshot(id, s)).transpose()?;
        let key = self.put_snapshot(id, after)?;
        if kind == "save" {
            record.saved = Some(key.clone());
        }
        if kind == "open" && after.path.is_some() {
            record.saved = Some(key.clone());
        }
        if kind == "save"
            && record
                .entries
                .last()
                .is_some_and(|e| e.after == key && e.entry.kind == "save")
        {
            return Ok(());
        }
        record.entries.push(StoredEntry {
            entry: HistoryEntry {
                id: uuid::Uuid::new_v4().to_string(),
                kind: kind.into(),
                title: title.into(),
                created_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as f64,
                before_revision,
                revision: after.revision.clone(),
                baseline: matches!(kind, "open" | "save"),
                saved: false,
                restored_from,
            },
            before,
            after: key,
        });
        atomic(
            &self.directory(id)?.join("history.json"),
            &serde_json::to_vec(&record).map_err(|e| Error::Io(e.to_string()))?,
        )
    }
}
fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let directory = path
        .parent()
        .ok_or_else(|| Error::Io("无效历史目录".into()))?;
    std::fs::create_dir_all(directory)?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(bytes)?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map_err(|e| Error::Io(e.to_string()))?;
    Ok(())
}
