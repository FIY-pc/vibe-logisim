use crate::{Host, HostError, Result, value};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use vibe_circuit_document::DocumentView;
use vibe_logisim_runtime::simulation::{Code, ComponentState, Frame, SimError, TraceDelta};

/// A frame the user kept, frozen from the run's newest state (never resampled).
#[derive(Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ObservationRecord {
    pub id: String,
    pub document_id: String,
    pub document_name: String,
    pub document_path: Option<String>,
    pub revision: String,
    pub circuit: String,
    pub root_circuit: String,
    pub instance_path: Vec<String>,
    /// Milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub created_at: f64,
    pub title: String,
    pub signals: Vec<ObservedSignal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trace: Option<TraceDelta>,
    pub frame: Frame,
}

/// A row of the kept list; the frame and waveform are read on demand.
#[derive(Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ObservationSummary {
    pub id: String,
    pub title: String,
    #[ts(type = "number")]
    pub created_at: f64,
    pub document_path: Option<String>,
    pub root_circuit: String,
    pub instance_path: Vec<String>,
    pub circuit: String,
    pub ticks: String,
    pub signal_count: usize,
    /// Why the file could not be read; such a row can only be deleted.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub damaged: Option<String>,
}

/// A port value frozen with a kept frame.
#[derive(Serialize, Deserialize, ts_rs::TS)]
pub struct ObservedSignal {
    /// `componentId:port`.
    pub key: String,
    pub label: String,
    pub bits: String,
}

/// Named components worth freezing when the user watches nothing in particular.
const DEFAULT_SIGNALS: [&str; 5] = ["Pin", "Register", "Probe", "Clock", "Button"];
const DEFAULT_LIMIT: usize = 24;

/// The value a port shows, in the run's own notation.
fn bits(component: &ComponentState, port: u32) -> String {
    component
        .ports
        .iter()
        .find(|state| state.index == port)
        .map(|state| state.signal.bits.clone())
        .unwrap_or_else(|| "?".into())
}

/// Watched signals as the record keeps them, or the labelled components of the
/// circuit when nothing is watched.
fn signals(
    view: &DocumentView,
    circuit: &str,
    frame: &Frame,
    trace: Option<&TraceDelta>,
) -> Vec<ObservedSignal> {
    let named = |id: &str| {
        view.circuits
            .iter()
            .find(|candidate| candidate.name == circuit)
            .and_then(|graph| graph.components.iter().find(|candidate| candidate.id == id))
    };
    let mut keys: Vec<(String, u32)> = trace
        .into_iter()
        .flat_map(|trace| trace.signals.iter())
        .map(|signal| (signal.component_id.clone(), signal.port))
        .collect();
    if keys.is_empty() {
        let Some(graph) = view
            .circuits
            .iter()
            .find(|candidate| candidate.name == circuit)
        else {
            return vec![];
        };
        keys = graph
            .components
            .iter()
            .filter(|component| DEFAULT_SIGNALS.contains(&component.name.as_str()))
            .filter(|component| {
                component
                    .attributes
                    .get("label")
                    .is_some_and(|label| !label.trim().is_empty())
            })
            .filter(|component| {
                frame
                    .components
                    .iter()
                    .any(|state| state.id == component.id && !state.ports.is_empty())
            })
            .take(DEFAULT_LIMIT)
            .map(|component| (component.id.clone(), 0))
            .collect();
    }
    keys.into_iter()
        .filter_map(|(id, port)| {
            let component = named(&id)?;
            let state = frame.components.iter().find(|state| state.id == id)?;
            Some(ObservedSignal {
                key: format!("{id}:{port}"),
                label: format!(
                    "{} [{}]",
                    component
                        .attributes
                        .get("label")
                        .filter(|label| !label.is_empty())
                        .unwrap_or(&component.name),
                    port
                ),
                bits: bits(state, port),
            })
        })
        .collect()
}

