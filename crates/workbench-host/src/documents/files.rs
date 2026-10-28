//! The open documents follow their files. Before every document and folder
//! request the host looks at the file of each open document: a `stat`, and a
//! read and digest only when its length or modification time moved. A
//! document without unsaved changes whose file changed is read again in place
//! (the previous content stays in undo history) and the change is broadcast
//! like any other; anything else (unsaved changes, a missing or unreadable
//! file, a new content that does not load) is broadcast as the document's
//! source state. After the host writes a file itself it records the file as
//! it left it, so its own saves are never taken for outside changes.
use crate::{Event, Host, HostError, Result, documents::history::Action, timing, value};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::SystemTime,
};
use vibe_circuit_document::{DocumentSummary, SourceStatus, Workspace, digest};

/// What the host last saw of an open document's file.
#[derive(Clone)]
pub(crate) struct Stamp {
    path: PathBuf,
    /// The file's length and modification time when it was looked at.
    seen: Option<(u64, SystemTime)>,
    /// The document's saved digest at that time.
    saved: Option<String>,
    /// The state last broadcast for the document.
    status: SourceStatus,
    /// Why the file's newer content was not taken, when it was not.
    problem: Option<String>,
}
pub(crate) type Stamps = HashMap<String, Stamp>;

/// The `source` event: an open document's file state changed.
#[derive(Clone, Serialize)]
pub struct SourceChange {
    pub id: String,
    pub status: SourceStatus,
}
/// The `workspace` event: documents opened or closed by the AI or by the
/// host itself (the window knows about its own), with the active one.
#[derive(Clone, Serialize)]
pub struct WorkspaceChange {
    pub documents: Vec<DocumentSummary>,
    pub active: Option<String>,
}

fn seen(path: &Path) -> Option<(u64, SystemTime)> {
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.len(), metadata.modified().ok()?))
}

