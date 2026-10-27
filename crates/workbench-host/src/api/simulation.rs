use super::{Effect::*, Meta};
use crate::{Host, Result, app::diagnostics::Stage, documents::history::Action, value};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use vibe_circuit_document::Edit;
use vibe_logisim_runtime::simulation::{
    ActResult, Command, MemoryPage, MemoryStorage, RunDocument, Snapshot, Target,
};

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

/// The live run and the frames kept from it.
///
/// There is at most one run at a time. The window drives it with
/// `simulationAct` and follows it through `simulation` events (`session`, then
/// `state` deltas carrying what changed in the components and the picture,
/// then `ended`). None of these requests changes a document: stimulus never
/// makes a revision and never saves. Only `memoryWrite`, which edits a ROM's
/// stored contents, does.
///
/// The agent reads, never drives: `simulationStatus` and `simulationSnapshot`
/// for the run the user is looking at, and `observationList`,
/// `observationGet` and `observationImage` for frames the user kept. The isolated test runs behind its vector and trace tools are the
/// `simulate` and `trace` review requests, which never touch the live run.
#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SimulationRequest {
    /// Starts, drives or configures a run. With a `definition` target, a
    /// command that starts runs (start, clock, tick, step, poke, input, pulse,
    /// button press, propagation toggle) starts a run of that circuit, or
    /// reuses the current run when it is of the same circuit and revision;
    /// other commands do nothing. With a `run` target, the command goes to that
    /// view of the run; a run that ended or is of another revision refuses
    /// commands that start runs and ignores the rest. `initialFrequency`
    /// applies when this command starts the run. Returns an `ActResult`.
    SimulationAct {
        document_id: String,
        revision: String,
        target: TargetRequest,
        command: Command,
        #[serde(default)]
        #[ts(optional)]
        initial_frequency: Option<f64>,
    },
    /// Shows a subcircuit instance of the run, keeping its state: the path
    /// holds component ids from the root circuit, and an empty path returns
    /// to the root. Every call makes a new view, which releases held buttons,
    /// clears the waveform and the shown memory page, and paints the whole
    /// view again.
    SimulationNavigate {
        session_id: String,
        instance_path: Vec<String>,
    },
    /// Ends the run. Returns `{"stopped": false}` when it already ended.
    SimulationStop {
        session_id: String,
    },
    /// The current run, its current view and clock, and how the last run
    /// ended (`Status`). Answered from memory.
    SimulationStatus,
    /// A kept frame of the run (the newest unless `frameSequence` names one),
    /// with component states paged by `componentIds`, `offset` and `limit`
    /// (at most 4096), the waveform when `trace` is set and the shown memory
    /// page when `memory` is set. Returns a `Snapshot`.
    SimulationSnapshot {
        session_id: String,
        #[serde(default)]
        #[ts(optional)]
        #[ts(type = "number")]
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
    /// A page of a ROM's stored contents (`MemoryPage` with `design`
    /// storage), read through the editor worker. A RAM's contents belong to a
    /// run: send the run a `memory` command and read the page from its frames.
    Memory {
        id: String,
        revision: String,
        circuit: String,
        component: String,
        offset: u32,
        count: u32,
    },
    /// Writes one ROM word if it still holds `expected` (both hex). It is a
    /// document edit, saved like any other, so it ends a run of the old
    /// revision. Returns the document view.
    MemoryWrite {
        id: String,
        revision: String,
        circuit: String,
        component: String,
        address: u32,
        expected: String,
        value: String,
    },
    /// The frames kept for a document, newest first, as `ObservationSummary`
    /// rows. A file that cannot be read is a row with `damaged` set, which can
    /// only be deleted.
    ObservationList {
        id: String,
    },
    /// One kept frame of the document (`ObservationRecord`): its revision,
    /// root circuit, instance path, watched signals, waveform and component
    /// states, paged like a snapshot.
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
    /// The picture of a kept frame, as a PNG data URL. Fails for a record
    /// kept without one.
    ObservationImage {
        record: String,
    },
    /// Keeps the frame the user saw (the newest unless `frameSequence` names
    /// one) with its waveform, read from what the run already delivered, never
    /// from the runtime. Fails when the run moved to another view meanwhile.
    /// `imageData` is the picture the window showed, a PNG data URL of at
    /// most 8 MB, kept beside the record.
    ObservationCapture {
        session_id: String,
        view_id: String,
        #[serde(default)]
        #[ts(optional)]
        #[ts(type = "number")]
        frame_sequence: Option<u64>,
        #[serde(default)]
        title: String,
        #[serde(default)]
        #[ts(optional)]
        image_data: Option<String>,
    },
    ObservationRename {
        record: String,
        title: String,
    },
    ObservationDelete {
        record: String,
    },
}

/// Components one snapshot returns at most unless the caller asks for fewer.
const PAGE: usize = 4096;

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
    frame: &mut vibe_logisim_runtime::simulation::Frame,
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
        "simulationStop",
        "simulationStatus",
        "simulationSnapshot",
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
            Self::SimulationAct { .. } | Self::SimulationNavigate { .. } => {
                Meta::new(Read).stage(Stage::Simulation)
            }
            Self::SimulationStop { .. } => Meta::new(Read),
            // The AI reads the run state the user asks from; it never drives it.
            Self::SimulationStatus
            | Self::SimulationSnapshot { .. }
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
                            let (artifact, view) =
                                self.snapshot_view(&document_id, &revision).await?;
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
                id,
                record,
                component_ids,
                offset,
                limit,
            } => {
                let mut record = self.observation_record(&record).await?;
                if record.document_id != id {
                    return Err("这条观察不属于当前文档".into());
                }
                page_frame(&mut record.frame, component_ids, offset, limit);
                value(record)
            }
            SimulationRequest::ObservationImage { record } => self.observation_image(&record),
            SimulationRequest::ObservationCapture {
                session_id,
                view_id,
                frame_sequence,
                title,
                image_data,
            } => {
                self.capture(&session_id, &view_id, frame_sequence, title, image_data)
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
        let (path, view) = self.snapshot_view(&id, &revision).await?;
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
        let page = self
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
            .await?;
        value(design_page(&page))
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
        let (path, view) = self.snapshot_view(&id, &revision).await?;
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

/// The worker's page of a ROM as the typed page the run's RAM uses. The
/// worker answers with its reply element holding one `<memory>` page.
fn design_page(reply: &Value) -> MemoryPage {
    let page = if reply["tag"] == "memory" {
        reply
    } else {
        reply["children"]
            .as_array()
            .and_then(|children| children.iter().find(|child| child["tag"] == "memory"))
            .unwrap_or(reply)
    };
    let words = page["children"]
        .as_array()
        .map(|children| {
            children
                .iter()
                .filter(|word| word["tag"] == "word")
                .filter_map(|word| word["attributes"]["value"].as_str()?.parse().ok())
                .collect()
        })
        .unwrap_or_default();
    let number = |name: &str| {
        page["attributes"][name]
            .as_str()
            .and_then(|text| text.parse().ok())
            .unwrap_or_default()
    };
    MemoryPage {
        component_id: page["attributes"]["componentId"]
            .as_str()
            .unwrap_or_default()
            .into(),
        offset: number("offset"),
        address_bits: number("addressBits"),
        data_bits: number("dataBits"),
        length: number("length"),
        storage: MemoryStorage::Design,
        words,
    }
}
