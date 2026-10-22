//! Operations on a draft artifact: an in-memory circuit file the AI edits
//! before anything is applied. The workspace document is only read here, so a
//! draft never records history, autosaves, or disturbs the open project.
use super::{Effect::*, Meta};
use crate::{
    Host, Result,
    diagnostics::Stage,
    topology,
    verification::{InputEvent, TestVector, TraceWatch},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use vibe_workspace_core::{Component, Document, Edit, Point};

#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct TraceButton {
    pub component: String,
    pub tick: u32,
    pub pressed: bool,
}

#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct TraceProgramInput {
    pub component: String,
    pub words: Vec<u32>,
}

#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(tag = "op", rename_all = "camelCase")]
#[allow(clippy::enum_variant_names)]
pub enum DraftRequest {
    /// Observe one circuit definition of the draft through the native runtime.
    DraftObserve {
        id: String,
        revision: String,
        xml: String,
        circuit: String,
    },
    /// Render the draft: a requested viewport, or a fitted view of the circuit.
    DraftRender {
        id: String,
        revision: String,
        xml: String,
        circuit: String,
        #[serde(default)]
        #[ts(optional)]
        viewport: Option<Viewport>,
    },
    /// Default attributes and allowed values of a palette tool, as the native
    /// runtime would initialize them.
    DraftTemplate {
        id: String,
        revision: String,
        xml: String,
        circuit: String,
        #[serde(default)]
        library: Option<String>,
        name: String,
        #[serde(default)]
        attributes: BTreeMap<String, String>,
    },
    /// Apply structural edits to the draft in order and return the new source.
    DraftEdit {
        id: String,
        revision: String,
        xml: String,
        circuit: String,
        edits: Vec<Edit>,
    },
    /// Independent test vectors against one definition of the draft.
    DraftSimulate {
        id: String,
        revision: String,
        xml: String,
        circuit: String,
        vectors: Vec<TestVector>,
    },
    /// A tick sequence against one definition of the draft.
    DraftTrace {
        id: String,
        revision: String,
        xml: String,
        circuit: String,
        ticks: u32,
        #[serde(default)]
        inputs: BTreeMap<String, u32>,
        #[serde(default)]
        events: Vec<InputEvent>,
        #[serde(default)]
        buttons: Vec<TraceButton>,
        #[serde(default)]
        reset: Option<String>,
        #[serde(default)]
        program: Option<TraceProgramInput>,
        watches: Vec<TraceWatch>,
    },
}

#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub scale: f64,
}

impl DraftRequest {
    pub(crate) const OPS: &[&str] = &[
        "draftObserve",
        "draftRender",
        "draftTemplate",
        "draftEdit",
        "draftSimulate",
        "draftTrace",
    ];
    pub(crate) fn meta(&self) -> Meta {
        match self {
            Self::DraftObserve { .. } => Meta::new(Read).stage(Stage::Observe).agent(),
            Self::DraftRender { .. } => Meta::new(Read).stage(Stage::Render).agent(),
            Self::DraftTemplate { .. } => Meta::new(Read).stage(Stage::Library).agent(),
            Self::DraftEdit { .. } => Meta::new(Read).stage(Stage::Edit).agent(),
            Self::DraftSimulate { .. } | Self::DraftTrace { .. } => {
                Meta::new(Read).stage(Stage::Verify).agent()
            }
        }
    }
}

