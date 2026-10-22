//! The open documents and their unsaved state, kept on disk so a restart
//! finds every draft with its undo and redo steps.
//!
//! Each document has a journal: a snapshot of the whole document, then one
//! small record per change. `index.json` names the journals; it is rewritten
//! only when documents open or close, or the active one changes. A journal
//! that grows long is replaced by a fresh snapshot under the next generation
//! number, and the old file is deleted once the index points at the new one.
use crate::{
    Document, Error, Result, digest,
    document::{Op, Source, Step, push_undo},
    journal::{self, Found, Log},
    patch,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

const SCHEMA: u32 = 2;
const INDEX: &str = "index.json";
/// A journal with more change records than this, or this many bytes after
/// its snapshot, is rewritten as a new snapshot.
const COMPACT_RECORDS: usize = 1000;
const COMPACT_BYTES: u64 = 32 << 20;

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
struct Index {
    schema: u32,
    active: Option<String>,
    identities: BTreeMap<PathBuf, String>,
    /// Journal file of each open document.
    documents: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Header {
    /// The whole document. The data is a chain of segments: the oldest undo
    /// step in full, then patches through the undo steps to the current
    /// bytes, then on through the redo steps from the next one to redo.
    Snapshot {
        path: Option<PathBuf>,
        name: String,
        saved: Option<String>,
        revision: String,
        undo: Vec<String>,
        redo: Vec<String>,
    },
    /// New bytes; the data patches the previous ones.
    Change {
        title: String,
        revision: String,
    },
    Undo {
        revision: String,
    },
    Redo {
        revision: String,
    },
    Saved {
        digest: Option<String>,
    },
    Location {
        path: Option<PathBuf>,
        name: String,
    },
}

struct Journal {
    file: String,
    generation: u64,
    log: Log,
    records: usize,
    /// Length of the snapshot that starts the journal.
    base: u64,
}

pub(crate) struct Session {
    pub(crate) dir: PathBuf,
    journals: HashMap<String, Journal>,
    written: Option<Index>,
}

/// What `Session::restore` found.
pub(crate) struct Restored {
    pub session: Session,
    pub documents: BTreeMap<String, Document>,
    pub active: Option<String>,
    pub identities: BTreeMap<PathBuf, String>,
}

fn unreadable(detail: impl std::fmt::Display) -> Error {
    Error::InvalidDocument(format!("无法恢复上次工作区，原记录已保留: {detail}"))
}

fn record(header: &Header, data: &[u8]) -> Result<Vec<u8>> {
    let header = serde_json::to_vec(header).map_err(|e| Error::Io(e.to_string()))?;
    Ok(journal::record(&header, data))
}

fn snapshot(document: &Document) -> Result<Vec<u8>> {
    let chain = document
        .undo
        .iter()
        .map(|step| &*step.bytes)
        .chain([document.bytes()])
        .chain(document.redo.iter().rev().map(|step| &*step.bytes));
    let mut data = Vec::new();
    let mut previous: Option<&[u8]> = None;
    for bytes in chain {
        let segment = match previous {
            None => bytes.to_vec(),
            Some(previous) => patch::diff(previous, bytes),
        };
        data.extend((segment.len() as u32).to_le_bytes());
        data.extend(segment);
        previous = Some(bytes);
    }
    let titles = |steps: &[Step]| steps.iter().map(|s| s.title.clone()).collect();
    record(
        &Header::Snapshot {
            path: document.path.clone(),
            name: document.name.clone(),
            saved: document.saved_digest.clone(),
            revision: document.revision(),
            undo: titles(&document.undo),
            redo: titles(&document.redo),
        },
        &data,
    )
}

fn operation(op: &Op) -> Result<Vec<u8>> {
    match op {
        Op::Change {
            title,
            revision,
            patch,
        } => record(
            &Header::Change {
                title: title.clone(),
                revision: revision.clone(),
            },
            patch,
        ),
        Op::Undo(revision) => record(
            &Header::Undo {
                revision: revision.clone(),
            },
            &[],
        ),
        Op::Redo(revision) => record(
            &Header::Redo {
                revision: revision.clone(),
            },
            &[],
        ),
        Op::Saved(digest) => record(
            &Header::Saved {
                digest: digest.clone(),
            },
            &[],
        ),
        Op::Location { path, name } => record(
            &Header::Location {
                path: path.clone(),
                name: name.clone(),
            },
            &[],
        ),
    }
}

/// Rebuilds a document from its journal: the snapshot, then every change
/// through the same undo rules the editor applies.
fn replay(id: String, records: &[Found<'_>]) -> Result<Document> {
    let corrupt = || unreadable("修改记录不完整");
    let parse =
        |found: &Found<'_>| serde_json::from_slice::<Header>(found.header).map_err(unreadable);
    let (first, rest) = records.split_first().ok_or_else(corrupt)?;
    let Header::Snapshot {
        mut path,
        mut name,
        mut saved,
        mut revision,
        undo: undo_titles,
        redo: redo_titles,
    } = parse(first)?
    else {
        return Err(corrupt());
    };
    let mut chain: Vec<Arc<[u8]>> = Vec::new();
    let mut data = first.data;
    while !data.is_empty() {
        let length = data
            .get(..4)
            .map(|b| u32::from_le_bytes(b.try_into().expect("four bytes")) as usize)
            .ok_or_else(corrupt)?;
        let segment = data.get(4..4 + length).ok_or_else(corrupt)?;
        data = &data[4 + length..];
        chain.push(match chain.last() {
            None => segment.into(),
            Some(previous) => patch::apply(previous, segment)?.into(),
        });
    }
    if chain.len() != undo_titles.len() + 1 + redo_titles.len() {
        return Err(corrupt());
    }
    let mut redo_bytes = chain.split_off(undo_titles.len() + 1);
    let mut current = chain.pop().ok_or_else(corrupt)?;
    let mut undo: Vec<Step> = chain
        .into_iter()
        .zip(undo_titles)
        .map(|(bytes, title)| Step { bytes, title })
        .collect();
    redo_bytes.reverse();
    let mut redo: Vec<Step> = redo_bytes
        .into_iter()
        .zip(redo_titles)
        .map(|(bytes, title)| Step { bytes, title })
        .collect();
    for found in rest {
        match parse(found)? {
            Header::Snapshot { .. } => return Err(corrupt()),
            Header::Change {
                title,
                revision: next,
            } => {
                let bytes: Arc<[u8]> = patch::apply(&current, found.data)?.into();
                let previous = std::mem::replace(&mut current, bytes);
                push_undo(
                    &mut undo,
                    Step {
                        bytes: previous,
                        title,
                    },
                );
                redo.clear();
                revision = next;
            }
            Header::Undo { revision: next } => {
                let step = undo.pop().ok_or_else(corrupt)?;
                let previous = std::mem::replace(&mut current, step.bytes);
                redo.push(Step {
                    bytes: previous,
                    title: step.title,
                });
                revision = next;
            }
            Header::Redo { revision: next } => {
                let step = redo.pop().ok_or_else(corrupt)?;
                let previous = std::mem::replace(&mut current, step.bytes);
                undo.push(Step {
                    bytes: previous,
                    title: step.title,
                });
                revision = next;
            }
            Header::Saved { digest } => saved = digest,
            Header::Location {
                path: next,
                name: next_name,
            } => {
                path = next;
                name = next_name;
            }
        }
    }
    if digest(&current) != revision {
        return Err(unreadable("恢复出的内容与记录不符"));
    }
    Ok(Document {
        id,
        path,
        name,
        source: Arc::new(Source::new(current.to_vec())?),
        saved_digest: saved,
        undo,
        redo,
        pending: Some(Vec::new()),
    })
}

/// A journal file name for a document id; ids are UUIDs, anything else is
/// replaced by its digest.
fn file_name(id: &str, generation: u64) -> String {
    let stem = if !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        id.to_string()
    } else {
        digest(id.as_bytes())
    };
    format!("{stem}.{generation}.log")
}

fn generation(file: &str) -> u64 {
    file.strip_suffix(".log")
        .and_then(|stem| stem.rsplit('.').next())
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

fn write_index(path: &Path, index: &Index) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::Io("无效恢复记录路径".into()))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(temp.as_file_mut(), index).map_err(|e| Error::Io(e.to_string()))?;
    temp.flush()?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| Error::Io(e.to_string()))?;
    Ok(())
}

