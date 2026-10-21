use super::{Effect::*, Meta};
use crate::{Host, Result, diagnostics::Stage, document_history::Action, value};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use vibe_logisim_adapter::simulation::{ActResult, Command, RunDocument, Snapshot, Target};
use vibe_workspace_core::Edit;

/// What a command addresses, as the request carries it: the view of a run, or
/// the circuit definition on screen.
#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TargetRequest {
    Run { session_id: String, view_id: String },
    Definition { circuit: String },
}

#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum SimulationRequest {
    /// Starts, drives or configures the run the target names.
    SimulationAct {
        document_id: String,
        revision: String,
        target: TargetRequest,
        command: Command,
        #[serde(default)]
        #[ts(optional)]
        initial_frequency: Option<f64>,
    },
    /// Shows a subcircuit instance of the run; an empty path returns to the root.
    SimulationNavigate {
        session_id: String,
        instance_path: Vec<String>,
    },
    SimulationViewport {
        session_id: String,
        view_id: String,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        scale: f64,
    },
    SimulationStop {
        session_id: String,
    },
    SimulationStatus,
    /// A kept frame of the run, paged to the components asked for.
    SimulationSnapshot {
        session_id: String,
        #[serde(default)]
        #[ts(optional)]
        frame_sequence: Option<u64>,
        #[serde(default)]
        #[ts(optional)]
        component_ids: Option<Vec<String>>,
        #[serde(default)]
        #[ts(optional)]
        offset: Option<usize>,
        #[serde(default)]
        #[ts(optional)]
        limit: Option<usize>,
        #[serde(default)]
        trace: bool,
        #[serde(default)]
        memory: bool,
    },
    /// The PNG of a kept frame, as a data URL over JSON transports.
    SimulationFrameImage {
        session_id: String,
        frame_sequence: u64,
    },
    /// ROM content, read through the editor worker; RAM content is in the run.
    Memory {
        id: String,
        revision: String,
        circuit: String,
        component: String,
        offset: u32,
        count: u32,
    },
    /// A ROM word: a document edit that ends the run like any other.
    MemoryWrite {
        id: String,
        revision: String,
        circuit: String,
        component: String,
        address: u32,
        expected: String,
        value: String,
    },
    /// Kept frames of a document, newest first; the records themselves follow.
    ObservationList {
        id: String,
    },
    /// One kept frame, cut to the components asked for like a snapshot. The
    /// document is the one the record was kept under.
    ObservationGet {
        id: String,
        record: String,
        #[serde(default)]
        #[ts(optional)]
        component_ids: Option<Vec<String>>,
        #[serde(default)]
        #[ts(optional)]
        offset: Option<usize>,
        #[serde(default)]
        #[ts(optional)]
        limit: Option<usize>,
    },
    /// The PNG of a kept frame, as a data URL over JSON transports.
    ObservationImage {
        record: String,
    },
    /// Freezes the frame the user saw; reads the run's rings, never the runtime.
    ObservationCapture {
        session_id: String,
        view_id: String,
        #[serde(default)]
        #[ts(optional)]
        frame_sequence: Option<u64>,
        #[serde(default)]
        title: String,
    },
    ObservationRename {
        record: String,
        title: String,
    },
    ObservationDelete {
        record: String,
    },
}

/// Components one snapshot returns at most.
const PAGE: usize = 64;

/// A kept frame cut to the components asked for; unchanged components stay
/// shared, so paging costs one filter per request.
fn paged(
    snapshot: Snapshot,
    component_ids: Option<Vec<String>>,
    offset: Option<usize>,
    limit: Option<usize>,
    memory: bool,
) -> Snapshot {
    let mut frame = snapshot.frame;
    page_frame(&mut frame, component_ids, offset, limit);
    if !memory {
        frame.memory = None;
    }
    Snapshot {
        session: snapshot.session,
        trace: snapshot.trace,
        frame,
    }
}

fn page_frame(
    frame: &mut vibe_logisim_adapter::simulation::Frame,
    component_ids: Option<Vec<String>>,
    offset: Option<usize>,
    limit: Option<usize>,
) {
    frame.page(
        component_ids.as_deref(),
        offset.unwrap_or(0),
        limit.unwrap_or(PAGE).min(PAGE),
    );
}

impl SimulationRequest {
    pub(crate) const OPS: &[&str] = &[
        "simulationAct",
        "simulationNavigate",
        "simulationViewport",
        "simulationStop",
        "simulationStatus",
        "simulationSnapshot",
        "simulationFrameImage",
        "memory",
        "memoryWrite",
        "observationList",
        "observationGet",
        "observationImage",
        "observationCapture",
        "observationRename",
        "observationDelete",
    ];
    pub(crate) fn meta(&self) -> Meta {
        match self {
            Self::SimulationAct { .. }
            | Self::SimulationNavigate { .. }
            | Self::SimulationViewport { .. } => Meta::new(Read).stage(Stage::Simulation),
            Self::SimulationStop { .. } => Meta::new(Read),
            // The AI reads the run state the user asks from; it never drives it.
            Self::SimulationStatus
            | Self::SimulationSnapshot { .. }
            | Self::SimulationFrameImage { .. }
            | Self::ObservationList { .. }
            | Self::ObservationGet { .. }
            | Self::ObservationImage { .. } => Meta::new(Read).agent(),
            Self::ObservationCapture { .. }
            | Self::ObservationRename { .. }
            | Self::ObservationDelete { .. } => Meta::new(Read),
            Self::Memory { .. } => Meta::new(Read).stage(Stage::Library),
            Self::MemoryWrite { id, .. } => Meta::new(AutoSave)
                .stage(Stage::Edit)
                .history(Action::document("memory", "修改存储器内容", id)),
        }
    }
}

