mod agent;
mod diagnostics;
mod error;
mod events;
mod feedback;
mod interfaces;
mod requests;
pub use error::{ErrorCode, HostError};
pub use events::{Event, Events, Warning};
pub use interfaces::{InterfaceImpact, InterfacePreview, InterfaceRead};
pub use requests::{
    AgentRequest, EditingRequest, FolderRequest, InterfaceRequest, ProjectRequest, Request,
    ReviewRequest, SimulationRequest, WorkspaceRequest,
};
mod file_history;
mod file_references;
mod folder_operations;
pub use folder_operations::{ImportAction, ImportChoice};
mod comparison;
mod document_history;
mod movement;
mod observations;
mod project_info;
mod proposal_review;
pub use comparison::ComparisonDetail;
pub use document_history::{HistoryList, HistoryReview};
pub use proposal_review::ProposalReview;
pub use verification::{VerificationInput, VerificationRecord};
#[cfg(test)]
mod state_paths_tests;
mod topology;
mod verification;
pub use observations::ObservationRecord;
use requests::Effect;
pub use requests::editing::{EditResult, ErrorDetail, MovePreview, Selection};
use serde::Serialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use tokio::sync::Mutex;
pub use verification::{InputEvent, TestVector, TraceWatch};
use vibe_logisim_adapter::{Native, Verifier};
use vibe_workspace_core::{Document, DocumentView, Workspace};

