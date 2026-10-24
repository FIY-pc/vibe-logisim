//! Documents: the files open in the workspace and everything done to one of
//! them — editing, observation, rendering, checks, packaging and history.
use super::{Effect::*, Meta};
use crate::{
    Host, Reply, Result,
    app::diagnostics::Stage,
    documents::{
        history::Action,
        project_info,
        verification::{ButtonEvent, InputEvent, TestVector, TracePlan, TraceWatch},
    },
    value,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf};
use vibe_circuit_document::{Document, DocumentView, Edit, EditOutcome, Point};
use vibe_logisim_runtime::{Viewport, timing};

/// The objects a gesture leaves selected.
#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub components: Vec<String>,
    pub wires: Vec<String>,
}

/// What an edit returns: the whole view plus what changed, so the canvas can
/// select what it placed and the history can name the step.
#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct EditResult {
    pub view: DocumentView,
    pub revision: String,
    pub noop: bool,
    pub title: String,
    pub circuit: String,
    pub changed_circuits: Vec<String>,
    pub selection: Selection,
}

/// A drag's geometry. A position the release would reject comes back in
/// `error` so the drag continues and the status line explains why.
#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct MovePreview {
    pub revision: Option<String>,
    pub delta: Option<Point>,
    pub removed_wires: Vec<String>,
    pub added_wires: Vec<vibe_circuit_document::Wire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<ErrorDetail>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDetail {
    pub code: crate::ErrorCode,
    pub message: String,
}

/// ROM component id and the words loaded into it before a trace.
#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct TraceProgramInput {
    pub component: String,
    pub words: Vec<u32>,
}

#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum DocumentRequest {
    Status,
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
    Save {
        id: String,
        revision: String,
        #[serde(default)]
        #[ts(optional)]
        path: Option<PathBuf>,
        #[serde(default)]
        #[ts(optional)]
        target_revision: Option<String>,
    },
    SaveTarget {
        path: PathBuf,
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
        delta: Point,
    },
    Undo {
        id: String,
        revision: String,
    },
    Redo {
        id: String,
        revision: String,
    },
    Observe {
        id: String,
        revision: String,
        circuit: String,
    },
    /// Observes what `edit replace` with this whole-file XML would make of
    /// the revision, without applying it; same reply as `observe`.
    ObserveXml {
        id: String,
        revision: String,
        circuit: String,
        xml: String,
    },
    Template {
        id: String,
        revision: String,
        circuit: String,
        #[serde(default)]
        #[ts(optional)]
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
    Catalog {
        id: String,
        revision: String,
        circuit: String,
    },
    /// Renders the circuit at the given viewport, or fitted to its contents
    /// when any of the five numbers is missing.
    Render {
        id: String,
        revision: String,
        circuit: String,
        #[serde(default)]
        #[ts(optional)]
        x: Option<i32>,
        #[serde(default)]
        #[ts(optional)]
        y: Option<i32>,
        #[serde(default)]
        #[ts(optional)]
        width: Option<u32>,
        #[serde(default)]
        #[ts(optional)]
        height: Option<u32>,
        #[serde(default)]
        #[ts(optional)]
        scale: Option<f64>,
    },
    /// Runs 1–256 input vectors through a circuit of the given revision in a
    /// separate runtime, each from fresh state, and compares the output pins
    /// named in `expected`. Isolated from the live run: it neither reads nor
    /// changes what the user sees.
    Simulate {
        id: String,
        revision: String,
        circuit: String,
        vectors: Vec<TestVector>,
    },
    /// Runs a circuit of the given revision for a number of clock ticks in a
    /// separate runtime from fresh state, applying the stimulus at its ticks
    /// and sampling the watched ports after every tick. Isolated like
    /// `simulate`.
    Trace {
        id: String,
        revision: String,
        circuit: String,
        ticks: u32,
        #[serde(default)]
        inputs: BTreeMap<String, u32>,
        #[serde(default)]
        events: Vec<InputEvent>,
        #[serde(default)]
        buttons: Vec<ButtonEvent>,
        #[serde(default)]
        #[ts(optional)]
        reset: Option<String>,
        #[serde(default)]
        #[ts(optional)]
        program: Option<TraceProgramInput>,
        watches: Vec<TraceWatch>,
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
        draft: vibe_circuit_document::SymbolDraft,
    },
    InterfaceApply {
        id: String,
        revision: String,
        circuit: String,
        preview_id: String,
        draft: vibe_circuit_document::SymbolDraft,
    },
    InterfaceRender {
        id: String,
        revision: String,
        preview_id: String,
        circuit: String,
    },
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
    HistoryRestore {
        id: String,
        revision: String,
        entry: String,
    },
}

