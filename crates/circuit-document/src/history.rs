//! Versions of each document over time, independent of the editor's undo and
//! redo stacks.
//!
//! Each document's history is one append-only file of records: version
//! contents (whole, or a patch against an earlier version), entries that name
//! the versions before and after a step, and the saved marker. Appending
//! writes what changed, not the file; the index is read once per run.
use crate::{
    Document, Error, Result, digest,
    journal::{self, Log},
    patch,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

/// A version stored as a patch is rebuilt by applying at most this many
/// patches; past that, or when the patch is not much smaller than the file,
/// the version is stored whole.
const MAX_DEPTH: u32 = 64;

/// One version of a document: what it was called and where, its bytes, and
/// the libraries it was loaded with.
#[derive(Clone)]
pub struct HistoricalSnapshot {
    pub name: String,
    pub path: Option<PathBuf>,
    pub revision: String,
    pub dependencies: Option<BTreeMap<PathBuf, String>>,
    pub bytes: Arc<[u8]>,
}
impl HistoricalSnapshot {
    pub fn xml(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
    pub fn document(&self, id: &str) -> Result<Document> {
        if digest(&self.bytes) != self.revision {
            return Err(Error::InvalidDocument("历史快照内容已改变".into()));
        }
        let mut d = Document::from_bytes(
            self.name.clone(),
            self.path.clone(),
            self.bytes.to_vec(),
            false,
        )?;
        d.id = format!("{id}-history");
        Ok(d)
    }
    fn meta(&self) -> Meta {
        Meta {
            name: self.name.clone(),
            path: self.path.clone(),
            revision: self.revision.clone(),
            dependencies: self.dependencies.clone(),
        }
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

/// A snapshot without its bytes; the bytes are stored once per revision.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    name: String,
    path: Option<PathBuf>,
    revision: String,
    dependencies: Option<BTreeMap<PathBuf, String>>,
}
impl Meta {
    fn key(&self) -> String {
        serde_json::to_vec(self)
            .map(|bytes| digest(&bytes))
            .unwrap_or_default()
    }
}

fn encode(record: &Record, data: &[u8]) -> Result<Vec<u8>> {
    let header = serde_json::to_vec(record).map_err(|e| Error::Io(e.to_string()))?;
    Ok(journal::record(&header, data))
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Record {
    /// A version's bytes: whole, or a patch against `base`.
    Version {
        revision: String,
        base: Option<String>,
    },
    Entry {
        entry: Box<HistoryEntry>,
        before: Option<Meta>,
        after: Meta,
    },
    Saved {
        key: String,
    },
}

struct Stored {
    entry: HistoryEntry,
    before: Option<Meta>,
    after: Meta,
    /// `after.key()`, compared with the saved marker.
    key: String,
}

struct Version {
    base: Option<String>,
    offset: u64,
    len: usize,
    depth: u32,
}

/// One document's history as read from its file.
struct Loaded {
    log: Log,
    entries: Vec<Stored>,
    saved: Option<String>,
    versions: HashMap<String, Version>,
    /// The bytes of the version rebuilt or written last.
    recent: Option<(String, Arc<[u8]>)>,
}

impl Loaded {
    fn open(file: &Path) -> Result<Self> {
        let unreadable = || Error::InvalidDocument("工程历史无法读取，原记录已保留".into());
        let (log, bytes) = if file.exists() {
            Log::open(file)?
        } else {
            (Log::create(file, &[])?, Vec::new())
        };
        let mut loaded = Self {
            log,
            entries: Vec::new(),
            saved: None,
            versions: HashMap::new(),
            recent: None,
        };
        for found in journal::scan(&bytes).0 {
            match serde_json::from_slice(found.header).map_err(|_| unreadable())? {
                Record::Version { revision, base } => {
                    let depth = match &base {
                        Some(base) => loaded.versions.get(base).ok_or_else(unreadable)?.depth + 1,
                        None => 0,
                    };
                    loaded.versions.insert(
                        revision,
                        Version {
                            base,
                            offset: found.offset,
                            len: found.data.len(),
                            depth,
                        },
                    );
                }
                Record::Entry {
                    entry,
                    before,
                    after,
                } => loaded.entries.push(Stored {
                    key: after.key(),
                    entry: *entry,
                    before,
                    after,
                }),
                Record::Saved { key } => loaded.saved = Some(key),
            }
        }
        Ok(loaded)
    }

    fn bytes(&mut self, revision: &str) -> Result<Arc<[u8]>> {
        let missing = || Error::InvalidDocument("无效历史快照".into());
        let mut chain = Vec::new();
        let mut at = revision;
        let mut start: Option<Vec<u8>> = None;
        loop {
            if let Some((known, bytes)) = &self.recent
                && known == at
            {
                start = Some(bytes.to_vec());
                break;
            }
            let version = self.versions.get(at).ok_or_else(missing)?;
            chain.push(version);
            match &version.base {
                Some(base) => at = base,
                None => break,
            }
        }
        let mut bytes = match start {
            Some(bytes) => bytes,
            None => {
                let whole = chain.pop().ok_or_else(missing)?;
                self.log.read_at(whole.offset, whole.len)?
            }
        };
        for version in chain.into_iter().rev() {
            bytes = patch::apply(&bytes, &self.log.read_at(version.offset, version.len)?)?;
        }
        if digest(&bytes) != revision {
            return Err(Error::InvalidDocument("历史快照已改变".into()));
        }
        let bytes: Arc<[u8]> = bytes.into();
        self.recent = Some((revision.to_string(), bytes.clone()));
        Ok(bytes)
    }

    /// Adds the records storing `snapshot`'s bytes to `out`, as a patch
    /// against `base` when that is short, unless the revision is stored.
    fn put(
        &self,
        out: &mut Vec<u8>,
        added: &mut Vec<(String, Version)>,
        snapshot: &HistoricalSnapshot,
        base: Option<&HistoricalSnapshot>,
    ) -> Result<()> {
        let known = |revision: &str| {
            added
                .iter()
                .find(|(r, _)| r == revision)
                .map(|(_, v)| v.depth)
                .or_else(|| self.versions.get(revision).map(|v| v.depth))
        };
        if known(&snapshot.revision).is_some() {
            return Ok(());
        }
        let based = base.and_then(|base| {
            let depth = known(&base.revision)? + 1;
            let patch = patch::diff(&base.bytes, &snapshot.bytes);
            (depth <= MAX_DEPTH && patch.len() < snapshot.bytes.len() / 2)
                .then(|| (base.revision.clone(), depth, patch))
        });
        let (base, depth, data) = match based {
            Some((base, depth, patch)) => (Some(base), depth, patch),
            None => (None, 0, snapshot.bytes.to_vec()),
        };
        let record = encode(
            &Record::Version {
                revision: snapshot.revision.clone(),
                base: base.clone(),
            },
            &data,
        )?;
        let offset = self.log.len() + (out.len() + record.len() - data.len()) as u64;
        out.extend(record);
        added.push((
            snapshot.revision.clone(),
            Version {
                base,
                offset,
                len: data.len(),
                depth,
            },
        ));
        Ok(())
    }

    fn snapshot(&mut self, meta: &Meta) -> Result<HistoricalSnapshot> {
        let meta = meta.clone();
        Ok(HistoricalSnapshot {
            bytes: self.bytes(&meta.revision)?,
            name: meta.name,
            path: meta.path,
            revision: meta.revision,
            dependencies: meta.dependencies,
        })
    }
}

pub struct DocumentHistory {
    root: PathBuf,
    loaded: Mutex<HashMap<String, Loaded>>,
}
impl DocumentHistory {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            loaded: Mutex::new(HashMap::new()),
        }
    }
    fn with<T>(&self, id: &str, f: impl FnOnce(&mut Loaded) -> Result<T>) -> Result<T> {
        uuid::Uuid::parse_str(id).map_err(|_| Error::InvalidCommand("无效文档标识".into()))?;
        let mut loaded = self.loaded.lock().unwrap_or_else(|e| e.into_inner());
        if !loaded.contains_key(id) {
            let directory = self.root.join(id);
            std::fs::create_dir_all(&directory)?;
            loaded.insert(
                id.to_string(),
                Loaded::open(&directory.join("history.log"))?,
            );
        }
        f(loaded.get_mut(id).expect("loaded above"))
    }
    pub fn is_empty(&self, id: &str) -> Result<bool> {
        self.with(id, |h| Ok(h.entries.is_empty()))
    }
    pub fn find_revision(&self, id: &str, revision: &str) -> Result<Option<HistoricalSnapshot>> {
        self.with(id, |h| {
            let found = h.entries.iter().rev().find_map(|stored| {
                if stored.entry.revision == revision {
                    return Some(stored.after.clone());
                }
                stored
                    .before
                    .clone()
                    .filter(|_| stored.entry.before_revision.as_deref() == Some(revision))
            });
            found.map(|meta| h.snapshot(&meta)).transpose()
        })
    }
    pub fn entries(&self, id: &str) -> Result<Vec<HistoryEntry>> {
        self.with(id, |h| {
            Ok(h.entries
                .iter()
                .rev()
                .map(|stored| {
                    let mut entry = stored.entry.clone();
                    entry.saved = h.saved.as_deref() == Some(stored.key.as_str());
                    entry
                })
                .collect())
        })
    }
    pub fn resolve(
        &self,
        id: &str,
        entry: &str,
        change: bool,
    ) -> Result<(HistoryEntry, Option<HistoricalSnapshot>, HistoricalSnapshot)> {
        self.with(id, |h| {
            let found = h
                .entries
                .iter()
                .find(|e| e.entry.id == entry)
                .ok_or_else(|| Error::InvalidCommand("历史节点不属于当前文档".into()))?;
            let (entry, before, after) = (
                found.entry.clone(),
                found.before.clone().filter(|_| change),
                found.after.clone(),
            );
            let before = before.map(|meta| h.snapshot(&meta)).transpose()?;
            Ok((entry, before, h.snapshot(&after)?))
        })
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
        self.with(id, |h| {
            let mut out = Vec::new();
            let mut added = Vec::new();
            if let Some(before) = before {
                h.put(&mut out, &mut added, before, None)?;
            }
            h.put(&mut out, &mut added, after, before)?;
            let after_meta = after.meta();
            let key = after_meta.key();
            let mut saved = None;
            if (kind == "save" || kind == "open" && after.path.is_some())
                && h.saved.as_deref() != Some(key.as_str())
            {
                saved = Some(key.clone());
                out.extend(encode(&Record::Saved { key: key.clone() }, &[])?);
            }
            let repeated_save = kind == "save"
                && h.entries
                    .last()
                    .is_some_and(|e| e.entry.kind == "save" && e.key == key);
            let mut stored = None;
            if !repeated_save {
                let entry = HistoryEntry {
                    id: uuid::Uuid::new_v4().to_string(),
                    kind: kind.into(),
                    title: title.into(),
                    created_at: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as f64,
                    before_revision: before.map(|s| s.revision.clone()),
                    revision: after.revision.clone(),
                    baseline: matches!(kind, "open" | "save"),
                    saved: false,
                    restored_from,
                };
                let record = Record::Entry {
                    entry: Box::new(entry.clone()),
                    before: before.map(HistoricalSnapshot::meta),
                    after: after_meta.clone(),
                };
                out.extend(encode(&record, &[])?);
                stored = Some(Stored {
                    entry,
                    before: before.map(HistoricalSnapshot::meta),
                    after: after_meta,
                    key: key.clone(),
                });
            }
            if !out.is_empty() {
                h.log.append(&out)?;
            }
            h.versions.extend(added);
            if let Some(key) = saved {
                h.saved = Some(key);
            }
            h.entries.extend(stored);
            h.recent = Some((after.revision.clone(), after.bytes.clone()));
            Ok(())
        })
    }
}