#[derive(Clone)]
pub struct Host {
    history_gate: Arc<Mutex<()>>,
    pub workspace: Arc<Mutex<Workspace>>,
    pub native: Arc<Mutex<Native>>,
    verifier: Arc<Mutex<Verifier>>,
    feedback: Arc<Mutex<feedback::Feedback>>,
    failures: Arc<Mutex<diagnostics::FailureLog>>,
    interface_previews: Arc<Mutex<interfaces::Previews>>,
    state: PathBuf,
    root: PathBuf,
    agent: Arc<Mutex<Option<Arc<agent::Agent>>>>,
    recovery_error: Option<String>,
    events: tokio::sync::broadcast::Sender<Event>,
    stopping: tokio::sync::watch::Sender<bool>,
    folder: Arc<Mutex<Option<vibe_workspace_core::Folder>>>,
    // The OS releases this lease after a crash; no stale PID files to delete.
    _lease: Arc<std::fs::File>,
}
type Result<T> = std::result::Result<T, HostError>;
fn value<T: Serialize>(v: T) -> Result<Value> {
    serde_json::to_value(v).map_err(|e| HostError::new(ErrorCode::Internal, e.to_string()))
}
impl Host {
    pub async fn shutdown(&self) {
        self.stopping.send_replace(true);
        if let Some(agent) = self.agent.lock().await.take() {
            agent.shutdown().await;
        }
        self.native.lock().await.shutdown().await;
        self.verifier.lock().await.shutdown().await;
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
        let (workspace, recovery_error) = match Workspace::restore(&state.join("workspace.json")) {
            Ok(w) => (w, None),
            Err(e) => (Workspace::default(), Some(e.to_string())),
        };
        let folder = std::fs::read(state.join("folder.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<vibe_workspace_core::Folder>(&b).ok())
            .and_then(|f| vibe_workspace_core::Folder::open(&f.path).ok());
        Ok(Self {
            _lease: Arc::new(lease),
            feedback: Arc::new(Mutex::new(feedback::Feedback::new(&state))),
            failures: Arc::new(Mutex::new(diagnostics::FailureLog::default())),
            interface_previews: Arc::new(Mutex::new(interfaces::Previews::default())),
            folder: Arc::new(Mutex::new(folder)),
            workspace: Arc::new(Mutex::new(workspace)),
            verifier: Arc::new(Mutex::new(Verifier::new(
                root.clone(),
                state.join("verification"),
                runtime.clone(),
            ))),
            native: Arc::new(Mutex::new(Native::new(
                root.clone(),
                state.clone(),
                runtime,
            ))),
            state,
            root,
            agent: Arc::new(Mutex::new(None)),
            recovery_error,
            history_gate: Arc::new(Mutex::new(())),
            events: tokio::sync::broadcast::channel(512).0,
            stopping: tokio::sync::watch::channel(false).0,
        })
    }
    async fn snapshot(&self, id: &str, revision: &str) -> Result<(PathBuf, DocumentView)> {
        let workspace = self.workspace.lock().await;
        let doc = workspace.get(id).map_err(|e| e.to_string())?;
        doc.check(revision).map_err(|e| e.to_string())?;
        self.materialize(doc)
    }
    fn materialize(&self, doc: &Document) -> Result<(PathBuf, DocumentView)> {
        let id = &doc.id;
        let revision = doc.revision();
        let view = doc.view().map_err(|e| e.to_string())?;
        let directory =
            self.state
                .join("snapshots")
                .join(id)
                .join(revision)
                .join(vibe_workspace_core::digest(
                    view.path
                        .as_ref()
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_default()
                        .as_bytes(),
                ));
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let path = directory.join("circuit.circ");
        if path.is_file() {
            return Ok((path, view));
        }
        // A snapshot must resolve external libraries beside the source, not beside the cache.
        let mut tree = xmltree::Element::parse(doc.bytes()).map_err(|e| e.to_string())?;
        if let Some(parent) = view.path.as_ref().and_then(|p| p.parent()) {
            for node in &mut tree.children {
                if let Some(e) = node.as_mut_element()
                    && e.name == "lib"
                    && let Some(desc) = e.attributes.get_mut("desc")
                {
                    for prefix in ["jar#", "file#"] {
                        if let Some(rest) = desc.strip_prefix(prefix) {
                            let (file, suffix) = rest
                                .split_once('#')
                                .map(|(a, b)| (a, format!("#{b}")))
                                .unwrap_or((rest, String::new()));
                            let file = PathBuf::from(file);
                            if file.is_relative() {
                                *desc = format!("{prefix}{}{suffix}", parent.join(file).display());
                            }
                            break;
                        }
                    }
                }
            }
        }
        let bytes = vibe_logisim_adapter::encode_xml(&tree)?;
        use std::io::Write;
        let mut temp = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
        temp.write_all(&bytes).map_err(|e| e.to_string())?;
        temp.persist(&path).map_err(|e| e.to_string())?;
        Ok((path, view))
    }
    pub fn dispatch(
        &self,
        request: impl Into<Request>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send + '_>> {
        let request = request.into();
        Box::pin(async move {
            let meta = request.meta();
            let outcome = self.apply(request, &meta).await;
            if let Some(stage) = meta.stage {
                match &outcome {
                    Err(error) => self.failures.lock().await.record(stage, &error.message),
                    Ok(value) => {
                        if let Some(error) = value["saveError"].as_str() {
                            self.failures
                                .lock()
                                .await
                                .record(diagnostics::Stage::Save, error);
                        }
                    }
                }
            }
            outcome
        })
    }
    /// Runs one request with the rules its op declares: writes wait for each
    /// other, record history, write documents back and persist the workspace.
    async fn apply(&self, request: Request, meta: &requests::Meta) -> Result<Value> {
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
            Request::Workspace(r) => self.workspace_request(r).await,
            Request::Editing(r) => self.editing_request(r).await,
            Request::Interface(r) => self.interface_request(r).await,
            Request::Simulation(r) => self.simulation_request(r).await,
            Request::Review(r) => self.review_request(r).await,
            Request::Folder(r) => self.folder_request(r).await,
            Request::Project(r) => self.project_request(r).await,
            Request::Agent(r) => self.agent_request(r).await,
        };
        let Ok(document) = &mut result else {
            return result;
        };
        let unchanged = match (&revision_before, target) {
            (Some(before), Some(id)) => self.revision(id).await.as_ref() == Some(before),
            _ => false,
        };
        if !writes || unchanged {
            return result;
        }
        // An edit result nests the document view so it can also carry the
        // selection and title; other auto-saving ops return the view itself.
        let nested = document.get("view").is_some();
        if meta.effect == Effect::AutoSave {
            if nested {
                let mut view = document["view"].clone();
                self.auto_save_edit(&mut view).await;
                if let Some(revision) = view["revision"].as_str() {
                    document["revision"] = json!(revision);
                }
                if let Some(error) = view.get("saveError") {
                    document["saveError"] = error.clone();
                }
                if let Some(warning) = view.get("referenceWarning") {
                    document["referenceWarning"] = warning.clone();
                }
                document["view"] = view;
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
            if let Err(error) = self.history_after(&action, history_before).await {
                document["historyWarning"] =
                    json!(format!("修改已保留，但工程历史未能记录：{error}"));
            }
        }
        self.persist(&*self.workspace.lock().await).await;
        result
    }
    async fn revision(&self, id: &str) -> Option<String> {
        Some(self.workspace.lock().await.get(id).ok()?.revision())
    }
    /// Saves the workspace for crash recovery. A failure leaves the applied
    /// change in place and is reported as a warning.
    pub(crate) async fn persist(&self, workspace: &Workspace) {
        if let Err(error) = workspace.checkpoint(&self.state.join("workspace.json")) {
            let message = format!("修改已生效，但工作区恢复信息未能写入：{error}");
            self.failures
                .lock()
                .await
                .record(diagnostics::Stage::Save, &message);
            self.emit(Event::Warning(Warning { message }));
        }
    }
}
