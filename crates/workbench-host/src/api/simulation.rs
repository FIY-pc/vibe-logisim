use super::{Effect::*, Meta};
use crate::{Host, Result, app::diagnostics::Stage, documents::history::Action, value};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use vibe_circuit_document::Edit;
use vibe_logisim_runtime::simulation::{Command, MemoryPage, MemoryStorage, RunDocument};

/// The interactive run and the frames kept from it.
///
/// There is at most one run. The window drives it with `simulationStart`,
/// `simulationCommand`, `simulationNavigate` and `simulationStop`, all
/// addressed to the run there is, and follows it through `simulation` events:
/// every subscription starts with the run's whole state (`run`, then a full
/// `frame`), then gets each frame with what changed, then `ended`. Replies
/// never carry run state. None of these requests changes a document:
/// stimulus never makes a revision and never saves. Only `memoryWrite`,
/// which edits a ROM's stored contents, does.
///
/// The agent reads frames the user kept (`observationList`, `observationGet`,
/// `observationImage`); it never drives the run. Its vector and trace tools
/// are the `simulate` and `trace` review requests, which run in a separate
/// process and never touch the run.
#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SimulationRequest {
    /// Ends the current run and starts one of `circuit` at `revision`, its
    /// clock at `frequency` (2 Hz otherwise). Returns the `RunInfo` once the
    /// run showed its first frame.
    SimulationStart {
        document_id: String,
        revision: String,
        circuit: String,
        #[serde(default)]
        #[ts(optional)]
        frequency: Option<f64>,
    },
    /// Sends a command to the run. Returns `{commandSequence}`: a frame with
    /// at least that sequence shows its effect.
    SimulationCommand {
        command: Command,
    },
    /// Shows a subcircuit instance of the run, keeping its state: the path
    /// holds component ids from the root circuit, and an empty path returns
    /// to the root. Releases held buttons, clears the waveform and the shown
    /// memory page; the next frame is whole. Returns `{commandSequence}`.
    SimulationNavigate {
        instance_path: Vec<String>,
    },
    /// Ends the run. Returns `{"stopped": false}` when there was none.
    SimulationStop,
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
    /// states, paged by `componentIds`, `offset` and `limit` (at most 4096).
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
    /// Keeps the run's newest frame with its waveform, read from what the run
    /// already delivered, never from the runtime. `imageData` is the picture
    /// the window showed, a PNG data URL of at most 8 MB, kept beside the
    /// record.
    ObservationCapture {
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

/// Components one kept frame returns at most unless the caller asks for fewer.
const PAGE: usize = 4096;

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
        "simulationStart",
        "simulationCommand",
        "simulationNavigate",
        "simulationStop",
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
            Self::SimulationStart { .. }
            | Self::SimulationCommand { .. }
            | Self::SimulationNavigate { .. } => Meta::new(Read).stage(Stage::Simulation),
            Self::SimulationStop => Meta::new(Read),
            Self::ObservationList { .. }
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
            SimulationRequest::SimulationStart {
                document_id,
                revision,
                circuit,
                frequency,
            } => {
                let (revision, view) = self.revision_view(&document_id, &revision).await?;
                let document = RunDocument { revision, view };
                value(self.simulation.start(document, &circuit, frequency).await?)
            }
            SimulationRequest::SimulationCommand { command } => {
                let sequence = self.simulation.command(command).await?;
                value(json!({"commandSequence": sequence}))
            }
            SimulationRequest::SimulationNavigate { instance_path } => {
                let sequence = self.simulation.navigate(instance_path).await?;
                value(json!({"commandSequence": sequence}))
            }
            SimulationRequest::SimulationStop => value(json!({"stopped": self.simulation.stop()})),
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
            SimulationRequest::ObservationCapture { title, image_data } => {
                self.capture(title, image_data).await
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
        let (snapshot, view) = self.revision_circuit(&id, &revision, &circuit).await?;
        view.as_ref()
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
                &snapshot,
                &circuit,
                &component,
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
        let (snapshot, view) = self.revision_circuit(&id, &revision, &circuit).await?;
        view.as_ref()
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
                &snapshot,
                &circuit,
                &component,
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