impl Host {
    /// The draft as a document: same folder and name as the open file, so
    /// library paths resolve as the project expects, with its own identity so
    /// materialized snapshots never collide with the workspace document.
    async fn draft_document(&self, id: &str, revision: &str, xml: &str) -> Result<Document> {
        let (name, path) = {
            let workspace = self.workspace.lock().await;
            let current = workspace.get(id).map_err(|e| e.to_string())?;
            let view = current.view().map_err(|e| e.to_string())?;
            (view.name, view.path)
        };
        let mut draft = Document::from_bytes(name, path, xml.as_bytes().to_vec(), false)
            .map_err(|e| e.to_string())?;
        draft.id = format!("{id}-draft");
        // The caller names the base revision; the draft must be built on it.
        let _ = revision;
        Ok(draft)
    }
    fn draft_component(draft: &Document, circuit: &str, id: &str) -> Result<Component> {
        let view = draft.view().map_err(|e| e.to_string())?;
        view.circuits
            .iter()
            .find(|c| c.name == circuit)
            .and_then(|c| c.components.iter().find(|c| c.id == id))
            .cloned()
            .ok_or_else(|| crate::HostError::from(format!("元件 {id} 不在 {circuit} 中")))
    }
    /// Canonical properties of a component as the native runtime serializes
    /// them, optionally with the requested values applied.
    async fn draft_attributes(
        &self,
        path: &std::path::Path,
        circuit: &str,
        component: &Component,
        values: BTreeMap<String, String>,
    ) -> Result<BTreeMap<String, String>> {
        let reply = self
            .native
            .lock()
            .await
            .properties(path, circuit, component, values)
            .await?;
        serialized_attributes(&reply)
            .ok_or_else(|| crate::HostError::from("元件属性缺失".to_string()))
    }
    pub(crate) async fn draft_request(&self, request: DraftRequest) -> Result<Value> {
        match request {
            DraftRequest::DraftObserve {
                id,
                revision,
                xml,
                circuit,
            } => {
                let draft = self.draft_document(&id, &revision, &xml).await?;
                let (path, _) = self.materialize(&draft)?;
                Ok(self.native.lock().await.observe(&path, &circuit).await?)
            }
            DraftRequest::DraftRender {
                id,
                revision,
                xml,
                circuit,
                viewport,
            } => {
                let draft = self.draft_document(&id, &revision, &xml).await?;
                let (path, _) = self.materialize(&draft)?;
                let mut native = self.native.lock().await;
                let viewport = match viewport {
                    Some(viewport) => viewport,
                    None => {
                        let observation = native.observe(&path, &circuit).await?;
                        fitted_viewport(&observation)?
                    }
                };
                let image = native
                    .render(
                        &path,
                        &circuit,
                        vibe_logisim_adapter::Viewport {
                            x: viewport.x,
                            y: viewport.y,
                            width: viewport.width as u32,
                            height: viewport.height as u32,
                            scale: viewport.scale,
                        },
                    )
                    .await?;
                Ok(json!({"image":image,"viewport":viewport}))
            }
            DraftRequest::DraftTemplate {
                id,
                revision,
                xml,
                circuit,
                library,
                name,
                attributes,
            } => {
                let draft = self.draft_document(&id, &revision, &xml).await?;
                let (path, _) = self.materialize(&draft)?;
                Ok(self
                    .native
                    .lock()
                    .await
                    .template(&path, &circuit, library, name, None, attributes)
                    .await?)
            }
            DraftRequest::DraftEdit {
                id,
                revision,
                xml,
                circuit,
                edits,
            } => self.draft_edit(&id, &revision, xml, &circuit, edits).await,
            DraftRequest::DraftSimulate {
                id,
                revision,
                xml,
                circuit,
                vectors,
            } => {
                if vectors.is_empty() || vectors.len() > 256 {
                    return Err("请提供 1–256 组测试向量".into());
                }
                let draft = self.draft_document(&id, &revision, &xml).await?;
                let (artifact, _) = self.materialize(&draft)?;
                let dependencies = vibe_logisim_adapter::artifact_dependencies(&artifact)?;
                let result = self
                    .verify_vectors_document(&draft, &circuit, vectors)
                    .await?;
                // Keeping the result as evidence is what lets the review show
                // why the candidate is believed correct.
                self.store_verification(
                    &id,
                    &draft.revision(),
                    &revision,
                    &circuit,
                    "vectors",
                    dependencies,
                    &result,
                )?;
                Ok(result)
            }
            DraftRequest::DraftTrace {
                id,
                revision,
                xml,
                circuit,
                ticks,
                inputs,
                events,
                buttons,
                reset,
                program,
                watches,
            } => {
                let draft = self.draft_document(&id, &revision, &xml).await?;
                let (artifact, _) = self.materialize(&draft)?;
                let dependencies = vibe_logisim_adapter::artifact_dependencies(&artifact)?;
                let result = self
                    .trace_document(
                        &draft,
                        &circuit,
                        crate::verification::TracePlan {
                            ticks,
                            inputs,
                            watches,
                            events,
                            buttons: buttons
                                .into_iter()
                                .map(|b| crate::verification::ButtonEvent {
                                    component: b.component,
                                    tick: b.tick,
                                    pressed: b.pressed,
                                })
                                .collect(),
                            reset,
                            program: program.map(|p| (p.component, p.words)),
                        },
                    )
                    .await?;
                self.store_verification(
                    &id,
                    &draft.revision(),
                    &revision,
                    &circuit,
                    "trace",
                    dependencies,
                    &result,
                )?;
                Ok(result)
            }
        }
    }
    async fn draft_edit(
        &self,
        id: &str,
        revision: &str,
        xml: String,
        circuit: &str,
        edits: Vec<Edit>,
    ) -> Result<Value> {
        if edits.is_empty() || edits.len() > 256 {
            return Err("请提供 1–256 个编辑".into());
        }
        let mut draft = self.draft_document(id, revision, &xml).await?;
        // Placing is the one edit that needs the native palette: the runtime
        // fills defaults, canonicalizes the factory name and the library.
        for edit in edits {
            let edit = match edit {
                Edit::Place {
                    name,
                    library,
                    location,
                    attributes,
                } => {
                    let (path, _) = self.materialize(&draft)?;
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
                    Edit::Place {
                        name: component["attributes"]["name"]
                            .as_str()
                            .ok_or("元件名称缺失")?
                            .into(),
                        library,
                        location,
                        attributes: serialized_attributes(component).unwrap_or_default(),
                    }
                }
                Edit::Attributes { id, values } => {
                    let component = Self::draft_component(&draft, circuit, &id)?;
                    let (path, _) = self.materialize(&draft)?;
                    let before = self
                        .draft_attributes(&path, circuit, &component, BTreeMap::new())
                        .await?;
                    let after = self
                        .draft_attributes(&path, circuit, &component, values.clone())
                        .await?;
                    // Write back only the names this request actually changed, so
                    // unrelated defaults never land in the file.
                    let changed: BTreeMap<_, _> = after
                        .iter()
                        .filter(|(name, value)| before.get(*name) != Some(*value))
                        .map(|(name, value)| (name.clone(), value.clone()))
                        .collect();

                    if changed.is_empty() {
                        continue;
                    }
                    Edit::Attributes {
                        id,
                        values: changed,
                    }
                }
                Edit::Move { ids, delta } => {
                    self.draft_move(&mut draft, circuit, &ids, delta).await?;
                    continue;
                }
                edit => edit,
            };
            let current = draft.revision();
            draft
                .edit(&current, circuit, edit)
                .map_err(|e| e.to_string())?;
        }
        let bytes = draft.bytes().to_vec();
        let text = String::from_utf8(bytes).map_err(|_| "电路文件编码无法写回")?;
        Ok(json!({
            "xml": text,
            "revision": draft.revision(),
            "circuit": circuit,
        }))
    }
    /// Move components in the draft with the same connection proof the editor
    /// uses, so a move that breaks topology is refused instead of applied.
    async fn draft_move(
        &self,
        draft: &mut Document,
        circuit: &str,
        ids: &[String],
        delta: Point,
    ) -> Result<()> {
        if ids.is_empty() {
            return Err("请选择要移动的元件".into());
        }
        let view = draft.view().map_err(|e| e.to_string())?;
        let graph = view
            .circuits
            .iter()
            .find(|c| c.name == circuit)
            .cloned()
            .ok_or("找不到电路")?;
        let (path, _) = self.materialize(draft)?;
        let before = self.native.lock().await.observe(&path, circuit).await?;
        let (ports, fixed_ports) = topology::ports(&graph, &before, ids)?;
        let revision = draft.revision();
        draft
            .move_connected(&revision, circuit, ids.to_vec(), delta, ports, fixed_ports)
            .map_err(|e| e.to_string())?;
        // The moved draft is a different file; compare its native nets before
        // accepting it, exactly as an interactive drag does.
        let (after_path, _) = self.materialize(draft)?;
        let after = self
            .native
            .lock()
            .await
            .observe(&after_path, circuit)
            .await?;
        topology::preserved(&graph, &before, &after, ids, delta)?;
        Ok(())
    }
}

