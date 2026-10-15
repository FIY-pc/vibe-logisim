use crate::{Host, Result, value};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::Write,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use vibe_workspace_core::DocumentView;

#[derive(Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ObservationRecord {
    pub id: String,
    pub document_id: String,
    pub document_name: String,
    pub revision: String,
    pub circuit: String,
    pub root_circuit: String,
    pub instance_path: Vec<String>,
    pub view_id: String,
    pub created_at: f64,
    pub title: String,
    pub signals: Vec<Signal>,
    pub frame: Value,
}
#[derive(Serialize, Deserialize, ts_rs::TS)]
pub struct Signal {
    pub key: String,
    pub label: String,
    pub bits: String,
}
impl Host {
    fn observation_directory(&self, id: &str) -> Result<PathBuf> {
        uuid::Uuid::parse_str(id).map_err(|_| "无效文档标识")?;
        Ok(self.state.join("observations").join(id))
    }
    pub(crate) async fn observations(&self, id: &str) -> Result<Value> {
        let directory = self.observation_directory(id)?;
        if !directory.exists() {
            return Ok(json!([]));
        }
        let mut result = vec![];
        for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().is_some_and(|s| s == "json") {
                let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
                let record: ObservationRecord = serde_json::from_slice(&bytes)
                    .map_err(|e| format!("留存观察无法读取，原记录已保留: {e}"))?;
                result.push(record);
            }
        }
        result.sort_by(|a, b| b.created_at.total_cmp(&a.created_at));
        value(result)
    }
    pub(crate) async fn capture(
        &self,
        view: DocumentView,
        view_id: &str,
        title: String,
    ) -> Result<Value> {
        let mut native = self.native.lock().await;
        let sim = native.simulation.as_mut().ok_or("请先启动仿真")?;
        let scope = sim.state();
        if sim.document_id != view.id || sim.revision != view.revision || scope["viewId"] != view_id
        {
            return Err("仿真视图已改变，请重新留存".into());
        }
        let mut state = sim.sample().await?;
        drop(native);
        let circuit = state["circuit"].as_str().ok_or("无效仿真视图")?.to_string();
        let graph = view
            .circuits
            .iter()
            .find(|c| c.name == circuit)
            .ok_or("找不到电路")?;
        let children = state["frame"]["children"]
            .as_array_mut()
            .ok_or("无法读取仿真")?;
        let trace = children
            .iter()
            .find(|n| n["tag"] == "trace")
            .cloned()
            .unwrap_or(Value::Null);
        let mut watched: Vec<String> = trace["children"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|n| n["tag"] == "signal")
            .filter_map(|n| n["attributes"]["key"].as_str().map(str::to_owned))
            .collect();
        if watched.is_empty() {
            watched = graph
                .components
                .iter()
                .filter(|c| {
                    matches!(
                        c.name.as_str(),
                        "Pin" | "Register" | "Probe" | "Clock" | "Button"
                    )
                })
                .filter(|c| {
                    c.attributes
                        .get("label")
                        .is_some_and(|label| !label.trim().is_empty())
                })
                .filter(|c| {
                    children.iter().any(|n| {
                        n["tag"] == "component"
                            && n["attributes"]["id"] == c.id
                            && n["children"].as_array().is_some_and(|ports| {
                                ports
                                    .iter()
                                    .any(|p| p["tag"] == "port" && p["attributes"]["index"] == "0")
                            })
                    })
                })
                .take(24)
                .map(|c| format!("{}:0", c.id))
                .collect();
        }
        let mut signals = vec![];
        for key in watched {
            let (id, port) = key.split_once(':').ok_or("无效信号")?;
            let component = graph
                .components
                .iter()
                .find(|c| c.id == id)
                .ok_or("信号已改变")?;
            let node = children
                .iter()
                .find(|n| n["tag"] == "component" && n["attributes"]["id"] == id)
                .and_then(|n| n["children"].as_array())
                .and_then(|nodes| {
                    nodes
                        .iter()
                        .find(|n| n["tag"] == "port" && n["attributes"]["index"] == port)
                })
                .ok_or("无法读取观察的信号")?;
            signals.push(Signal {
                key: key.clone(),
                label: format!(
                    "{} [{}]",
                    component
                        .attributes
                        .get("label")
                        .filter(|s| !s.is_empty())
                        .unwrap_or(&component.name),
                    port
                ),
                bits: node["attributes"]["bits"].as_str().unwrap_or("?").into(),
            });
        }
        // Retain the sampled ports as frozen evidence. The summary follows explicit
        // watches exactly, or named signals when no watches have been selected.
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis() as f64;
        let title = if title.trim().is_empty() {
            format!(
                "{circuit} · {} tick",
                state["frame"]["attributes"]["ticks"]
                    .as_str()
                    .unwrap_or("0")
            )
        } else {
            title.chars().take(160).collect()
        };
        let record = ObservationRecord {
            id: uuid::Uuid::new_v4().to_string(),
            document_id: view.id.clone(),
            document_name: view.name,
            revision: view.revision,
            circuit,
            root_circuit: state["rootCircuit"].as_str().unwrap_or_default().into(),
            instance_path: serde_json::from_value(state["instancePath"].clone())
                .map_err(|e| e.to_string())?,
            view_id: view_id.into(),
            created_at,
            title,
            signals,
            frame: state["frame"].clone(),
        };
        let directory = self.observation_directory(&view.id)?;
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let mut temp = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
        serde_json::to_writer(temp.as_file_mut(), &record).map_err(|e| e.to_string())?;
        temp.flush().map_err(|e| e.to_string())?;
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        temp.persist_noclobber(directory.join(format!("{}.json", record.id)))
            .map_err(|e| e.to_string())?;
        value(record)
    }
    pub(crate) fn delete_observation(&self, id: &str, record: &str) -> Result<Value> {
        uuid::Uuid::parse_str(record).map_err(|_| "无效观察标识")?;
        std::fs::remove_file(
            self.observation_directory(id)?
                .join(format!("{record}.json")),
        )
        .map_err(|e| e.to_string())?;
        Ok(Value::Null)
    }
    pub(crate) fn rename_observation(&self, id: &str, record: &str, title: &str) -> Result<Value> {
        uuid::Uuid::parse_str(record).map_err(|_| "无效观察标识")?;
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 160 {
            return Err("观察名称应为 1–160 个字符".into());
        }
        let directory = self.observation_directory(id)?;
        let path = directory.join(format!("{record}.json"));
        let mut value: ObservationRecord =
            serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if value.document_id != id || value.id != record {
            return Err("观察标识不匹配".into());
        }
        value.title = title.into();
        let mut temp = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
        serde_json::to_writer(temp.as_file_mut(), &value).map_err(|e| e.to_string())?;
        temp.flush().map_err(|e| e.to_string())?;
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        temp.persist(&path).map_err(|e| e.to_string())?;
        crate::value(value)
    }
}