impl DocumentRequest {
    pub(crate) const OPS: &[&str] = &[
        "status",
        "open",
        "new",
        "import",
        "read",
        "activate",
        "source",
        "sourceStatus",
        "reload",
        "close",
        "save",
        "saveTarget",
        "edit",
        "movePreview",
        "undo",
        "redo",
        "observe",
        "observeXml",
        "template",
        "properties",
        "catalog",
        "render",
        "simulate",
        "trace",
        "interfaceRead",
        "interfacePreview",
        "interfaceApply",
        "interfaceRender",
        "projectInfo",
        "projectExport",
        "projectExportTarget",
        "historyList",
        "historyReview",
        "historyPreview",
        "historyRestore",
    ];
    pub(crate) fn meta(&self) -> Meta {
        match self {
            // The runtime reads status to resolve the open folder and file facts.
            Self::Status
            | Self::Read { .. }
            | Self::Source { .. }
            | Self::SourceStatus { .. }
            | Self::SaveTarget { .. } => Meta::new(Read).agent(),
            Self::Open { .. } => Meta::new(Write)
                .stage(Stage::Open)
                .history(Action::open())
                .agent(),
            Self::Import { .. } => Meta::new(Write).stage(Stage::Open).history(Action::open()),
            Self::New { .. } => Meta::new(Write).history(Action::open()).agent(),
            Self::Activate { .. } | Self::Close { .. } => Meta::new(Write),
            Self::Reload { id, .. } => Meta::new(Write)
                .stage(Stage::Open)
                .history(Action::document("reload", "读取磁盘版本", id)),
            Self::Save { id, .. } => Meta::new(Write)
                .stage(Stage::Save)
                .history(Action::document("save", "保存版本", id))
                .agent(),
            Self::Edit { id, edit, .. } => Meta::new(AutoSave)
                .stage(Stage::Edit)
                .history(Action::edit(id, edit))
                .agent(),
            Self::MovePreview { .. } => Meta::new(Read),
            Self::Undo { id, .. } => Meta::new(AutoSave)
                .stage(Stage::Edit)
                .history(Action::document("undo", "撤销修改", id))
                .agent(),
            Self::Redo { id, .. } => Meta::new(AutoSave)
                .stage(Stage::Edit)
                .history(Action::document("redo", "重做修改", id))
                .agent(),
            Self::Observe { .. } | Self::ObserveXml { .. } => {
                Meta::new(Read).stage(Stage::Observe).agent()
            }
            Self::Template { .. } | Self::Properties { .. } | Self::Catalog { .. } => {
                Meta::new(Read).stage(Stage::Library).agent()
            }
            Self::Render { .. } => Meta::new(Read).stage(Stage::Render).agent(),
            Self::Simulate { .. } | Self::Trace { .. } => {
                Meta::new(Read).stage(Stage::Verify).agent()
            }
            Self::InterfaceRead { .. } | Self::InterfacePreview { .. } => Meta::new(Read).agent(),
            Self::InterfaceApply { id, .. } => Meta::new(AutoSave)
                .stage(Stage::Edit)
                .history(Action::document("interface", "修改封装与接口", id))
                .agent(),
            Self::InterfaceRender { .. } => Meta::new(Read).stage(Stage::Render),
            Self::ProjectExport { .. } => Meta::new(Read).stage(Stage::Export),
            Self::ProjectInfo { .. } | Self::ProjectExportTarget { .. } => Meta::new(Read),
            Self::HistoryList { .. } => Meta::new(Read).agent(),
            Self::HistoryReview { .. } => Meta::new(Read),
            Self::HistoryPreview { .. } => Meta::new(Read).stage(Stage::Render),
            Self::HistoryRestore { id, entry, .. } => Meta::new(AutoSave)
                .stage(Stage::Edit)
                .history(Action::restore(id, entry)),
        }
    }
}