impl Host {
    /// Brings the open documents in line with their files (see the module).
    /// With `close_missing` a document without unsaved changes whose file is
    /// gone closes, as after a folder operation removed it; otherwise it stays
    /// open and is reported `missing`.
    pub(crate) async fn follow_files(&self, close_missing: bool) {
        let _follow = timing::span("follow");
        let open: Vec<(String, PathBuf, Option<String>, bool)> = {
            let workspace = self.workspace.lock().await;
            workspace
                .documents
                .values()
                .filter_map(|d| {
                    Some((
                        d.id.clone(),
                        d.path.clone()?,
                        d.saved_revision().map(str::to_owned),
                        d.dirty(),
                    ))
                })
                .collect()
        };
        self.stamps()
            .retain(|id, _| open.iter().any(|(open, ..)| open == id));
        let mut closed = false;
        for (id, path, saved, dirty) in open {
            let now = seen(&path);
            let known = self.stamps().get(&id).cloned();
            if let Some(stamp) = &known
                && now.is_some()
                && stamp.path == path
                && stamp.saved == saved
                && stamp.seen == now
            {
                continue;
            }
            let mut status = match std::fs::read(&path) {
                Ok(bytes) => {
                    let revision = digest(&bytes);
                    if saved.as_deref() == Some(revision.as_str()) {
                        SourceStatus::Unchanged { revision }
                    } else {
                        SourceStatus::Modified { revision }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => SourceStatus::Missing,
                Err(e) => SourceStatus::Unreadable {
                    message: e.to_string(),
                },
            };
            let mut saved = saved;
            let mut problem = None;
            match &status {
                SourceStatus::Modified { revision } if !dirty && self.recovery_error.is_none() => {
                    match self.reload_from_file(&id, revision).await {
                        Ok(()) => {
                            saved = Some(revision.clone());
                            status = SourceStatus::Unchanged {
                                revision: revision.clone(),
                            };
                        }
                        Err(error) => problem = Some(error.message),
                    }
                }
                SourceStatus::Missing if close_missing && !dirty => {
                    if self.close_clean(&id).await {
                        closed = true;
                        continue;
                    }
                }
                _ => {}
            }
            self.record(
                &id,
                Stamp {
                    path,
                    seen: now,
                    saved,
                    status,
                    problem,
                },
            );
        }
        if closed {
            self.emit_workspace(&*self.workspace.lock().await);
        }
    }
    /// Reads a clean document's changed file into it, as `reload` does, with
    /// the same history entry, and broadcasts the change.
    async fn reload_from_file(&self, id: &str, revision: &str) -> Result<()> {
        let _gate = self.history_gate.lock().await;
        let action = Action::document("reload", "读取磁盘版本", id);
        let before = self.history_before(&action).await?;
        let change = {
            let mut workspace = self.workspace.lock().await;
            let document = workspace.get_mut(id)?;
            if document.saved_revision() == Some(revision) {
                return Ok(());
            }
            let base = document.revision();
            let changed = document.reload(&base, revision, false)?;
            document.view_change(&base, &changed)?
        };
        if let Err(error) = self.history_after(&action, before).await {
            self.emit(Event::Warning(crate::Warning {
                message: format!("已读取磁盘版本，但工程历史未能记录：{error}"),
            }));
        }
        self.persist(&mut *self.workspace.lock().await).await;
        self.emit(Event::Change(value(change)?));
        Ok(())
    }
    /// Closes a document whose file is gone, unless it gained unsaved changes meanwhile.
    async fn close_clean(&self, id: &str) -> bool {
        let _gate = self.history_gate.lock().await;
        let mut workspace = self.workspace.lock().await;
        if !workspace.get(id).is_ok_and(|d| !d.dirty()) || workspace.close(id, false).is_err() {
            return false;
        }
        self.persist(&mut workspace).await;
        true
    }
    /// Records the files the host itself just wrote or took (a save, a
    /// reload, a move, an opened file), so the next look does not read them
    /// again and does not take them for outside changes.
    pub(crate) fn restamp(&self, workspace: &Workspace) {
        for document in workspace.documents.values() {
            let Some(path) = &document.path else {
                continue;
            };
            let saved = document.saved_revision().map(str::to_owned);
            let stale = self
                .stamps()
                .get(&document.id)
                .is_none_or(|s| s.path != *path || s.saved != saved);
            if !stale || document.dirty() {
                continue;
            }
            let Some(revision) = saved.clone() else {
                continue;
            };
            self.record(
                &document.id,
                Stamp {
                    path: path.clone(),
                    seen: seen(path),
                    saved,
                    status: SourceStatus::Unchanged { revision },
                    problem: None,
                },
            );
        }
    }
    /// Keeps a stamp and broadcasts the document's source state when it changed.
    fn record(&self, id: &str, stamp: Stamp) {
        let previous = self.stamps().insert(id.to_owned(), stamp.clone());
        let changed = match previous {
            Some(previous) => previous.status != stamp.status,
            None => !matches!(stamp.status, SourceStatus::Unchanged { .. }),
        };
        if changed {
            self.emit(Event::Source(SourceChange {
                id: id.to_owned(),
                status: stamp.status,
            }));
        }
    }
    /// The state of an open document's file as last looked at.
    pub(crate) fn source_state(&self, id: &str) -> Option<SourceStatus> {
        self.stamps().get(id).map(|s| s.status.clone())
    }
    /// The AI's refusal for a document whose file changed but did not load:
    /// its tools must not go on with the content the file no longer has.
    pub(crate) async fn unloaded_file(&self, id: &str) -> Option<HostError> {
        self.follow_files(false).await;
        let problem = self.stamps().get(id)?.problem.clone()?;
        let name = self.workspace.lock().await.get(id).ok()?.name().to_owned();
        Some(HostError::new(
            crate::ErrorCode::InvalidDocument,
            format!("“{name}”在磁盘上的新内容无法载入：{problem}。改好文件后，电路工具会读到新内容"),
        ))
    }
    pub(crate) fn emit_workspace(&self, workspace: &Workspace) {
        self.emit(Event::Workspace(WorkspaceChange {
            documents: workspace.documents.values().map(|d| d.summary()).collect(),
            active: workspace.active.clone(),
        }));
    }
    fn stamps(&self) -> std::sync::MutexGuard<'_, Stamps> {
        self.stamps.lock().unwrap_or_else(|e| e.into_inner())
    }
}
