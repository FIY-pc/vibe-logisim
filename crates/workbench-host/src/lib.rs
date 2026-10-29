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
    AgentRequest, AppRequest, DocumentRequest, EditResult, ErrorCode, Event, Events, FolderRequest,
    HostError, MovePreview, Request, Selection, SimulationRequest, TraceProgramInput, Warning,
};
use app::{diagnostics, feedback};
use documents::interfaces;
pub use documents::{
    ButtonEvent, HistoryList, HistoryReview, InputEvent, InterfaceImpact, InterfacePreview,
    InterfaceRead, TestVector, TraceWatch,
};
pub use folder::{ImportAction, ImportChoice};
use serde::Serialize;
use serde_json::{Value, json};
pub use simulation::{ObservationRecord, ObservationSummary};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use tokio::sync::Mutex;
use vibe_circuit_document::{DocumentView, Revision, Workspace, history::DocumentHistory};
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
    /// A document at the revision the caller saw, as the native side reads it.
    async fn revision_at(&self, id: &str, revision: &str) -> Result<Revision> {
        let workspace = self.workspace.lock().await;
        let doc = workspace.get(id).map_err(|e| e.to_string())?;
        doc.check(revision).map_err(|e| e.to_string())?;
        Ok(doc.snapshot())
    }
    /// The revision and its view, for requests that need the whole document.
    async fn revision_view(&self, id: &str, revision: &str) -> Result<(Revision, DocumentView)> {
        let workspace = self.workspace.lock().await;
        let doc = workspace.get(id).map_err(|e| e.to_string())?;
        doc.check(revision).map_err(|e| e.to_string())?;
        Ok((doc.snapshot(), doc.view().map_err(|e| e.to_string())?))
    }
    /// The revision and one circuit of it (none when it has no such circuit).
    async fn revision_circuit(
        &self,
        id: &str,
        revision: &str,
        circuit: &str,
    ) -> Result<(Revision, Option<vibe_circuit_document::Circuit>)> {
        let workspace = self.workspace.lock().await;
        let doc = workspace.get(id).map_err(|e| e.to_string())?;
        doc.check(revision).map_err(|e| e.to_string())?;
        let view = doc.circuit_view(circuit).map_err(|e| e.to_string())?;
        Ok((doc.snapshot(), view))
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
    /// Runs one request with the rules its op declares: writes wait for each
    /// other, record history, write documents back and persist the workspace.
    async fn apply(&self, request: Request, meta: &api::Meta) -> Result<Reply> {
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
        self.persist(&mut *self.workspace.lock().await).await;
        result
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