impl Session {
    pub(crate) fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            journals: HashMap::new(),
            written: None,
        }
    }

    pub(crate) fn restore(dir: PathBuf) -> Result<Restored> {
        let mut session = Self::new(dir);
        let bytes = match std::fs::read(session.dir.join(INDEX)) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Restored {
                    session,
                    documents: BTreeMap::new(),
                    active: None,
                    identities: BTreeMap::new(),
                });
            }
            Err(e) => return Err(unreadable(e)),
        };
        let index: Index = serde_json::from_slice(&bytes).map_err(unreadable)?;
        if index.schema != SCHEMA {
            return Err(Error::InvalidDocument("不支持的工作区记录版本".into()));
        }
        let mut documents = BTreeMap::new();
        for (id, file) in &index.documents {
            let (log, bytes) = Log::open(&session.dir.join(file)).map_err(unreadable)?;
            let (records, _) = journal::scan(&bytes);
            let document = replay(id.clone(), &records)?;
            let base = records[0].offset + records[0].data.len() as u64;
            session.journals.insert(
                id.clone(),
                Journal {
                    file: file.clone(),
                    generation: generation(file),
                    log,
                    records: records.len() - 1,
                    base,
                },
            );
            documents.insert(id.clone(), document);
        }
        // Journals no index names: a closed document, or an interrupted rewrite.
        if let Ok(entries) = std::fs::read_dir(&session.dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.ends_with(".log") && !index.documents.values().any(|file| *file == name) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        let active = index.active.clone().filter(|id| documents.contains_key(id));
        let identities = index.identities.clone();
        session.written = Some(index);
        Ok(Restored {
            session,
            documents,
            active,
            identities,
        })
    }

    /// Records what changed since the last call: new and rewritten documents
    /// as snapshots, edits as appended records, closed documents by removing
    /// their journals.
    pub(crate) fn persist(
        &mut self,
        documents: &mut BTreeMap<String, Document>,
        active: Option<String>,
        identities: BTreeMap<PathBuf, String>,
    ) -> Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let mut retired = Vec::new();
        let mut failure = None;
        for (id, document) in documents.iter_mut() {
            if let Err(error) = self.persist_document(id, document, &mut retired) {
                failure.get_or_insert(error);
            }
        }
        let closed: Vec<String> = self
            .journals
            .keys()
            .filter(|id| !documents.contains_key(*id))
            .cloned()
            .collect();
        for id in closed {
            if let Some(journal) = self.journals.remove(&id) {
                retired.push(journal.file);
            }
        }
        let index = Index {
            schema: SCHEMA,
            active,
            identities,
            documents: self
                .journals
                .iter()
                .map(|(id, journal)| (id.clone(), journal.file.clone()))
                .collect(),
        };
        if self.written.as_ref() != Some(&index) {
            write_index(&self.dir.join(INDEX), &index)?;
            self.written = Some(index);
        }
        for file in retired {
            let _ = std::fs::remove_file(self.dir.join(file));
        }
        failure.map_or(Ok(()), Err)
    }

    fn persist_document(
        &mut self,
        id: &str,
        document: &mut Document,
        retired: &mut Vec<String>,
    ) -> Result<()> {
        // A failure below leaves `pending` unset, so the next call rewrites.
        let ops = match document.pending.take() {
            Some(ops) if self.journals.contains_key(id) => ops,
            _ => {
                self.rewrite(id, document, retired)?;
                document.pending = Some(Vec::new());
                return Ok(());
            }
        };
        let journal = self.journals.get_mut(id).expect("checked above");
        if !ops.is_empty() {
            let mut bytes = Vec::new();
            for op in &ops {
                bytes.extend(operation(op)?);
            }
            journal.log.append(&bytes)?;
            journal.records += ops.len();
        }
        let long =
            journal.records > COMPACT_RECORDS || journal.log.len() - journal.base > COMPACT_BYTES;
        if long {
            self.rewrite(id, document, retired)?;
        }
        document.pending = Some(Vec::new());
        Ok(())
    }

    fn rewrite(&mut self, id: &str, document: &Document, retired: &mut Vec<String>) -> Result<()> {
        let generation = self.journals.get(id).map_or(0, |j| j.generation + 1);
        let file = file_name(id, generation);
        let log = Log::create(&self.dir.join(&file), &snapshot(document)?)?;
        let base = log.len();
        let previous = self.journals.insert(
            id.to_string(),
            Journal {
                file,
                generation,
                log,
                records: 0,
                base,
            },
        );
        if let Some(previous) = previous {
            retired.push(previous.file);
        }
        Ok(())
    }
}
