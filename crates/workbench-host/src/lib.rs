mod agent;
mod api;
mod app;
mod documents;
mod folder;
mod simulation;
#[cfg(test)]
mod state_paths_tests;
use api::Effect;
pub use api::{
    AgentRequest, AppRequest, DocumentRequest, EditResult, ErrorCode, ErrorDetail, Event, Events,
    FolderRequest, HostError, MovePreview, Request, Selection, SimulationRequest,
    TraceProgramInput, Warning,
};
use app::{diagnostics, feedback};
pub use documents::{
    ButtonEvent, HistoryList, HistoryReview, InputEvent, InterfaceImpact, InterfacePreview,
    InterfaceRead, TestVector, TraceWatch,
};
use documents::{interfaces, snapshots};
pub use folder::{ImportAction, ImportChoice};
use serde::Serialize;
use serde_json::{Value, json};
pub use simulation::{ObservationRecord, ObservationSummary};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use tokio::sync::Mutex;
use vibe_circuit_document::{Document, DocumentView, Workspace, history::DocumentHistory};
pub use vibe_logisim_runtime::timing;
use vibe_logisim_runtime::{Launcher, Native, RuntimeFacts, simulation::SimulationRegistry};

/// What a request's timing line is called: its op, and for an edit also the
/// kind (`edit.move`).
pub fn timing_label(request: &Value) -> String {
    let op = request["op"].as_str().unwrap_or_default();
    match request["edit"]["kind"].as_str() {
        Some(kind) if op == "edit" => format!("{op}.{kind}"),
        _ => op.to_owned(),
    }
}

#[derive(Clone)]
pub struct Host {
    history_gate: Arc<Mutex<()>>,
    pub workspace: Arc<Mutex<Workspace>>,
    pub native: Arc<Mutex<Native>>,
    /// The current run and its process, and the separate process that answers
    /// circuit checks. Commands, frames and the run's lifetime never wait on
    /// editor or check work.
    pub simulation: SimulationRegistry,
    feedback: Arc<Mutex<feedback::Feedback>>,
    failures: Arc<Mutex<diagnostics::FailureLog>>,
    interface_previews: Arc<Mutex<interfaces::Previews>>,
    state: PathBuf,
    root: PathBuf,
    agent: Arc<Mutex<Option<Arc<agent::Agent>>>>,
    recovery_error: Option<String>,
    events: tokio::sync::broadcast::Sender<Event>,
    stopping: tokio::sync::watch::Sender<bool>,
    folder: Arc<Mutex<Option<vibe_circuit_document::Folder>>>,
    history: Arc<DocumentHistory>,
    /// Digests of library files, by path, length and modification time.
    digests: Arc<std::sync::Mutex<documents::history::Digests>>,
    /// What the host last saw of each open document's file.
    stamps: Arc<std::sync::Mutex<documents::files::Stamps>>,
    // The OS releases this lease after a crash; no stale PID files to delete.
    _lease: Arc<std::fs::File>,
}
type Result<T> = std::result::Result<T, HostError>;

/// A request's answer as the transports send it. An observation, megabytes on
/// a course page, is the worker's JSON text, passed on without being parsed
/// and written again; every other answer is a value.
pub enum Reply {
    Value(Value),
    Text(Box<serde_json::value::RawValue>),
}
impl Reply {
    pub fn into_value(self) -> Result<Value> {
        match self {
            Reply::Value(value) => Ok(value),
            Reply::Text(text) => serde_json::from_str(text.get())
                .map_err(|e| HostError::new(ErrorCode::Internal, e.to_string())),
        }
    }
}
impl Serialize for Reply {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Reply::Value(value) => value.serialize(serializer),
            Reply::Text(text) => text.serialize(serializer),
        }
    }
}

