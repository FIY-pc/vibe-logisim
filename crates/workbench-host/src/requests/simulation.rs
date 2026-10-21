use super::{Effect::*, Meta};
use crate::{Host, Result, diagnostics::Stage, document_history::Action, value};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use vibe_workspace_core::Edit;

#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum SimulationRequest {
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
}

impl SimulationRequest {
    pub(crate) const OPS: &[&str] = &[
        "simulationStart",
        "simulationAction",
        "simulationStatus",
        "simulationStop",
        "simulationView",
        "simulationCommand",
        "memory",
        "memoryWrite",
        "observations",
        "observationCapture",
        "observationRename",
        "observationDelete",
    ];
    pub(crate) fn meta(&self) -> Meta {
        match self {
            Self::SimulationStart { .. }
            | Self::SimulationAction { .. }
            | Self::SimulationView { .. }
            | Self::SimulationCommand { .. } => Meta::new(Read).stage(Stage::Simulation),
            Self::SimulationStatus
            | Self::SimulationStop
            | Self::ObservationCapture { .. }
            | Self::ObservationRename { .. }
            | Self::ObservationDelete { .. } => Meta::new(Read),
            Self::Memory { .. } => Meta::new(Read).stage(Stage::Library),
            Self::MemoryWrite { id, .. } => Meta::new(AutoSave)
                .stage(Stage::Edit)
                .history(Action::document("memory", "修改存储器内容", id)),
            Self::Observations { .. } => Meta::new(Read).agent(),
        }
    }
}

impl Host {
    pub(crate) async fn simulation_request(&self, request: SimulationRequest) -> Result<Value> {
        match request {
            SimulationRequest::Memory {
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
                Ok(self
                    .native
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
                    .await?)
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
            SimulationRequest::Observations { id } => self.observations(&id).await,
            SimulationRequest::ObservationCapture {
                id,
                revision,
                view_id,
                title,
            } => {
                let view = {
                    let workspace = self.workspace.lock().await;
                    let document = workspace.get(&id)?;
                    document.check(&revision)?;
                    document.view()?
                };
                self.capture(view, &view_id, title).await
            }
            SimulationRequest::ObservationRename { id, record, title } => {
                self.rename_observation(&id, &record, &title)
            }
            SimulationRequest::ObservationDelete { id, record } => {
                self.delete_observation(&id, &record)
            }
            SimulationRequest::SimulationStart {
                id,
                revision,
                circuit,
            } => {
                let (p, v) = self.snapshot(&id, &revision).await?;
                Ok(self
                    .native
                    .lock()
                    .await
                    .start_simulation(&p, &v, &circuit)
                    .await?)
            }
            SimulationRequest::SimulationAction {
                id,
                revision,
                circuit,
                command,
                mut attributes,
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
                        return Ok(sim.command("button", attrs).await?);
                    }
                    return Ok(Value::Null);
                }
                let initial_frequency = attributes.remove("initialFrequency");
                if let Some(value) = &initial_frequency {
                    let rate: f64 = value.parse().map_err(|_| "无效时钟频率")?;
                    if !rate.is_finite() || !(0.25..=4096.0).contains(&rate) {
                        return Err("时钟频率应在 0.25–4096 tick/s 之间".into());
                    }
                }
                let (path, view) = self.snapshot(&id, &revision).await?;
                let mut native = self.native.lock().await;
                let was_active = native.simulation.as_ref().is_some_and(|s| {
                    s.document_id == id
                        && s.revision == revision
                        && s.circuit == circuit
                        && !s.failed()
                });
                if !was_active {
                    native.start_simulation(&path, &view, &circuit).await?;
                }
                let simulation = native.simulation.as_mut().unwrap();
                if !was_active && let Some(frequency) = initial_frequency {
                    simulation
                        .command(
                            "configure",
                            BTreeMap::from([("frequency".into(), frequency)]),
                        )
                        .await?;
                }
                // Resolve toggles against an acknowledged native frame under the same
                // lock as session selection. Rapid commands must not reuse a stale UI frame.
                if command == "toggle-clock" || command == "toggle-propagation" {
                    let frame = simulation.sample().await?;
                    if command == "toggle-clock" {
                        let action = if frame["frame"]["attributes"]["running"] == "true" {
                            "pause"
                        } else {
                            "play"
                        };
                        simulation.command(action, attributes).await?;
                    } else if was_active {
                        attributes.insert(
                            "automatic".into(),
                            (frame["frame"]["attributes"]["automatic"] == "false").to_string(),
                        );
                        simulation.command("configure", attributes).await?;
                    }
                    Ok(simulation.sample().await?)
                } else if command == "start" {
                    Ok(simulation.state())
                } else {
                    Ok(simulation.command(&command, attributes).await?)
                }
            }
            SimulationRequest::SimulationView { id, revision, path } => {
                let view = {
                    let w = self.workspace.lock().await;
                    let d = w.get(&id)?;
                    d.check(&revision)?;
                    d.view()?
                };
                let mut native = self.native.lock().await;
                let sim = native.simulation.as_mut().ok_or("请先启动仿真")?;
                if sim.document_id != id || sim.revision != revision {
                    return Err("仿真版本已改变".into());
                }
                Ok(sim.navigate(&view, path).await?)
            }
            SimulationRequest::SimulationStatus => Ok(self
                .native
                .lock()
                .await
                .simulation
                .as_ref()
                .map(|s| s.state())
                .unwrap_or(Value::Null)),
            SimulationRequest::SimulationStop => {
                self.native.lock().await.stop_simulation().await;
                Ok(Value::Null)
            }
            SimulationRequest::SimulationCommand {
                id,
                revision,
                command,
                attributes,
            } => {
                self.workspace.lock().await.get(&id)?.check(&revision)?;
                let mut native = self.native.lock().await;
                let sim = native.simulation.as_mut().ok_or("请先启动仿真")?;
                if sim.document_id != id || sim.revision != revision {
                    return Err("仿真对应的电路已改变，请重新启动".into());
                }
                Ok(sim.command(&command, attributes).await?)
            }
        }
    }
}