/// Kept frames live beside the workspace state, named by record id; the
/// document each belongs to is in the record itself.
impl Host {
    fn observation_directory(&self) -> PathBuf {
        self.state.join("observations")
    }
    fn observation_path(&self, record: &str) -> Result<PathBuf> {
        uuid::Uuid::parse_str(record).map_err(|_| "无效观察标识")?;
        Ok(self.observation_directory().join(format!("{record}.json")))
    }
    pub(crate) async fn observation_record(&self, record: &str) -> Result<ObservationRecord> {
        let path = self.observation_path(record)?;
        serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("观察文件无法读取，原记录已保留: {e}").into())
    }
    /// Every kept file of a document, with why it failed to read when it did.
    fn observation_files(
        &self,
        id: &str,
    ) -> Result<Vec<(String, std::result::Result<ObservationRecord, String>)>> {
        let directory = self.observation_directory();
        let mut files = vec![];
        if !directory.exists() {
            return Ok(files);
        }
        for entry in std::fs::read_dir(&directory).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let stem = path
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_default();
            let record = std::fs::read(&path)
                .map_err(|e| e.to_string())
                .and_then(|bytes| {
                    serde_json::from_slice::<ObservationRecord>(&bytes).map_err(|e| e.to_string())
                });
            if let Ok(record) = &record
                && record.document_id != id
            {
                continue;
            }
            files.push((stem, record));
        }
        Ok(files)
    }
    /// The kept frames of a document, newest first.
    pub(crate) async fn observation_records(&self, id: &str) -> Result<Vec<ObservationRecord>> {
        let mut records: Vec<_> = self
            .observation_files(id)?
            .into_iter()
            .filter_map(|(_, record)| record.ok())
            .collect();
        records.sort_by(|a, b| b.created_at.total_cmp(&a.created_at));
        Ok(records)
    }
    /// Rows of the kept list; a damaged file is a row that only offers
    /// deletion instead of failing the list.
    pub(crate) async fn observations(&self, id: &str) -> Result<Value> {
        let mut rows: Vec<ObservationSummary> = self
            .observation_files(id)?
            .into_iter()
            .map(|(id, record)| match record {
                Ok(record) => ObservationSummary {
                    id: record.id,
                    title: record.title,
                    created_at: record.created_at,
                    document_path: record.document_path,
                    root_circuit: record.root_circuit,
                    instance_path: record.instance_path,
                    circuit: record.circuit,
                    ticks: record.frame.clock.ticks.to_string(),
                    signal_count: record.signals.len(),
                    damaged: None,
                },
                Err(error) => ObservationSummary {
                    id,
                    title: String::new(),
                    created_at: 0.0,
                    document_path: None,
                    root_circuit: String::new(),
                    instance_path: vec![],
                    circuit: String::new(),
                    ticks: String::new(),
                    signal_count: 0,
                    damaged: Some(format!("观察文件无法读取，原记录已保留: {error}")),
                },
            })
            .collect();
        rows.sort_by(|a, b| b.created_at.total_cmp(&a.created_at));
        value(rows)
    }
    pub(crate) fn observation_image(&self, record: &str) -> Result<Value> {
        let path = self.observation_path(record)?.with_extension("png");
        let bytes = std::fs::read(&path).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => "这条观察没有留存画面".to_string(),
            _ => error.to_string(),
        })?;
        Ok(Value::String(format!(
            "data:image/png;base64,{}",
            B64.encode(bytes)
        )))
    }
    /// Freezes the run's newest frame, the one on screen. Reads what the run
    /// already delivered: no runtime round trip.
    pub(crate) async fn capture(&self, title: String, image_data: Option<String>) -> Result<Value> {
        let image = image_data.as_deref().map(png).transpose()?;
        let (run, frame, trace) = self
            .simulation
            .frame()
            .ok_or_else(|| HostError::from(SimError::new(Code::SessionEnded)))?;
        let (_, view) = self.snapshot_view(&run.document_id, &run.revision).await?;
        let circuit = frame.circuit.clone();
        let signals = signals(&view, &circuit, &frame, Some(&trace));
        let title = if title.trim().is_empty() {
            format!("{circuit} · {} tick", frame.clock.ticks)
        } else {
            title.chars().take(160).collect()
        };
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis() as f64;
        let record = ObservationRecord {
            id: uuid::Uuid::new_v4().to_string(),
            document_id: view.id.clone(),
            document_name: view.name,
            document_path: view
                .path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            revision: view.revision,
            circuit,
            root_circuit: run.root_circuit,
            instance_path: frame.instance_path.clone(),
            created_at,
            title,
            signals,
            trace: Some(trace),
            frame,
        };
        let directory = self.observation_directory();
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        persist(&directory, &format!("{}.json", record.id), |file| {
            serde_json::to_writer(file, &record)
                .map_err(|e| e.to_string())
                .map_err(Into::into)
        })?;
        if let Some(image) = image {
            persist(&directory, &format!("{}.png", record.id), |file| {
                file.write_all(&image)
                    .map_err(|e| e.to_string())
                    .map_err(Into::into)
            })?;
        }
        value(record)
    }
    pub(crate) fn delete_observation(&self, record: &str) -> Result<Value> {
        let path = self.observation_path(record)?;
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(path.with_extension("png"));
        Ok(Value::Null)
    }
    pub(crate) fn rename_observation(&self, record: &str, title: &str) -> Result<Value> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 160 {
            return Err("观察名称应为 1–160 个字符".into());
        }
        let path = self.observation_path(record)?;
        let mut value: ObservationRecord =
            serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if value.id != record {
            return Err("观察标识不匹配".into());
        }
        value.title = title.into();
        let directory = path.parent().ok_or("无效观察路径")?;
        persist(directory, &format!("{record}.json"), |file| {
            serde_json::to_writer(file, &value)
                .map_err(|e| e.to_string())
                .map_err(Into::into)
        })?;
        crate::value(value)
    }
}

/// The largest picture a kept frame takes.
const IMAGE_BYTES: usize = 8 << 20;

/// The PNG of a `data:image/png;base64,` URL from the window.
fn png(data: &str) -> Result<Vec<u8>> {
    let data = data.strip_prefix("data:image/png;base64,").unwrap_or(data);
    if data.len() > IMAGE_BYTES.div_ceil(3) * 4 {
        return Err("留存画面超过 8 MB".into());
    }
    let bytes = B64.decode(data).map_err(|_| "留存画面无效")?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("留存画面不是 PNG".into());
    }
    Ok(bytes)
}

/// Writes a kept file whole or not at all.
fn persist(
    directory: &Path,
    name: &str,
    write: impl FnOnce(&mut std::fs::File) -> Result<()>,
) -> Result<()> {
    let mut temp = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    write(temp.as_file_mut())?;
    temp.flush().map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(directory.join(name))
        .map_err(|e| e.to_string())?;
    Ok(())
}