/// A temporary file to publish as a file of the user's (a restored or imported
/// file, an export), created with a new file's permissions (0666 less the umask)
/// rather than the private 0600 of a temporary file.
pub(crate) fn staged_user_file(
    parent: &std::path::Path,
) -> std::io::Result<tempfile::NamedTempFile> {
    let mut builder = tempfile::Builder::new();
    builder.prefix(".vibe-file-");
    #[cfg(unix)]
    builder.permissions(std::os::unix::fs::PermissionsExt::from_mode(0o666));
    builder.tempfile_in(parent)
}
fn value<T: Serialize>(v: T) -> Result<Value> {
    serde_json::to_value(v).map_err(|e| HostError::new(ErrorCode::Internal, e.to_string()))
}
impl Host {
    pub async fn shutdown(&self) {
        self.stopping.send_replace(true);
        if let Some(agent) = self.agent.lock().await.take() {
            agent.shutdown().await;
        }
        self.simulation.shutdown().await;
        self.native.lock().await.shutdown().await;
        // Edits reach the session journal before they return; wait for the
        // background sync so the last ones are on disk before exit.
        let _ = tokio::task::spawn_blocking(vibe_circuit_document::flush_journals).await;
    }
    pub fn new(root: PathBuf, state: PathBuf, runtime: Option<PathBuf>) -> Result<Self> {
        std::fs::create_dir_all(&state).map_err(|e| e.to_string())?;
        // tempfile's Windows persist calls Win32 directly, unlike std::fs: it does
        // not add a verbatim prefix for long paths. Canonicalize the existing state
        // root once so nested snapshots and every atomic state write retain it.
        // Java paths are converted separately at the adapter boundary.
        let state = state.canonicalize().map_err(|e| e.to_string())?;
        let lease = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(state.join("instance.lock"))
            .map_err(|e| e.to_string())?;
        lease
            .try_lock()
            .map_err(|_| "这个工作区已在另一个窗口中打开".to_string())?;
        let (workspace, recovery_error) = match Workspace::restore(&state.join("session")) {
            Ok(w) => (w, None),
            Err(e) => (Workspace::default(), Some(e.to_string())),
        };
        let folder = std::fs::read(state.join("folder.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<vibe_circuit_document::Folder>(&b).ok())
            .and_then(|f| vibe_circuit_document::Folder::open(&f.path).ok());
        let launcher = Launcher::new(
            RuntimeFacts::new(root.clone(), runtime.clone()),
            state.clone(),
        );
        Ok(Self {
            _lease: Arc::new(lease),
            simulation: SimulationRegistry::new(launcher.clone()),
            feedback: Arc::new(Mutex::new(feedback::Feedback::new(&state))),
            failures: Arc::new(Mutex::new(diagnostics::FailureLog::default())),
            interface_previews: Arc::new(Mutex::new(interfaces::Previews::default())),
            folder: Arc::new(Mutex::new(folder)),
            history: Arc::new(DocumentHistory::new(state.join("document-history"))),
            digests: Arc::default(),
            stamps: Arc::default(),
            workspace: Arc::new(Mutex::new(workspace)),
            native: Arc::new(Mutex::new(Native::with_launcher(launcher))),
            state,
            root,
            agent: Arc::new(Mutex::new(None)),
            recovery_error,
            history_gate: Arc::new(Mutex::new(())),
            events: tokio::sync::broadcast::channel(512).0,
            stopping: tokio::sync::watch::channel(false).0,
        })
    }
    /// The native artifact of a revision; see `materialize`.
    async fn snapshot(&self, id: &str, revision: &str) -> Result<PathBuf> {
        let workspace = self.workspace.lock().await;
        let doc = workspace.get(id).map_err(|e| e.to_string())?;
        doc.check(revision).map_err(|e| e.to_string())?;
        self.materialize(doc)
    }
    /// The artifact and the view of a revision, for requests that need the
    /// whole document.
    async fn snapshot_view(&self, id: &str, revision: &str) -> Result<(PathBuf, DocumentView)> {
        let workspace = self.workspace.lock().await;
        let doc = workspace.get(id).map_err(|e| e.to_string())?;
        doc.check(revision).map_err(|e| e.to_string())?;
        Ok((
            self.materialize(doc)?,
            doc.view().map_err(|e| e.to_string())?,
        ))
    }
    /// The artifact and one circuit of a revision (none when it has no such circuit).
    async fn snapshot_circuit(
        &self,
        id: &str,
        revision: &str,
        circuit: &str,
    ) -> Result<(PathBuf, Option<vibe_circuit_document::Circuit>)> {
        let workspace = self.workspace.lock().await;
        let doc = workspace.get(id).map_err(|e| e.to_string())?;
        doc.check(revision).map_err(|e| e.to_string())?;
        let view = doc.circuit_view(circuit).map_err(|e| e.to_string())?;
        Ok((self.materialize(doc)?, view))
    }
    /// The artifact and one component of a revision, for requests about that part.
    async fn snapshot_component(
        &self,
        id: &str,
        revision: &str,
        circuit: &str,
        component: &str,
    ) -> Result<(PathBuf, vibe_circuit_document::Component)> {
        let workspace = self.workspace.lock().await;
        let doc = workspace.get(id).map_err(|e| e.to_string())?;
        doc.check(revision).map_err(|e| e.to_string())?;
        let found = doc
            .circuit_view(circuit)
            .map_err(|e| e.to_string())?
            .and_then(|c| c.components.into_iter().find(|c| c.id == component))
            .ok_or("请选择元件")?;
        Ok((self.materialize(doc)?, found))
    }
    /// Writes the document where the native runtime can load it: one file per
    /// revision and source location, written once. Only the newest revisions
    /// of each document are kept; an older one is written again when needed.
    fn materialize(&self, doc: &Document) -> Result<PathBuf> {
        let revision = doc.revision();
        let documents = self.state.join("snapshots").join(&doc.id);
        let directory = documents
            .join(&revision)
            .join(vibe_circuit_document::digest(
                doc.path
                    .as_ref()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default()
                    .as_bytes(),
            ));
        let path = directory.join("circuit.circ");
        // Pruning deletes by write time, so a file written for this revision
        // is the one it needs; an older revision is written again.
        if path.is_file() {
            return Ok(path);
        }
        let _write = timing::span("materialize.write");
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        // A snapshot must resolve external libraries beside the source, not beside the cache.
        let bytes = doc
            .bytes_with_absolute_libraries()
            .map_err(|e| e.to_string())?;
        use std::io::Write;
        let mut temp = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
        temp.write_all(&bytes).map_err(|e| e.to_string())?;
        temp.persist(&path).map_err(|e| e.to_string())?;
        snapshots::prune(&documents, &revision);
        Ok(path)
    }
    /// Answers a request from the window or the AI, in the form the transports send.
    pub fn respond(
        &self,
        request: impl Into<Request>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Reply>> + Send + '_>> {
        let request = request.into();
        Box::pin(async move {
            let meta = request.meta();
            let outcome = self.apply(request, &meta).await;
            self.reconcile().await;
            if let Some(stage) = meta.stage {
                match &outcome {
                    Err(error) => self.failures.lock().await.record(stage, &error.message),
                    Ok(Reply::Value(value)) => {
                        if let Some(error) = value["saveError"].as_str() {
                            self.failures
                                .lock()
                                .await
                                .record(diagnostics::Stage::Save, error);
                        }
                    }
                    Ok(Reply::Text(_)) => {}
                }
            }
            outcome
        })
    }
    /// `respond` with the answer as a value, for callers in this process.
    pub fn dispatch(
        &self,
        request: impl Into<Request>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send + '_>> {
        let reply = self.respond(request);
        Box::pin(async move { reply.await?.into_value() })
    }
    /// Runs one request with the rules its op declares. A document or folder
    /// request first brings the open documents in line with their files, and
    /// a folder operation that changed files does so again after it.
    async fn apply(&self, request: Request, meta: &api::Meta) -> Result<Reply> {
        let files = matches!(request, Request::Document(_) | Request::Folder(_));
        let folder_write = matches!(request, Request::Folder(_)) && meta.effect != Effect::Read;
        if files {
            self.follow_files(false).await;
        }
        let reply = self.apply_gated(request, meta).await;
        if folder_write {
            self.follow_files(true).await;
        }
        reply
    }
    /// Writes wait for each other, record history, write documents back,
    /// persist the workspace and broadcast what they changed.
    async fn apply_gated(&self, request: Request, meta: &api::Meta) -> Result<Reply> {
        let writes = meta.effect != Effect::Read;
        if writes && let Some(error) = &self.recovery_error {
            return Err(HostError::new(ErrorCode::RecoveryFailed, error.clone()));
        }
        let _history_guard = if writes {
            Some(self.history_gate.lock().await)
        } else {
            None
        };
        let history_before = if let Some(action) = &meta.history {
            let _history = timing::span("history.before");
            self.history_before(action).await?
        } else {
            BTreeMap::new()
        };
        // An edit that leaves its document unchanged writes nothing back and records no history.
        let target = meta.history.as_ref().and_then(|a| a.target.as_deref());
        let revision_before = match (meta.effect, target) {
            (Effect::AutoSave, Some(id)) => self.revision(id).await,
            _ => None,
        };
        let before = if writes {
            let workspace = self.workspace.lock().await;
            Some((workspace.documents.clone(), workspace.active.clone()))
        } else {
            None
        };
        let mut result = match request {
            Request::Document(r) => self.document_request(r).await,
            Request::Folder(r) => self.folder_request(r).await.map(Reply::Value),
            Request::Simulation(r) => self.simulation_request(r).await.map(Reply::Value),
            Request::Agent(r) => self.agent_request(r).await.map(Reply::Value),
            Request::App(r) => self.app_request(r).await.map(Reply::Value),
        };
        // Only reads answer with text.
        let Ok(Reply::Value(document)) = &mut result else {
            return result;
        };
        let unchanged = match (&revision_before, target) {
            (Some(before), Some(id)) => self.revision(id).await.as_ref() == Some(before),
            _ => false,
        };
        if !writes || unchanged {
            return result;
        }
        // An edit result nests the document change so it can also carry the
        // selection and title; other auto-saving ops return the view itself.
        if meta.effect == Effect::AutoSave {
            let _save = timing::span("save");
            if let Some(view) = document.get_mut("change") {
                self.auto_save_edit(view).await;
                let reported =
                    ["saveError", "referenceWarning"].map(|key| (key, view.get(key).cloned()));
                for (key, value) in reported {
                    if let Some(value) = value {
                        document[key] = value;
                    }
                }
            } else {
                self.auto_save_edit(document).await;
            }
        }
        let title = document["title"].as_str().map(str::to_owned);
        if let Some(action) = &meta.history {
            let action = match title {
                Some(title) => action.clone().entitled(title),
                None => action.clone(),
            };
            let _history = timing::span("history.after");
            if let Err(error) = self.history_after(&action, history_before).await {
                document["historyWarning"] =
                    json!(format!("修改已保留，但工程历史未能记录：{error}"));
            }
        }
        let _persist = timing::span("persist");
        let mut workspace = self.workspace.lock().await;
        self.persist(&mut workspace).await;
        self.restamp(&workspace);
        let broadcast = before.map(|(documents, active)| {
            self.broadcast(&workspace, &documents, &active, target, document)
        });
        drop(_persist);
        drop(workspace);
        if let Some((changes, workspace)) = broadcast {
            for change in changes {
                self.emit(Event::Change(change));
            }
            if let Some(active) = workspace {
                self.emit(Event::Workspace(active));
            }
        }
        result
    }
    /// What a write changed, for the window: each document's change, and for
    /// the AI's requests also the documents opened or closed. The reply's own
    /// change is broadcast only for the AI, since the window that asked
    /// already has it. Returns the changes and, when they should follow, the
    /// workspace event.
    fn broadcast(
        &self,
        workspace: &Workspace,
        before: &BTreeMap<String, Document>,
        active: &Option<String>,
        target: Option<&str>,
        reply: &Value,
    ) -> (Vec<Value>, Option<documents::files::WorkspaceChange>) {
        let from_agent = agent::from_agent();
        let mut changes = Vec::new();
        for (id, document) in &workspace.documents {
            let Some(old) = before.get(id) else {
                continue;
            };
            if document.same_view(old) {
                continue;
            }
            if reply["change"]["id"].as_str() == Some(id.as_str()) {
                if from_agent {
                    changes.push(reply["change"].clone());
                }
                continue;
            }
            // The window's own write reaches it in its reply.
            if !from_agent && target == Some(id.as_str()) {
                continue;
            }
            if let Ok(change) = document.change_since(old)
                && let Ok(change) = value(change)
            {
                changes.push(change);
            }
        }
        let opened_or_closed = workspace.documents.len() != before.len()
            || workspace.documents.keys().any(|id| !before.contains_key(id));
        let workspace = (from_agent && (opened_or_closed || workspace.active != *active))
            .then(|| documents::files::WorkspaceChange {
                documents: workspace.documents.values().map(Document::summary).collect(),
                active: workspace.active.clone(),
            });
        (changes, workspace)
    }
    /// Ends the run when its document closed or moved to another revision. Runs
    /// after every request, so no path can leave a run of a document that changed.
    async fn reconcile(&self) {
        let Some(id) = self.simulation.run().map(|run| run.document_id) else {
            return;
        };
        let revision = {
            let workspace = self.workspace.lock().await;
            workspace.get(&id).ok().map(|document| document.revision())
        };
        self.simulation
            .reconcile(|candidate| (candidate == id).then(|| revision.clone()).flatten());
    }
    async fn revision(&self, id: &str) -> Option<String> {
        Some(self.workspace.lock().await.get(id).ok()?.revision())
    }
    /// Records the workspace's changes for crash recovery. A failure leaves
    /// the applied change in place and is reported as a warning. After a
    /// failed restore nothing is written, so the old records stay intact.
    pub(crate) async fn persist(&self, workspace: &mut Workspace) {
        if self.recovery_error.is_some() {
            return;
        }
        if let Err(error) = workspace.persist(&self.state.join("session")) {
            let message = format!("修改已生效，但工作区恢复信息未能写入：{error}");
            self.failures
                .lock()
                .await
                .record(diagnostics::Stage::Save, &message);
            self.emit(Event::Warning(Warning { message }));
        }
    }
}
