use super::{Effect::*, Meta};
use crate::{Host, Result, diagnostics::Stage, document_history::Action};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use vibe_workspace_core::{DocumentView, Edit, EditOutcome, Point};

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
    pub added_wires: Vec<vibe_workspace_core::Wire>,
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

#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum EditingRequest {
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
    Observe {
        id: String,
        revision: String,
        circuit: String,
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
}

impl EditingRequest {
    pub(crate) const OPS: &[&str] = &[
        "edit",
        "movePreview",
        "undo",
        "redo",
        "observe",
        "template",
        "properties",
        "catalog",
        "render",
    ];
    pub(crate) fn meta(&self) -> Meta {
        match self {
            Self::Edit { id, edit, .. } => Meta::new(AutoSave)
                .stage(Stage::Edit)
                .history(Action::edit(id, edit))
                .agent(),
            Self::MovePreview { .. } => Meta::new(Read),
            Self::Undo { id, .. } => Meta::new(AutoSave)
                .stage(Stage::Edit)
                .history(Action::document("undo", "撤销修改", id)),
            Self::Redo { id, .. } => Meta::new(AutoSave)
                .stage(Stage::Edit)
                .history(Action::document("redo", "重做修改", id)),
            Self::Observe { .. } => Meta::new(Read).stage(Stage::Observe).agent(),
            Self::Template { .. } | Self::Properties { .. } | Self::Catalog { .. } => {
                Meta::new(Read).stage(Stage::Library)
            }
            Self::Render { .. } => Meta::new(Read).stage(Stage::Render).agent(),
        }
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
    pub(crate) async fn editing_request(&self, request: EditingRequest) -> Result<Value> {
        match request {
            EditingRequest::Edit {
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
                    let component = serialized_component(&template)?;
                    edit = Edit::Place {
                        name: component["attributes"]["name"]
                            .as_str()
                            .ok_or("元件名称缺失")?
                            .into(),
                        library: library.clone(),
                        location: *location,
                        attributes: component_attributes(component).unwrap_or_default(),
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
                    let canonical = component_attributes(serialized_component(&checked)?)
                        .ok_or("元件属性缺失")?;
                    edit = Edit::Attributes {
                        id: component_id.clone(),
                        values: canonical,
                    };
                }
                if let Edit::Move { ids, delta } = &edit {
                    let moved = self
                        .commit_move(&id, &revision, &circuit, ids, *delta)
                        .await?;
                    Ok(crate::value(moved)?)
                } else {
                    let mut w = self.workspace.lock().await;
                    let d = w.get_mut(&id)?;
                    let outcome = d.edit(&revision, &circuit, edit)?;
                    let view = d.view()?;
                    drop(w);
                    Ok(crate::value(edit_result(&outcome, view, false))?)
                }
            }
            EditingRequest::MovePreview {
                id,
                revision,
                circuit,
                ids,
                delta,
            } => {
                let preview = self
                    .preview_move(&id, &revision, &circuit, &ids, delta)
                    .await?;
                Ok(crate::value(preview)?)
            }
            EditingRequest::Undo { id, revision } => {
                let (outcome, view) = {
                    let mut w = self.workspace.lock().await;
                    let d = w.get_mut(&id)?;
                    let outcome = d.undo(&revision)?;
                    (outcome, d.view()?)
                };
                Ok(crate::value(undo_result(outcome, view, "撤销"))?)
            }
            EditingRequest::Redo { id, revision } => {
                let (outcome, view) = {
                    let mut w = self.workspace.lock().await;
                    let d = w.get_mut(&id)?;
                    let outcome = d.redo(&revision)?;
                    (outcome, d.view()?)
                };
                Ok(crate::value(undo_result(outcome, view, "重做"))?)
            }
            EditingRequest::Observe {
                id,
                revision,
                circuit,
            } => {
                let (p, _) = self.snapshot(&id, &revision).await?;
                Ok(self.native.lock().await.observe(&p, &circuit).await?)
            }
            EditingRequest::Template {
                id,
                revision,
                circuit,
                library,
                name,
                attributes,
            } => {
                let (path, _) = self.snapshot(&id, &revision).await?;
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
            EditingRequest::Properties {
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
                Ok(self
                    .native
                    .lock()
                    .await
                    .properties(&path, &circuit, component, BTreeMap::new())
                    .await?)
            }
            EditingRequest::Catalog {
                id,
                revision,
                circuit,
            } => {
                let (p, v) = self.snapshot(&id, &revision).await?;
                Ok(self.native.lock().await.catalog(&p, &v, &circuit).await?)
            }
            EditingRequest::Render {
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
        }
    }
}