/// Fits the whole definition into a bounded image: the viewport covers the
/// observed bounds plus a margin, scaled to the pixel budget.
pub(crate) fn fitted_viewport(observation: &Value) -> Viewport {
    // JSON numbers arrive as integers; a float would lose the grid.
    let number = |value: &Value| {
        value
            .as_i64()
            .or_else(|| value.as_f64().map(|n| n.round() as i64))
            .unwrap_or(0)
    };
    let bounds = &observation["focus"]["bounds"];
    let margin = 24;
    let width = (number(&bounds["width"]) + margin * 2).clamp(160, 8000);
    let height = (number(&bounds["height"]) + margin * 2).clamp(100, 8000);
    Viewport {
        x: (number(&bounds["x"]) - margin) as i32,
        y: (number(&bounds["y"]) - margin) as i32,
        width: width as u32,
        height: height as u32,
        scale: (1400. / width as f64)
            .min(900. / height as f64)
            .clamp(0.05, 2.),
    }
}

/// Attribute name/value pairs of the first serialized `<comp>` in a native reply.
fn component_attributes(component: &Value) -> Option<BTreeMap<String, String>> {
    component["children"].as_array().map(|all| {
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
}

/// The edit result: the view plus what changed, for history titles and the
/// selection the canvas restores. `noop` means nothing was written.
fn edit_result(outcome: &EditOutcome, view: DocumentView, noop: bool) -> EditResult {
    EditResult {
        revision: view.revision.clone(),
        noop: noop || outcome.title.is_empty() && outcome.changed_circuits.is_empty(),
        title: outcome.title.clone(),
        circuit: outcome.circuit.clone(),
        changed_circuits: outcome.changed_circuits.clone(),
        selection: Selection {
            components: outcome.components.clone(),
            wires: outcome.wires.clone(),
        },
        view,
    }
}

/// The edit result of a move, which commits a resolved candidate.
pub(crate) fn edit_result_for_move(
    circuit: &str,
    components: Vec<String>,
    wires: Vec<String>,
    view: DocumentView,
) -> EditResult {
    let title = if wires.is_empty() {
        format!("移动 {} 个对象", components.len() + wires.len())
    } else {
        format!("移动 {} 个元件、{} 段导线", components.len(), wires.len())
    };
    EditResult {
        revision: view.revision.clone(),
        noop: false,
        title,
        circuit: circuit.to_string(),
        changed_circuits: vec![circuit.to_string()],
        selection: Selection { components, wires },
        view,
    }
}

fn undo_result(outcome: EditOutcome, view: DocumentView, verb: &str) -> EditResult {
    let mut result = edit_result(&outcome, view, outcome.title.is_empty());
    result.title = if outcome.title.is_empty() {
        format!("{verb}修改")
    } else {
        format!("{verb}：{}", outcome.title)
    };
    result
}

fn serialized_component(reply: &Value) -> Result<&Value> {
    Ok(reply["children"]
        .as_array()
        .and_then(|all| all.iter().find(|n| n["tag"] == "comp"))
        .ok_or("元件序列化失败")?)
}

impl Host {
    /// A place or attributes edit as the native runtime resolves it against
    /// the revision the caller saw: canonical name and attribute values,
    /// checked (placement conflicts, invalid values). A placement also
    /// returns the runtime's template, with its ports. Other edits pass.
    async fn resolve_edit(
        &self,
        id: &str,
        revision: &str,
        circuit: &str,
        edit: Edit,
    ) -> Result<(Edit, Option<Value>)> {
        match edit {
            Edit::Place {
                name,
                library,
                location,
                attributes,
            } => {
                let path = self.snapshot(id, revision).await?;
                let _template = timing::span("edit.template");
                let template = self
                    .native
                    .lock()
                    .await
                    .template(
                        &path,
                        circuit,
                        library.clone(),
                        name,
                        Some(location),
                        attributes,
                    )
                    .await?;
                let component = serialized_component(&template)?;
                let resolved = Edit::Place {
                    name: component["attributes"]["name"]
                        .as_str()
                        .ok_or("元件名称缺失")?
                        .into(),
                    library,
                    location,
                    attributes: component_attributes(component).unwrap_or_default(),
                };
                Ok((resolved, Some(template)))
            }
            Edit::Attributes {
                id: component_id,
                values,
            } => {
                let (path, component) = self
                    .snapshot_component(id, revision, circuit, &component_id)
                    .await?;
                let _properties = timing::span("edit.properties");
                let checked = self
                    .native
                    .lock()
                    .await
                    .properties(&path, circuit, &component, values)
                    .await?;
                let values =
                    component_attributes(serialized_component(&checked)?).ok_or("元件属性缺失")?;
                Ok((
                    Edit::Attributes {
                        id: component_id,
                        values,
                    },
                    None,
                ))
            }
            edit => Ok((edit, None)),
        }
    }
    /// A batch's edits resolved against one revision (one native load). The
    /// runtime checks each placement against the circuit as it is; the new
    /// parts are checked against each other here, as the runtime would once
    /// they are in: no exclusive port on another's, no two alike on one spot.
    async fn resolve_batch(
        &self,
        id: &str,
        revision: &str,
        circuit: &str,
        edits: Vec<Edit>,
    ) -> Result<Vec<Edit>> {
        let mut resolved = Vec::with_capacity(edits.len());
        let mut placed: Vec<(String, Point, Vec<Point>)> = Vec::new();
        for (index, edit) in edits.into_iter().enumerate() {
            if !matches!(
                edit,
                Edit::Wire { .. }
                    | Edit::Place { .. }
                    | Edit::Delete { .. }
                    | Edit::Attributes { .. }
            ) {
                return Err("批量修改只能包含导线、放置、删除和属性修改，或者只包含移动".into());
            }
            let (edit, template) = self.resolve_edit(id, revision, circuit, edit).await?;
            if let (Edit::Place { name, location, .. }, Some(template)) = (&edit, &template) {
                let exclusive: Vec<Point> = template["children"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|n| n["tag"] == "port" && n["attributes"]["exclusive"] == "true")
                    .filter_map(|n| {
                        let at = |key: &str| n["attributes"][key].as_str()?.parse::<i32>().ok();
                        Some(Point {
                            x: location.x + at("x")?,
                            y: location.y + at("y")?,
                        })
                    })
                    .collect();
                for (other, at, ports) in &placed {
                    if other == name && at == location {
                        return Err(format!("第 {} 项：此位置已有相同元件", index + 1).into());
                    }
                    if exclusive.iter().any(|p| ports.contains(p)) {
                        return Err(format!(
                            "第 {} 项：此位置与同一批放置的元件冲突，请换一个位置",
                            index + 1
                        )
                        .into());
                    }
                }
                placed.push((name.clone(), *location, exclusive));
            }
            resolved.push(edit);
        }
        Ok(resolved)
    }
    /// A copy of the document at the revision the caller saw.
    async fn checked_document(&self, id: &str, revision: &str) -> Result<Document> {
        let workspace = self.workspace.lock().await;
        let doc = workspace.get(id)?;
        doc.check(revision)?;
        Ok(doc.clone())
    }
    pub(crate) async fn document_request(&self, request: DocumentRequest) -> Result<Reply> {
        let value = match request {
            DocumentRequest::Status => {
                let w = self.workspace.lock().await;
                let documents = w
                    .documents
                    .values()
                    .map(|d| d.view())
                    .collect::<vibe_circuit_document::Result<Vec<_>>>()?;
                let active = w.active.clone();
                drop(w);
                Ok(
                    json!({"documents":documents,"active":active,"recoveryError":self.recovery_error,"folder":self.folder.lock().await.clone(),"runtime":self.native.lock().await.status()}),
                )
            }
            DocumentRequest::New { name } => {
                value(self.workspace.lock().await.insert(Document::new(name))?)
            }
            DocumentRequest::Open { path } => value(self.workspace.lock().await.open(&path)?),
            DocumentRequest::Import { name, xml } => {
                value(self.workspace.lock().await.insert(Document::from_bytes(
                    name,
                    None,
                    xml.into_bytes(),
                    false,
                )?)?)
            }
            DocumentRequest::Read { id } => value(self.workspace.lock().await.get(&id)?.view()?),
            DocumentRequest::Activate { id } => {
                let mut w = self.workspace.lock().await;
                w.get(&id)?;
                w.active = Some(id);
                Ok(Value::Null)
            }
            DocumentRequest::Source { id, revision } => {
                let workspace = self.workspace.lock().await;
                let document = workspace.get(&id)?;
                if let Some(revision) = revision {
                    document.check(&revision)?;
                }
                Ok(
                    json!({"xml":String::from_utf8_lossy(document.bytes()),"revision":document.revision()}),
                )
            }
            DocumentRequest::SourceStatus { id } => {
                value(self.workspace.lock().await.get(&id)?.source_status())
            }
            DocumentRequest::Reload {
                id,
                revision,
                source_revision,
                discard,
            } => {
                let mut w = self.workspace.lock().await;
                let d = w.get_mut(&id)?;
                d.reload(&revision, &source_revision, discard)?;
                value(d.view()?)
            }
            DocumentRequest::Close {
                id,
                revision,
                discard,
            } => {
                let mut w = self.workspace.lock().await;
                w.get(&id)?.check(&revision)?;
                // Dispatch ends a run of the closed document after this request.
                w.close(&id, discard)?;
                Ok(json!({"closed":true}))
            }
            DocumentRequest::Save {
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
            DocumentRequest::SaveTarget { path } => match std::fs::metadata(&path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({"revision":null})),
                Err(e) => Err(e.into()),
                Ok(meta) if !meta.is_file() || meta.len() > 32 * 1024 * 1024 => {
                    Err("请选择不超过 32 MB 的电路文件".into())
                }
                Ok(_) => {
                    Ok(json!({"revision":vibe_circuit_document::digest(&std::fs::read(path)?)}))
                }
            },
            DocumentRequest::Edit {
                id,
                revision,
                circuit,
                edit,
            } => {
                let moves: Option<Vec<(Vec<String>, Point)>> = match &edit {
                    Edit::Batch { edits } if !edits.is_empty() => edits
                        .iter()
                        .map(|e| match e {
                            Edit::Move { ids, delta } => Some((ids.clone(), *delta)),
                            _ => None,
                        })
                        .collect(),
                    _ => None,
                };
                let edit = match edit {
                    _ if moves.is_some() => edit,
                    Edit::Batch { edits } => Edit::Batch {
                        edits: self.resolve_batch(&id, &revision, &circuit, edits).await?,
                    },
                    edit => self.resolve_edit(&id, &revision, &circuit, edit).await?.0,
                };
                if let Some(moves) = moves {
                    value(self.commit_moves(&id, &revision, &circuit, &moves).await?)
                } else if let Edit::Move { ids, delta } = &edit {
                    let moved = self
                        .commit_move(&id, &revision, &circuit, ids, *delta)
                        .await?;
                    value(moved)
                } else {
                    let mut w = self.workspace.lock().await;
                    let d = w.get_mut(&id)?;
                    let outcome = {
                        let _edit = timing::span("edit.apply");
                        d.edit(&revision, &circuit, edit)?
                    };
                    let view = {
                        let _view = timing::span("edit.view");
                        d.view()?
                    };
                    drop(w);
                    let _value = timing::span("edit.value");
                    value(edit_result(&outcome, view, false))
                }
            }
            DocumentRequest::MovePreview {
                id,
                revision,
                circuit,
                ids,
                delta,
            } => {
                let preview = self
                    .preview_move(&id, &revision, &circuit, &ids, delta)
                    .await?;
                value(preview)
            }
            DocumentRequest::Undo { id, revision } => {
                let (outcome, view) = {
                    let mut w = self.workspace.lock().await;
                    let d = w.get_mut(&id)?;
                    let outcome = d.undo(&revision)?;
                    (outcome, d.view()?)
                };
                value(undo_result(outcome, view, "撤销"))
            }
            DocumentRequest::Redo { id, revision } => {
                let (outcome, view) = {
                    let mut w = self.workspace.lock().await;
                    let d = w.get_mut(&id)?;
                    let outcome = d.redo(&revision)?;
                    (outcome, d.view()?)
                };
                value(undo_result(outcome, view, "重做"))
            }
            DocumentRequest::Observe {
                id,
                revision,
                circuit,
            } => {
                let p = self.snapshot(&id, &revision).await?;
                let _observe = timing::span("observe");
                let text = self.native.lock().await.observe_raw(&p, &circuit).await?;
                return Ok(Reply::Text(text));
            }
            DocumentRequest::ObserveXml {
                id,
                revision,
                circuit,
                xml,
            } => {
                // Written where the applied revision's file would go, so
                // applying the same XML afterwards loads nothing new.
                let p = {
                    let w = self.workspace.lock().await;
                    let proposed = w.get(&id)?.preview(
                        &revision,
                        &circuit,
                        Edit::Replace { xml, title: None },
                    )?;
                    self.materialize(&proposed)?
                };
                let _observe = timing::span("observe");
                let text = self.native.lock().await.observe_raw(&p, &circuit).await?;
                return Ok(Reply::Text(text));
            }
            DocumentRequest::Template {
                id,
                revision,
                circuit,
                library,
                name,
                attributes,
            } => {
                let path = self.snapshot(&id, &revision).await?;
                Ok(self
                    .native
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
                    .await?)
            }
            DocumentRequest::Properties {
                id,
                revision,
                circuit,
                component,
            } => {
                let (path, component) = self
                    .snapshot_component(&id, &revision, &circuit, &component)
                    .await?;
                Ok(self
                    .native
                    .lock()
                    .await
                    .properties(&path, &circuit, &component, BTreeMap::new())
                    .await?)
            }
            DocumentRequest::Catalog {
                id,
                revision,
                circuit,
            } => {
                let path = self.snapshot(&id, &revision).await?;
                Ok(self.native.lock().await.catalog(&path, &circuit).await?)
            }
            DocumentRequest::Render {
                id,
                revision,
                circuit,
                x,
                y,
                width,
                height,
                scale,
            } => {
                let path = self.snapshot(&id, &revision).await?;
                let mut native = self.native.lock().await;
                let viewport = match (x, y, width, height, scale) {
                    (Some(x), Some(y), Some(width), Some(height), Some(scale)) => Viewport {
                        x,
                        y,
                        width,
                        height,
                        scale,
                    },
                    _ => fitted_viewport(&native.observe(&path, &circuit).await?),
                };
                let _render = timing::span("render");
                let image = native.render(&path, &circuit, viewport).await?;
                Ok(json!({
                    "image": image,
                    "viewport": {
                        "x": viewport.x,
                        "y": viewport.y,
                        "width": viewport.width,
                        "height": viewport.height,
                        "scale": viewport.scale,
                    },
                }))
            }
            DocumentRequest::Simulate {
                id,
                revision,
                circuit,
                vectors,
            } => {
                let doc = self.checked_document(&id, &revision).await?;
                self.verify_vectors_document(&doc, &circuit, vectors).await
            }
            DocumentRequest::Trace {
                id,
                revision,
                circuit,
                ticks,
                inputs,
                events,
                buttons,
                reset,
                program,
                watches,
            } => {
                let doc = self.checked_document(&id, &revision).await?;
                self.trace_document(
                    &doc,
                    &circuit,
                    TracePlan {
                        ticks,
                        inputs,
                        watches,
                        events,
                        buttons,
                        reset,
                        program: program.map(|p| (p.component, p.words)),
                    },
                )
                .await
            }
            DocumentRequest::InterfaceRead {
                id,
                revision,
                circuit,
            } => self.read_interface(&id, &revision, &circuit).await,
            DocumentRequest::InterfacePreview {
                id,
                revision,
                circuit,
                draft,
            } => {
                self.preview_interface(&id, &revision, &circuit, &draft)
                    .await
            }
            DocumentRequest::InterfaceApply {
                id,
                revision,
                circuit,
                preview_id,
                draft,
            } => {
                self.apply_interface(&id, &revision, &circuit, &preview_id, &draft)
                    .await
            }
            DocumentRequest::InterfaceRender {
                id,
                revision,
                preview_id,
                circuit,
            } => {
                self.render_interface(&id, &revision, &preview_id, &circuit)
                    .await
            }
            DocumentRequest::ProjectInfo { id, revision } => {
                self.project_info(&id, &revision).await
            }
            DocumentRequest::ProjectExport {
                id,
                revision,
                path,
                expected_revision,
            } => {
                self.project_export(
                    &id,
                    &revision,
                    path.as_deref(),
                    expected_revision.as_deref(),
                )
                .await
            }
            DocumentRequest::ProjectExportTarget { path } => project_info::export_target(&path),
            DocumentRequest::HistoryList { id } => self.history_list(&id).await,
            DocumentRequest::HistoryReview {
                id,
                revision,
                entry,
                mode,
            } => self.history_review(&id, &revision, &entry, &mode).await,
            DocumentRequest::HistoryPreview {
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
            DocumentRequest::HistoryRestore {
                id,
                revision,
                entry,
            } => self.history_restore(&id, &revision, &entry).await,
        };
        value.map(Reply::Value)
    }
}