impl Host {
    pub(crate) async fn simulation_request(&self, request: SimulationRequest) -> Result<Value> {
        match request {
            SimulationRequest::SimulationAct {
                document_id,
                revision,
                target,
                command,
                initial_frequency,
            } => {
                let target = match target {
                    TargetRequest::Run {
                        session_id,
                        view_id,
                    } => Target::Run {
                        session_id,
                        view_id,
                        revision,
                    },
                    TargetRequest::Definition { circuit } => {
                        // A command that cannot start a run applies to nothing.
                        if command.starts_run() {
                            let (artifact, view) = self.snapshot(&document_id, &revision).await?;
                            Target::Definition {
                                document: RunDocument { artifact, view },
                                circuit,
                            }
                        } else {
                            return value(ActResult::default());
                        }
                    }
                };
                let result = self
                    .simulation
                    .act(target, command, initial_frequency)
                    .await?;
                value(result)
            }
            SimulationRequest::SimulationNavigate {
                session_id,
                instance_path,
            } => {
                let result = self.simulation.navigate(&session_id, instance_path).await?;
                value(result)
            }
            SimulationRequest::SimulationViewport {
                session_id,
                view_id,
                x,
                y,
                width,
                height,
                scale,
            } => {
                let revision = self
                    .simulation
                    .session()
                    .filter(|session| session.session_id == session_id)
                    .map(|session| session.revision)
                    .ok_or_else(|| {
                        vibe_logisim_adapter::simulation::SimError::from(
                            vibe_logisim_adapter::simulation::Code::SessionEnded,
                        )
                    })?;
                let target = Target::Run {
                    session_id,
                    view_id,
                    revision,
                };
                let command = Command::Viewport {
                    x,
                    y,
                    width,
                    height,
                    scale,
                };
                let result = self.simulation.act(target, command, None).await?;
                value(result)
            }
            SimulationRequest::SimulationStop { session_id } => {
                value(serde_json::json!({"stopped": self.simulation.stop(&session_id)}))
            }
            SimulationRequest::SimulationStatus => value(self.simulation.status()),
            SimulationRequest::SimulationSnapshot {
                session_id,
                frame_sequence,
                component_ids,
                offset,
                limit,
                trace,
                memory,
            } => {
                let snapshot = self
                    .simulation
                    .snapshot(&session_id, frame_sequence, trace)?;
                value(paged(snapshot, component_ids, offset, limit, memory))
            }
            SimulationRequest::SimulationFrameImage {
                session_id,
                frame_sequence,
            } => {
                let bytes = self.simulation.frame_image(&session_id, frame_sequence)?;
                Ok(Value::String(format!(
                    "data:image/png;base64,{}",
                    B64.encode(bytes.as_slice())
                )))
            }
            SimulationRequest::Memory {
                id,
                revision,
                circuit,
                component,
                offset,
                count,
            } => {
                self.rom_memory(id, revision, circuit, component, offset, count)
                    .await
            }
            SimulationRequest::MemoryWrite {
                id,
                revision,
                circuit,
                component,
                address,
                expected,
                value: word,
            } => {
                self.rom_write(id, revision, circuit, component, address, &expected, &word)
                    .await
            }
            SimulationRequest::ObservationList { id } => self.observations(&id).await,
            SimulationRequest::ObservationGet {
                record,
                component_ids,
                offset,
                limit,
                ..
            } => {
                let mut record = self.observation_record(&record).await?;
                page_frame(&mut record.frame, component_ids, offset, limit);
                value(record)
            }
            SimulationRequest::ObservationImage { record } => self.observation_image(&record),
            SimulationRequest::ObservationCapture {
                session_id,
                view_id,
                frame_sequence,
                title,
            } => {
                self.capture(&session_id, &view_id, frame_sequence, title)
                    .await
            }
            SimulationRequest::ObservationRename { record, title } => {
                self.rename_observation(&record, &title)
            }
            SimulationRequest::ObservationDelete { record } => self.delete_observation(&record),
        }
    }
    async fn rom_memory(
        &self,
        id: String,
        revision: String,
        circuit: String,
        component: String,
        offset: u32,
        count: u32,
    ) -> Result<Value> {
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
            .ok_or("请选择 ROM；RAM 内容需要在运行实例中读取")?;
        Ok(self
            .native
            .lock()
            .await
            .memory(
                &path,
                &circuit,
                selected,
                BTreeMap::from([
                    ("offset".into(), offset.to_string()),
                    ("count".into(), count.to_string()),
                ]),
                false,
            )
            .await?)
    }
    #[allow(clippy::too_many_arguments)]
    async fn rom_write(
        &self,
        id: String,
        revision: String,
        circuit: String,
        component: String,
        address: u32,
        expected: &str,
        word: &str,
    ) -> Result<Value> {
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
                    ("expected".into(), expected.into()),
                    ("value".into(), word.into()),
                ]),
                true,
            )
            .await?;
        let contents = result["contents"].as_str().ok_or("无法序列化 ROM")?.into();
        let mut workspace = self.workspace.lock().await;
        let document = workspace.get_mut(&id)?;
        document.edit(
            &revision,
            &circuit,
            Edit::Attributes {
                id: component,
                values: BTreeMap::from([("contents".into(), contents)]),
            },
        )?;
        value(document.view()?)
    }
}
