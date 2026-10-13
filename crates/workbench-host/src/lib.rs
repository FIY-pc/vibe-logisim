mod agent;
mod diagnostics;
mod events;
mod feedback;
mod interfaces;
pub use events::{Event, Events};
pub use interfaces::{InterfaceImpact, InterfacePreview, InterfaceRead};
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
mod topology;
mod verification;
use base64::{Engine, engine::general_purpose::STANDARD as B64};
pub use observations::ObservationRecord;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use tokio::sync::Mutex;
pub use verification::{InputEvent, TestVector, TraceWatch};
use vibe_logisim_adapter::{Native, Verifier};
use vibe_workspace_core::{Document, DocumentView, Edit, Workspace};

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
#[derive(ts_rs::TS)]
pub enum Request {
    ProposalObserve {
        id: String,
        revision: String,
        original: String,
        xml: String,
        circuit: String,
    },
    HistoryList {
        id: String,
    },
    HistoryReview {
        id: String,
        revision: String,
        entry: String,
        mode: String,
    },
    HistoryPreview {
        id: String,
        revision: String,
        entry: String,
        mode: String,
        circuit: String,
        candidate: bool,
    },
    HistoryDetail {
        id: String,
        revision: String,
        entry: String,
        mode: String,
        circuit: String,
    },
    HistoryRestore {
        id: String,
        revision: String,
        entry: String,
    },
    ProposalDetail {
        id: String,
        revision: String,
        original: String,
        xml: String,
        circuit: String,
    },
    ProposalVerify {
        id: String,
        revision: String,
        original: String,
        xml: String,
        circuit: String,
        verification: VerificationInput,
    },
    Status,
    ProjectInfo {
        id: String,
        revision: String,
    },
    ProjectExport {
        id: String,
        revision: String,
        #[serde(default)]
        #[ts(optional)]
        path: Option<PathBuf>,
        #[serde(default)]
        #[ts(optional)]
        expected_revision: Option<String>,
    },
    ProjectExportTarget {
        path: PathBuf,
    },
    InterfaceRead {
        id: String,
        revision: String,
        circuit: String,
    },
    InterfacePreview {
        id: String,
        revision: String,
        circuit: String,
        draft: vibe_workspace_core::SymbolDraft,
    },
    InterfaceApply {
        id: String,
        revision: String,
        circuit: String,
        preview_id: String,
        draft: vibe_workspace_core::SymbolDraft,
    },
    InterfaceRender {
        id: String,
        revision: String,
        preview_id: String,
        circuit: String,
    },
    FeedbackStatus,
    FeedbackCheck {
        #[serde(default)]
        manual: bool,
    },
    FeedbackPreference {
        enabled: bool,
    },
    FeedbackDismiss {
        version: String,
    },
    Diagnostics,
    DiagnosticsExport {
        path: PathBuf,
        report: Value,
        #[serde(default)]
        #[ts(optional)]
        expected_revision: Option<String>,
    },
    FolderOpen {
        path: PathBuf,
    },
    FolderList {
        #[serde(default)]
        path: String,
    },
    FolderRead {
        path: String,
        #[serde(default)]
        #[ts(optional)]
        folder_id: Option<String>,
    },
    FolderPreview {
        path: String,
        #[serde(default)]
        #[ts(optional)]
        folder_id: Option<String>,
    },
    FolderResolve {
        folder_id: String,
        path: String,
        #[serde(default)]
        #[ts(optional)]
        path_version: Option<u32>,
    },
    ProjectFiles {
        id: String,
        folder_id: String,
        path: String,
        #[serde(default)]
        read: bool,
    },
    FolderCreate {
        folder_id: String,
        path: String,
        #[serde(default)]
        directory: bool,
    },
    FolderRename {
        folder_id: String,
        from: String,
        to: String,
    },
    FolderTrash {
        folder_id: String,
        path: String,
    },
    FolderImportPrepare {
        folder_id: String,
        sources: Vec<PathBuf>,
        destination: String,
    },
    FolderImportApply {
        folder_id: String,
        plan_id: String,
        choices: Vec<ImportChoice>,
    },
    FolderImportCancel {
        folder_id: String,
        plan_id: String,
    },
    FolderHistory {
        folder_id: String,
    },
    FolderHistoryDetail {
        folder_id: String,
        id: String,
        path: String,
    },
    FolderHistoryUndo {
        folder_id: String,
        id: String,
    },
    Agent {
        method: String,
        #[serde(default)]
        args: Value,
    },
    Open {
        path: PathBuf,
    },
    New {
        name: String,
    },
    Import {
        name: String,
        xml: String,
    },
    Read {
        id: String,
    },
    Activate {
        id: String,
    },
    Source {
        id: String,
        #[serde(default)]
        #[ts(optional)]
        revision: Option<String>,
    },
    SourceStatus {
        id: String,
    },
    ProposalReview {
        id: String,
        revision: String,
        original: String,
        xml: String,
    },
    ProposalPreview {
        id: String,
        revision: String,
        original: String,
        xml: String,
        circuit: String,
        candidate: bool,
    },
    Reload {
        id: String,
        revision: String,
        source_revision: String,
        #[serde(default)]
        discard: bool,
    },
    Close {
        id: String,
        revision: String,
        #[serde(default)]
        discard: bool,
    },
    Edit {
        id: String,
        revision: String,
        circuit: String,
        edit: Edit,
    },
    MovePreview {
        id: String,
        revision: String,
        circuit: String,
        ids: Vec<String>,
        delta: vibe_workspace_core::Point,
    },
    Undo {
        id: String,
        revision: String,
    },
    Redo {
        id: String,
        revision: String,
    },
    Save {
        id: String,
        revision: String,
        path: Option<PathBuf>,
        #[serde(default)]
        #[ts(optional)]
        target_revision: Option<String>,
    },
    SaveTarget {
        path: PathBuf,
    },
    Observe {
        id: String,
        revision: String,
        circuit: String,
    },
    Simulate {
        id: String,
        revision: String,
        circuit: String,
        vectors: Vec<TestVector>,
    },
    Trace {
        id: String,
        revision: String,
        circuit: String,
        ticks: u32,
        inputs: BTreeMap<String, u32>,
        watches: Vec<TraceWatch>,
        #[serde(default)]
        events: Vec<InputEvent>,
    },
    Template {
        id: String,
        revision: String,
        circuit: String,
        library: Option<String>,
        name: String,
        #[serde(default)]
        #[ts(optional)]
        attributes: Option<BTreeMap<String, String>>,
    },
    Properties {
        id: String,
        revision: String,
        circuit: String,
        component: String,
    },
    Memory {
        id: String,
        revision: String,
        circuit: String,
        component: String,
        offset: u32,
        count: u32,
    },
    MemoryWrite {
        id: String,
        revision: String,
        circuit: String,
        component: String,
        address: u32,
        expected: String,
        value: String,
    },
    Observations {
        id: String,
    },
    ObservationCapture {
        id: String,
        revision: String,
        view_id: String,
        #[serde(default)]
        title: String,
    },
    ObservationRename {
        id: String,
        record: String,
        title: String,
    },
    ObservationDelete {
        id: String,
        record: String,
    },
    Catalog {
        id: String,
        revision: String,
        circuit: String,
    },
    Render {
        id: String,
        revision: String,
        circuit: String,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        scale: f64,
    },
    SimulationStart {
        id: String,
        revision: String,
        circuit: String,
    },
    SimulationAction {
        id: String,
        revision: String,
        circuit: String,
        command: String,
        #[serde(default)]
        attributes: BTreeMap<String, String>,
    },
    SimulationStatus,
    SimulationStop,
    SimulationView {
        id: String,
        revision: String,
        path: Vec<String>,
    },
    SimulationCommand {
        id: String,
        revision: String,
        command: String,
        #[serde(default)]
        attributes: BTreeMap<String, String>,
    },
}
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
type Result<T> = std::result::Result<T, String>;
fn value<T: Serialize>(v: T) -> Result<Value> {
    serde_json::to_value(v).map_err(|e| e.to_string())
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
        request: Request,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send + '_>> {
        Box::pin(async move {
            let stage = diagnostics::stage(&request);
            let outcome = async {
            let auto_save = matches!(&request, Request::Edit { .. } | Request::InterfaceApply { .. }
                | Request::MemoryWrite { .. } | Request::Undo { .. } | Request::Redo { .. } | Request::HistoryRestore { .. });
            let changes = matches!(
                &request,
                Request::Open { .. }
                    | Request::New { .. }
                    | Request::Import { .. }
                    | Request::Close { .. }
                    | Request::Reload { .. }
                    | Request::Edit { .. }
                    | Request::InterfaceApply { .. }
                    | Request::HistoryRestore { .. }
                    | Request::MemoryWrite { .. }
                    | Request::Undo { .. }
                    | Request::Redo { .. }
                    | Request::Save { .. }
                    | Request::FolderRename { .. }
                    | Request::FolderTrash { .. }
                    | Request::FolderImportApply { .. }
                    | Request::FolderHistoryUndo { .. }
                    | Request::Activate { .. }
            );
            if changes && self.recovery_error.is_some() {
                return Err(self.recovery_error.clone().unwrap());
            }
            let history_action = document_history::action(&request);
            let _history_guard = if changes {
                Some(self.history_gate.lock().await)
            } else {
                None
            };
            let history_before = if let Some(action) = &history_action {
                self.history_before(action).await?
            } else {
                BTreeMap::new()
            };
            let mut result = match request {
                Request::ProposalObserve{id,revision,original,xml,circuit}=>self.observe_proposal(&id,&revision,&original,&xml,&circuit).await,
                Request::ProjectInfo { id, revision } => self.project_info(&id,&revision).await,
                Request::ProjectExport { id, revision, path, expected_revision } => self.project_export(&id,&revision,path.as_deref(),expected_revision.as_deref()).await,
                Request::ProjectExportTarget { path } => project_info::export_target(&path),
                Request::HistoryList { id } => self.history_list(&id).await,
                Request::HistoryReview {
                    id,
                    revision,
                    entry,
                    mode,
                } => self.history_review(&id, &revision, &entry, &mode).await,
                Request::HistoryPreview {
                    id,
                    revision,
                    entry,
                    mode,
                    circuit,
                    candidate,
                } => {
                    self.history_preview(&id, &revision, &entry, &mode, &circuit, candidate)
                        .await
                }
                Request::HistoryDetail {
                    id,
                    revision,
                    entry,
                    mode,
                    circuit,
                } => {
                    self.history_detail(&id, &revision, &entry, &mode, &circuit)
                        .await
                }
                Request::HistoryRestore {
                    id,
                    revision,
                    entry,
                } => self.history_restore(&id, &revision, &entry).await,
                Request::ProposalDetail {
                    id,
                    revision,
                    original,
                    xml,
                    circuit,
                } => {
                    self.detail_proposal(&id,&revision,&original,&xml,&circuit).await
                }
                Request::ProposalVerify {
                    id,
                    revision,
                    original,
                    xml,
                    circuit,
                    verification,
                } => {
                    self.verify_proposal(&id, &revision, &original, &xml, &circuit, verification)
                        .await
                }
                Request::InterfaceRead {
                    id,
                    revision,
                    circuit,
                } => self.read_interface(&id, &revision, &circuit).await,
                Request::InterfacePreview {
                    id,
                    revision,
                    circuit,
                    draft,
                } => {
                    self.preview_interface(&id, &revision, &circuit, &draft)
                        .await
                }
                Request::InterfaceApply {
                    id,
                    revision,
                    circuit,
                    preview_id,
                    draft,
                } => {
                    self.apply_interface(&id, &revision, &circuit, &preview_id, &draft)
                        .await
                }
                Request::InterfaceRender {
                    id,
                    revision,
                    preview_id,
                    circuit,
                } => {
                    self.render_interface(&id, &revision, &preview_id, &circuit)
                        .await
                }
                Request::ProposalReview {
                    id,
                    revision,
                    original,
                    xml,
                } => self.review_proposal(&id, &revision, &original, &xml).await,
                Request::ProposalPreview {
                    id,
                    revision,
                    original,
                    xml,
                    circuit,
                    candidate,
                } => {
                    self.preview_proposal(&id, &revision, &original, &xml, &circuit, candidate)
                        .await
                }
                Request::FolderOpen { path } => {
                    let folder =
                        vibe_workspace_core::Folder::open(&path).map_err(|e| e.to_string())?;
                    std::fs::create_dir_all(&self.state).map_err(|e| e.to_string())?;
                    std::fs::write(
                        self.state.join("folder.json"),
                        serde_json::to_vec(&folder).map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?;
                    let history_warning = file_history::History::open(&self.state, &folder).err();
                    let mut result = value(&folder)?;
                    if let Some(warning) = history_warning {
                        result["historyWarning"] = json!(warning);
                    }
                    *self.folder.lock().await = Some(folder);
                    Ok(result)
                }
                Request::FolderList { path } => {
                    let guard = self.folder.lock().await;
                    let folder = guard.as_ref().ok_or("请先打开工程文件夹")?;
                    let history_warning = file_history::History::open(&self.state, folder).err();
                    Ok(
                        json!({"folder":folder,"entries":folder.list(&path).map_err(|e|e.to_string())?,"historyWarning":history_warning}),
                    )
                }
                Request::FolderResolve {
                    folder_id,
                    path,
                    path_version,
                } => {
                    let guard = self.folder.lock().await;
                    let folder = guard
                        .as_ref()
                        .filter(|f| f.id == folder_id)
                        .ok_or("工程文件夹已改变，请先打开引用所属文件夹")?;
                    file_references::References::open(&self.state, folder)?.resolve(
                        folder,
                        &path,
                        path_version,
                    )
                }
                Request::FolderRead { path, folder_id } => {
                    let guard = self.folder.lock().await;
                    let folder = guard.as_ref().ok_or("请先打开工程文件夹")?;
                    if folder_id.as_ref().is_some_and(|id| id != &folder.id) {
                        return Err("工程文件夹已改变，未读取同名文件".into());
                    }
                    let (bytes, mut result) = file_references::References::open(
                        &self.state,
                        folder,
                    )?
                    .read(folder, &path, 2 * 1024 * 1024)?;
                    result["text"] =
                        json!(String::from_utf8(bytes).map_err(|_| "文件不是 UTF-8 文本")?);
                    Ok(result)
                }
                Request::FolderPreview { path, folder_id } => {
                    let guard = self.folder.lock().await;
                    let folder = guard.as_ref().ok_or("请先打开工程文件夹")?;
                    if folder_id.as_ref().is_some_and(|id| id != &folder.id) {
                        return Err("工程文件夹已改变，未读取同名文件".into());
                    }
                    let extension = std::path::Path::new(&path)
                        .extension()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_ascii_lowercase();
                    let mime = match extension.as_str() {
                        "pdf" => "application/pdf",
                        "png" => "image/png",
                        "jpg" | "jpeg" => "image/jpeg",
                        "webp" => "image/webp",
                        _ => return Err("不支持这个文件的预览".into()),
                    };
                    let (bytes, mut result) = file_references::References::open(
                        &self.state,
                        folder,
                    )?
                    .read(folder, &path, 24 * 1024 * 1024)?;
                    result["data"] = json!(B64.encode(bytes));
                    result["mime"] = json!(mime);
                    Ok(result)
                }
                Request::ProjectFiles {
                    id,
                    folder_id,
                    path,
                    read,
                } => {
                    let folder_guard = self.folder.lock().await;
                    let folder = folder_guard.as_ref().ok_or("没有打开工程文件夹")?;
                    if folder.id != folder_id {
                        return Err("工程文件夹已改变，请重新绑定".into());
                    }
                    let workspace = self.workspace.lock().await;
                    let document = workspace.get(&id).map_err(|e| e.to_string())?;
                    if !document
                        .path
                        .as_ref()
                        .is_some_and(|p| p.starts_with(&folder.path))
                    {
                        return Err("当前文档不属于这个工程文件夹".into());
                    }
                    if read {
                        let (bytes, mut result) = file_references::References::open(
                            &self.state,
                            folder,
                        )?
                        .read(folder, &path, 2 * 1024 * 1024)?;
                        result["text"] =
                            json!(String::from_utf8(bytes).map_err(|_| "文件不是 UTF-8 文本")?);
                        Ok(result)
                    } else {
                        value(folder.list(&path).map_err(|e| e.to_string())?)
                    }
                }
                Request::FolderCreate {
                    folder_id,
                    path,
                    directory,
                } => {
                    self.create_project_entry(&folder_id, &path, directory)
                        .await
                }
                Request::FolderImportPrepare {
                    folder_id,
                    sources,
                    destination,
                } => {
                    self.prepare_file_import(&folder_id, sources, &destination)
                        .await
                }
                Request::FolderImportApply {
                    folder_id,
                    plan_id,
                    choices,
                } => self.apply_file_import(&folder_id, &plan_id, choices).await,
                Request::FolderImportCancel { folder_id, plan_id } => {
                    self.cancel_file_import(&folder_id, &plan_id).await
                }
                Request::FolderHistory { folder_id } => self.file_history(&folder_id).await,
                Request::FolderHistoryDetail {
                    folder_id,
                    id,
                    path,
                } => self.file_history_detail(&folder_id, &id, &path).await,
                Request::FolderHistoryUndo { folder_id, id } => {
                    self.undo_file_history(&folder_id, &id).await
                }
                Request::FolderRename {
                    folder_id,
                    from,
                    to,
                } => self.move_project_entry(&folder_id, &from, &to).await,
                Request::FolderTrash { folder_id, path } => {
                    self.trash_project_entry(&folder_id, &path).await
                }
                Request::Agent { method, mut args } => {
                    if method == "bind" {
                        let id = args["id"].as_str().ok_or("请先打开电路")?;
                        let revision = args["revision"].as_str().ok_or("缺少电路版本")?;
                        let view = {
                            let workspace = self.workspace.lock().await;
                            let doc = workspace.get(id).map_err(|e| e.to_string())?;
                            doc.check(revision).map_err(|e| e.to_string())?;
                            doc.view().map_err(|e| e.to_string())?
                        };
                        let folder = self.folder.lock().await;
                        let key = folder
                            .as_ref()
                            .filter(|f| view.path.as_ref().is_some_and(|p| p.starts_with(&f.path)))
                            .map(|f| f.id.clone())
                            .unwrap_or(view.id);
                        args["folderId"] = if key.starts_with("folder:") {
                            json!(&key)
                        } else {
                            Value::Null
                        };
                        args["workspaceKey"] = json!(key);
                    }
                    let runtime = {
                        let mut guard = self.agent.lock().await;
                        if guard.is_none()
                            || (method != "events"
                                && guard.as_ref().is_some_and(|a| {
                                    !a.alive.load(std::sync::atomic::Ordering::Acquire)
                                }))
                        {
                            *guard = Some(Arc::new(agent::Agent::start(
                                &self.root,
                                &self.state,
                                self.clone(),
                            )?));
                        }
                        guard.as_ref().unwrap().clone()
                    };
                    runtime.call(&method, args).await
                }
                Request::FeedbackStatus => Ok(self.feedback.lock().await.status()),
                Request::FeedbackCheck { manual } => {
                    Ok(self.feedback.lock().await.check(manual).await)
                }
                Request::FeedbackPreference { enabled } => {
                    self.feedback.lock().await.preference(enabled)
                }
                Request::FeedbackDismiss { version } => self.feedback.lock().await.dismiss(version),
                Request::Diagnostics => Ok(self.diagnostics().await),
                Request::DiagnosticsExport {
                    path,
                    report,
                    expected_revision,
                } => self.diagnostics_export(path, report, expected_revision),
                Request::Status => {
                    let w = self.workspace.lock().await;
                    let documents = w
                        .documents
                        .values()
                        .map(|d| d.view())
                        .collect::<vibe_workspace_core::Result<Vec<_>>>()
                        .map_err(|e| e.to_string())?;
                    let active = w.active.clone();
                    drop(w);
                    Ok(
                        json!({"documents":documents,"active":active,"recoveryError":self.recovery_error,"folder":self.folder.lock().await.clone(),"runtime":self.native.lock().await.status()}),
                    )
                }
                Request::New { name } => value(
                    self.workspace
                        .lock()
                        .await
                        .insert(Document::new(name))
                        .map_err(|e| e.to_string())?,
                ),
                Request::Open { path } => value(
                    self.workspace
                        .lock()
                        .await
                        .open(&path)
                        .map_err(|e| e.to_string())?,
                ),
                Request::Import { name, xml } => value(
                    self.workspace
                        .lock()
                        .await
                        .insert(
                            Document::from_bytes(name, None, xml.into_bytes(), false)
                                .map_err(|e| e.to_string())?,
                        )
                        .map_err(|e| e.to_string())?,
                ),
                Request::Read { id } => value(
                    self.workspace
                        .lock()
                        .await
                        .get(&id)
                        .map_err(|e| e.to_string())?
                        .view()
                        .map_err(|e| e.to_string())?,
                ),
                Request::Activate { id } => {
                    let mut w = self.workspace.lock().await;
                    w.get(&id).map_err(|e| e.to_string())?;
                    w.active = Some(id);
                    Ok(Value::Null)
                }
                Request::Source { id, revision } => {
                    let workspace = self.workspace.lock().await;
                    let document = workspace.get(&id).map_err(|e| e.to_string())?;
                    if let Some(revision) = revision {
                        document.check(&revision).map_err(|e| e.to_string())?;
                    }
                    Ok(
                        json!({"xml":String::from_utf8_lossy(document.bytes()),"revision":document.revision()}),
                    )
                }
                Request::SourceStatus { id } => value(
                    self.workspace
                        .lock()
                        .await
                        .get(&id)
                        .map_err(|e| e.to_string())?
                        .source_status(),
                ),
                Request::Reload {
                    id,
                    revision,
                    source_revision,
                    discard,
                } => {
                    let mut w = self.workspace.lock().await;
                    let d = w.get_mut(&id).map_err(|e| e.to_string())?;
                    d.reload(&revision, &source_revision, discard)
                        .map_err(|e| e.to_string())?;
                    value(d.view().map_err(|e| e.to_string())?)
                }
                Request::Close {
                    id,
                    revision,
                    discard,
                } => {
                    let mut w = self.workspace.lock().await;
                    w.get(&id)
                        .map_err(|e| e.to_string())?
                        .check(&revision)
                        .map_err(|e| e.to_string())?;
                    w.close(&id, discard).map_err(|e| e.to_string())?;
                    drop(w);
                    let mut native = self.native.lock().await;
                    if native
                        .simulation
                        .as_ref()
                        .is_some_and(|s| s.document_id == id)
                    {
                        native.stop_simulation().await;
                    }
                    Ok(json!({"closed":true}))
                }
                Request::Edit {
                    id,
                    revision,
                    circuit,
                    mut edit,
                } => {
                    if let Edit::Place {
                        name,
                        library,
                        location,
                        attributes,
                    } = &edit
                    {
                        let (path, _) = self.snapshot(&id, &revision).await?;
                        let template = self
                            .native
                            .lock()
                            .await
                            .template(
                                &path,
                                &circuit,
                                library.clone(),
                                name.clone(),
                                Some(*location),
                                attributes.clone(),
                            )
                            .await?;
                        let component = template["children"]
                            .as_array()
                            .and_then(|all| all.iter().find(|n| n["tag"] == "comp"))
                            .ok_or("元件序列化失败")?;
                        let attributes = component["children"]
                            .as_array()
                            .map(|all| {
                                all.iter()
                                    .filter_map(|n| {
                                        Some((
                                            n["attributes"]["name"].as_str()?.to_string(),
                                            n["attributes"]["val"]
                                                .as_str()
                                                .or_else(|| n["text"].as_str())
                                                .unwrap_or("")
                                                .to_string(),
                                        ))
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        edit = Edit::Place {
                            name: component["attributes"]["name"]
                                .as_str()
                                .ok_or("元件名称缺失")?
                                .into(),
                            library: library.clone(),
                            location: *location,
                            attributes,
                        };
                    }
                    if let Edit::Attributes {
                        id: component_id,
                        values,
                    } = &edit
                    {
                        let (path, view) = self.snapshot(&id, &revision).await?;
                        let component = view
                            .circuits
                            .iter()
                            .find(|c| c.name == circuit)
                            .and_then(|c| c.components.iter().find(|c| &c.id == component_id))
                            .ok_or("请选择元件")?;
                        let checked = self
                            .native
                            .lock()
                            .await
                            .properties(&path, &circuit, component, values.clone())
                            .await?;
                        let serialized = checked["children"]
                            .as_array()
                            .and_then(|all| all.iter().find(|n| n["tag"] == "comp"))
                            .ok_or("元件序列化失败")?;
                        let canonical = serialized["children"]
                            .as_array()
                            .ok_or("元件属性缺失")?
                            .iter()
                            .filter_map(|n| {
                                Some((
                                    n["attributes"]["name"].as_str()?.to_string(),
                                    n["attributes"]["val"]
                                        .as_str()
                                        .or_else(|| n["text"].as_str())
                                        .unwrap_or("")
                                        .to_string(),
                                ))
                            })
                            .collect();
                        edit = Edit::Attributes {
                            id: component_id.clone(),
                            values: canonical,
                        };
                    }
                    if let Edit::Move { ids, delta } = &edit {
                        self.commit_move(&id, &revision, &circuit, ids, *delta)
                            .await
                    } else {
                        let mut w = self.workspace.lock().await;
                        let d = w.get_mut(&id).map_err(|e| e.to_string())?;
                        d.edit(&revision, &circuit, edit)
                            .map_err(|e| e.to_string())?;
                        value(d.view().map_err(|e| e.to_string())?)
                    }
                }
                Request::MovePreview {
                    id,
                    revision,
                    circuit,
                    ids,
                    delta,
                } => {
                    self.preview_move(&id, &revision, &circuit, &ids, delta)
                        .await
                }
                Request::Undo { id, revision } => {
                    let mut w = self.workspace.lock().await;
                    let d = w.get_mut(&id).map_err(|e| e.to_string())?;
                    d.undo(&revision).map_err(|e| e.to_string())?;
                    value(d.view().map_err(|e| e.to_string())?)
                }
                Request::Redo { id, revision } => {
                    let mut w = self.workspace.lock().await;
                    let d = w.get_mut(&id).map_err(|e| e.to_string())?;
                    d.redo(&revision).map_err(|e| e.to_string())?;
                    value(d.view().map_err(|e| e.to_string())?)
                }
                Request::Save {
                    id,
                    revision,
                    path,
                    target_revision,
                } => {
                    self.save_with_references(
                        &id,
                        &revision,
                        path.as_deref(),
                        target_revision.as_deref(),
                    )
                    .await
                }
                Request::SaveTarget { path } => match std::fs::metadata(&path) {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        Ok(json!({"revision":null}))
                    }
                    Err(e) => Err(e.to_string()),
                    Ok(meta) if !meta.is_file() || meta.len() > 32 * 1024 * 1024 => {
                        Err("请选择不超过 32 MB 的电路文件".into())
                    }
                    Ok(_) => Ok(
                        json!({"revision":vibe_workspace_core::digest(&std::fs::read(path).map_err(|e|e.to_string())?)}),
                    ),
                },
                Request::Simulate {
                    id,
                    revision,
                    circuit,
                    vectors,
                } => self.verify_vectors(&id, &revision, &circuit, vectors).await,
                Request::Trace {
                    id,
                    revision,
                    circuit,
                    ticks,
                    inputs,
                    watches,
                    events,
                } => {
                    self.verify_trace(
                        &id,
                        &revision,
                        &circuit,
                        verification::TraceProgram {
                            ticks,
                            inputs,
                            watches,
                            events,
                        },
                    )
                    .await
                }
                Request::Observe {
                    id,
                    revision,
                    circuit,
                } => {
                    let (p, _) = self.snapshot(&id, &revision).await?;
                    self.native.lock().await.observe(&p, &circuit).await
                }
                Request::Template {
                    id,
                    revision,
                    circuit,
                    library,
                    name,
                    attributes,
                } => {
                    let (path, _) = self.snapshot(&id, &revision).await?;
                    self.native
                        .lock()
                        .await
                        .template(
                            &path,
                            &circuit,
                            library,
                            name,
                            None,
                            attributes.unwrap_or_default(),
                        )
                        .await
                }
                Request::Properties {
                    id,
                    revision,
                    circuit,
                    component,
                } => {
                    let (path, view) = self.snapshot(&id, &revision).await?;
                    let component = view
                        .circuits
                        .iter()
                        .find(|c| c.name == circuit)
                        .and_then(|c| c.components.iter().find(|c| c.id == component))
                        .ok_or("请选择元件")?;
                    self.native
                        .lock()
                        .await
                        .properties(&path, &circuit, component, BTreeMap::new())
                        .await
                }
                Request::Memory {
                    id,
                    revision,
                    circuit,
                    component,
                    offset,
                    count,
                } => {
                    let (path, view) = self.snapshot(&id, &revision).await?;
                    let component = view
                        .circuits
                        .iter()
                        .find(|c| c.name == circuit)
                        .and_then(|c| {
                            c.components
                                .iter()
                                .find(|c| c.id == component && c.name == "ROM")
                        })
                        .ok_or("请选择 ROM；RAM 内容需要在运行实例中读取")?;
                    self.native
                        .lock()
                        .await
                        .memory(
                            &path,
                            &circuit,
                            component,
                            BTreeMap::from([
                                ("offset".into(), offset.to_string()),
                                ("count".into(), count.to_string()),
                            ]),
                            false,
                        )
                        .await
                }
                Request::MemoryWrite {
                    id,
                    revision,
                    circuit,
                    component,
                    address,
                    expected,
                    value: word,
                } => {
                    let (path, view) = self.snapshot(&id, &revision).await?;
                    let selected = view
                        .circuits
                        .iter()
                        .find(|c| c.name == circuit)
                        .and_then(|c| {
                            c.components
                                .iter()
                                .find(|c| c.id == component && c.name == "ROM")
                        })
                        .ok_or("请选择 ROM；RAM 修改属于运行实例")?;
                    let result = self
                        .native
                        .lock()
                        .await
                        .memory(
                            &path,
                            &circuit,
                            selected,
                            BTreeMap::from([
                                ("address".into(), address.to_string()),
                                ("expected".into(), expected),
                                ("value".into(), word),
                            ]),
                            true,
                        )
                        .await?;
                    let contents = result["contents"].as_str().ok_or("无法序列化 ROM")?.into();
                    let mut workspace = self.workspace.lock().await;
                    let document = workspace.get_mut(&id).map_err(|e| e.to_string())?;
                    document
                        .edit(
                            &revision,
                            &circuit,
                            Edit::Attributes {
                                id: component,
                                values: BTreeMap::from([("contents".into(), contents)]),
                            },
                        )
                        .map_err(|e| e.to_string())?;
                    value(document.view().map_err(|e| e.to_string())?)
                }
                Request::Observations { id } => self.observations(&id).await,
                Request::ObservationCapture {
                    id,
                    revision,
                    view_id,
                    title,
                } => {
                    let view = {
                        let workspace = self.workspace.lock().await;
                        let document = workspace.get(&id).map_err(|e| e.to_string())?;
                        document.check(&revision).map_err(|e| e.to_string())?;
                        document.view().map_err(|e| e.to_string())?
                    };
                    self.capture(view, &view_id, title).await
                }
                Request::ObservationRename { id, record, title } => {
                    self.rename_observation(&id, &record, &title)
                }
                Request::ObservationDelete { id, record } => self.delete_observation(&id, &record),
                Request::Catalog {
                    id,
                    revision,
                    circuit,
                } => {
                    let (p, v) = self.snapshot(&id, &revision).await?;
                    self.native.lock().await.catalog(&p, &v, &circuit).await
                }
                Request::Render {
                    id,
                    revision,
                    circuit,
                    x,
                    y,
                    width,
                    height,
                    scale,
                } => {
                    let (p, _) = self.snapshot(&id, &revision).await?;
                    Ok(
                        json!({"image":self.native.lock().await.render(&p,&circuit,vibe_logisim_adapter::Viewport{x,y,width,height,scale}).await?}),
                    )
                }
                Request::SimulationStart {
                    id,
                    revision,
                    circuit,
                } => {
                    let (p, v) = self.snapshot(&id, &revision).await?;
                    self.native
                        .lock()
                        .await
                        .start_simulation(&p, &v, &circuit)
                        .await
                }
                Request::SimulationAction {
                    id,
                    revision,
                    circuit,
                    command,
                    attributes,
                } => {
                    if command == "button-release" {
                        let mut native = self.native.lock().await;
                        if let Some(sim) = native.simulation.as_mut()
                            && sim.document_id == id
                            && sim.revision == revision
                            && sim.circuit == circuit
                            && attributes
                                .get("viewId")
                                .is_none_or(|v| sim.state()["viewId"] == *v)
                        {
                            let mut attrs = attributes;
                            attrs.insert("value".into(), "0".into());
                            return sim.command("button", attrs).await;
                        }
                        return Ok(Value::Null);
                    }
                    let (path, view) = self.snapshot(&id, &revision).await?;
                    let mut native = self.native.lock().await;
                    if !native.simulation.as_ref().is_some_and(|s| {
                        s.document_id == id
                            && s.revision == revision
                            && s.circuit == circuit
                            && !s.failed()
                    }) {
                        native.start_simulation(&path, &view, &circuit).await?;
                    }
                    let simulation = native.simulation.as_mut().unwrap();
                    if command == "start" {
                        Ok(simulation.state())
                    } else {
                        simulation.command(&command, attributes).await
                    }
                }
                Request::SimulationView { id, revision, path } => {
                    let view = {
                        let w = self.workspace.lock().await;
                        let d = w.get(&id).map_err(|e| e.to_string())?;
                        d.check(&revision).map_err(|e| e.to_string())?;
                        d.view().map_err(|e| e.to_string())?
                    };
                    let mut native = self.native.lock().await;
                    let sim = native.simulation.as_mut().ok_or("请先启动仿真")?;
                    if sim.document_id != id || sim.revision != revision {
                        return Err("仿真版本已改变".into());
                    }
                    sim.navigate(&view, path).await
                }
                Request::SimulationStatus => Ok(self
                    .native
                    .lock()
                    .await
                    .simulation
                    .as_ref()
                    .map(|s| s.state())
                    .unwrap_or(Value::Null)),
                Request::SimulationStop => {
                    self.native.lock().await.stop_simulation().await;
                    Ok(Value::Null)
                }
                Request::SimulationCommand {
                    id,
                    revision,
                    command,
                    attributes,
                } => {
                    self.workspace
                        .lock()
                        .await
                        .get(&id)
                        .map_err(|e| e.to_string())?
                        .check(&revision)
                        .map_err(|e| e.to_string())?;
                    let mut native = self.native.lock().await;
                    let sim = native.simulation.as_mut().ok_or("请先启动仿真")?;
                    if sim.document_id != id || sim.revision != revision {
                        return Err("仿真对应的电路已改变，请重新启动".into());
                    }
                    sim.command(&command, attributes).await
                }
            };
            if auto_save && let Ok(document) = &mut result {
                self.auto_save_edit(document).await;
            }
            if changes && result.is_ok() {
                if let Some(action) = &history_action
                    && let Err(error) = self.history_after(action, history_before).await
                    && let Ok(document) = &mut result {
                        document["historyWarning"] = json!(format!("修改已保留，但工程历史未能记录：{error}"));
                }
                self.workspace
                    .lock()
                    .await
                    .checkpoint(&self.state.join("workspace.json"))
                    .map_err(|e| e.to_string())?;
            }
            result
            }.await;
            if let Some(stage) = stage {
                match &outcome {
                    Err(error) => self.failures.lock().await.record(stage, error),
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
}