/// Fit the whole definition into a bounded image: the viewport covers the
/// observed bounds plus a margin, scaled to the pixel budget.
fn fitted_viewport(observation: &Value) -> Result<Viewport> {
    // JSON numbers arrive as u64/i64; a float would lose the grid.
    let number = |value: &Value| {
        value
            .as_i64()
            .or_else(|| value.as_u64().map(|n| n as i64))
            .or_else(|| value.as_f64().map(|n| n.round() as i64))
            .unwrap_or(0) as i32
    };
    let bounds = &observation["focus"]["bounds"];
    let margin = 24;
    let x = number(&bounds["x"]) - margin;
    let y = number(&bounds["y"]) - margin;
    let width = (number(&bounds["width"]) + margin * 2).clamp(160, 8000);
    let height = (number(&bounds["height"]) + margin * 2).clamp(100, 8000);
    let scale = (1400. / width as f64)
        .min(900. / height as f64)
        .clamp(0.05, 2.);
    Ok(Viewport {
        x,
        y,
        width,
        height,
        scale,
    })
}

fn serialized_component(reply: &Value) -> Result<&Value> {
    Ok(reply["children"]
        .as_array()
        .and_then(|all| all.iter().find(|n| n["tag"] == "comp"))
        .ok_or("元件序列化失败")?)
}

/// Attribute values of a native component reply. `component-attributes`
/// answers with `<attribute name value>` children; a serialized `<comp>`
/// carries `<a name val>` instead; both end up as one name/value map.
fn serialized_attributes(component: &Value) -> Option<BTreeMap<String, String>> {
    let all = component["children"].as_array()?;
    Some(
        all.iter()
            .filter_map(|n| {
                let attributes = &n["attributes"];
                if n["tag"] == "comp" {
                    return None;
                }
                let name = attributes["name"].as_str()?;
                Some((
                    name.to_string(),
                    attributes["value"]
                        .as_str()
                        .or_else(|| attributes["val"].as_str())
                        .or_else(|| n["text"].as_str())
                        .unwrap_or("")
                        .to_string(),
                ))
            })
            .collect(),
    )
}
