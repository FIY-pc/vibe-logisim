//! The simulation contract: requests the host accepts and what it reports back.
use super::{error::SimError, paint::PaintDelta};
use crate::runtime::RuntimeKind;
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc};
use ts_rs::TS;

/// One run of one root circuit of one document revision.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub document_id: String,
    pub document_name: String,
    pub document_path: Option<PathBuf>,
    pub revision: String,
    pub root_circuit: String,
    pub runtime: RuntimeKind,
    /// Milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub started_at: u64,
}

/// The clock and propagation as of one frame or acknowledgement.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ClockState {
    #[ts(type = "number")]
    pub ticks: u64,
    pub running: bool,
    pub automatic: bool,
    pub pending: bool,
    pub frequency: f64,
    pub actual_frequency: f64,
    pub oscillating: bool,
    /// Set when the clock stopped on a runtime failure; reset clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure: Option<SimError>,
}

/// How the user can operate a component in this run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum Control {
    Input,
    /// An input pin of a nested instance, driven by its parent circuit.
    ParentInput,
    Pulse,
    Clock,
}

/// A value as Logisim displays it: binary digits grouped by four, `x` for
/// unknown bits. `value` is present when every bit is defined.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Signal {
    pub width: u32,
    pub bits: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub value: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PortState {
    pub index: u32,
    #[serde(flatten)]
    pub signal: Signal,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ComponentState {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub control: Option<Control>,
    /// The value an input pin drives, as set by the user.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub input: Option<Signal>,
    pub ports: Vec<PortState>,
}

/// Where a memory's contents live: the design's stored words, or the run's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MemoryStorage {
    Design,
    Runtime,
}

/// One page of a memory.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPage {
    pub component_id: String,
    pub offset: u32,
    pub address_bits: u32,
    pub data_bits: u32,
    pub length: u32,
    #[serde(default = "runtime_storage")]
    pub storage: MemoryStorage,
    pub words: Vec<u32>,
}
fn runtime_storage() -> MemoryStorage {
    MemoryStorage::Runtime
}

/// Runtime cost of one frame, in milliseconds.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    pub capture_ms: f64,
    pub encode_ms: f64,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TraceSignal {
    /// `componentId:port`.
    pub id: String,
    pub component_id: String,
    pub port: u32,
    pub width: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TraceSample {
    /// Position in this waveform, counting dropped samples.
    #[ts(type = "number")]
    pub sample: u64,
    #[ts(type = "number")]
    pub tick: u64,
    /// What produced the sample: `tick`, `input`, `poke`, `step`, `reset`, …
    pub cause: String,
    /// One value per signal, in signal order.
    pub values: Vec<String>,
}

/// Waveform samples. A new `id` starts a new waveform. When `full`, `signals`
/// is set and `samples` holds every kept sample; otherwise `signals` is empty
/// and `samples` holds only those since the last delivery.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TraceDelta {
    pub id: String,
    pub recording: bool,
    /// Samples taken so far, kept or not.
    #[ts(type = "number")]
    pub total: u64,
    /// Samples no longer kept: every sample before this one.
    #[ts(type = "number")]
    pub dropped: u64,
    pub full: bool,
    pub signals: Vec<TraceSignal>,
    pub samples: Vec<TraceSample>,
}

/// One frame as the runtime produced it, numbered by the host.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    /// Strictly increasing within a session, across views.
    #[ts(type = "number")]
    pub frame_sequence: u64,
    /// The number of commands the runtime had processed.
    #[ts(type = "number")]
    pub command_sequence: u64,
    pub view_id: String,
    pub circuit: String,
    /// Subcircuit instance ids from the root circuit to this view.
    pub instance_path: Vec<String>,
    pub clock: ClockState,
    /// Unchanged components are shared with the previous frame of the view.
    pub components: Vec<Arc<ComponentState>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub memory: Option<MemoryPage>,
    pub timing: Timing,
    /// Milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub at: u64,
    #[serde(skip)]
    pub(crate) trace: TraceMark,
}

impl Frame {
    /// Keeps at most `limit` components, in order, optionally only those with
    /// an id in `ids`. Components stay shared with the frame they came from.
    pub fn page(&mut self, ids: Option<&[String]>, offset: usize, limit: usize) {
        let kept = self
            .components
            .iter()
            .filter(|component| ids.is_none_or(|ids| ids.contains(&component.id)))
            .skip(offset)
            .take(limit)
            .cloned()
            .collect();
        self.components = kept;
    }
}

/// The waveform as of one frame.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TraceMark {
    pub id: String,
    pub total: u64,
    pub recording: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ComponentDelta {
    /// `items` is every component of the view, not only the changed ones.
    pub full: bool,
    pub items: Vec<Arc<ComponentState>>,
}

/// A frame for one subscriber: components and picture changed since its last
/// delivery. `memory` is set on full deliveries and when the shown page changed.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StateEvent {
    pub session_id: String,
    pub view_id: String,
    pub circuit: String,
    pub instance_path: Vec<String>,
    #[ts(type = "number")]
    pub frame_sequence: u64,
    #[ts(type = "number")]
    pub command_sequence: u64,
    pub clock: ClockState,
    pub components: ComponentDelta,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trace: Option<TraceDelta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub memory: Option<MemoryPage>,
    pub paint: PaintDelta,
    pub timing: Timing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum EndReason {
    RevisionChanged,
    DocumentClosed,
    Stopped,
    Replaced,
    Exited,
    Failed,
    FrameError,
    Unresponsive,
}

impl EndReason {
    /// The status text for the user; endings the user caused have none.
    pub fn message(self) -> Option<&'static str> {
        match self {
            Self::RevisionChanged => Some("电路已修改，运行状态已结束。重新启动将建立全新状态。"),
            Self::Exited => Some("原生运行进程已退出，请重新启动仿真"),
            Self::Failed => Some("仿真运行出错，已停止本次仿真"),
            Self::FrameError => Some("运行画面生成失败，已停止本次仿真"),
            Self::Unresponsive => Some("运行时未在 20 秒内响应，已停止本次仿真"),
            Self::DocumentClosed | Self::Stopped | Self::Replaced => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EndedInfo {
    pub session_id: String,
    pub document_id: String,
    pub root_circuit: String,
    pub reason_code: EndReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub message: Option<String>,
    /// Milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub at: u64,
    /// Diagnostics: exit status, runtime error or the offending output line.
    #[serde(skip)]
    pub detail: Option<String>,
}

/// Events in order: a session's `session` precedes its states, and its
/// `ended` is its last event. A replaced run ends after its successor starts.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SimulationEvent {
    Session { session: SessionInfo },
    State(Box<StateEvent>),
    Ended { ended: EndedInfo },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
pub enum ButtonValue {
    #[serde(rename = "1")]
    Pressed,
    #[serde(rename = "0")]
    Released,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TraceKey {
    pub component_id: String,
    pub port: u32,
}

/// What the user asks the run to do.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    Start,
    ToggleClock,
    Play,
    Pause,
    Tick,
    Reset,
    TogglePropagation,
    Step,
    Configure {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        frequency: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        automatic: Option<bool>,
    },
    /// A click at world coordinates on an input pin or clock.
    Poke {
        component_id: String,
        x: i32,
        y: i32,
    },
    /// Bits of an input pin, most significant first: exactly its width of `0`, `1`, `x`.
    Input {
        component_id: String,
        bits: String,
    },
    Button {
        component_id: String,
        value: ButtonValue,
    },
    /// Press and release a button.
    Pulse {
        component_id: String,
    },
    Trace {
        signals: Vec<TraceKey>,
    },
    TraceStop,
    /// Show `count` words of a RAM from `offset` in later frames.
    Memory {
        component_id: String,
        offset: u32,
        count: u32,
    },
    /// Write one RAM word if it still holds `expected`; the page stays shown.
    MemoryWrite {
        component_id: String,
        offset: u32,
        count: u32,
        address: u32,
        expected: u32,
        value: u32,
    },
}

impl Command {
    /// Commands that start a run when a circuit definition is on screen.
    pub fn starts_run(&self) -> bool {
        matches!(
            self,
            Self::Start
                | Self::ToggleClock
                | Self::TogglePropagation
                | Self::Play
                | Self::Tick
                | Self::Step
                | Self::Poke { .. }
                | Self::Input { .. }
                | Self::Pulse { .. }
                | Self::Button {
                    value: ButtonValue::Pressed,
                    ..
                }
        )
    }
}

/// What a command addresses: the view of a run, or a circuit definition.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum RunTarget {
    Run { session_id: String, view_id: String },
    Definition { circuit: String },
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ActResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub view_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, as = "Option<f64>")]
    pub request_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, as = "Option<f64>")]
    pub command_sequence: Option<u64>,
    /// This command started the run.
    pub started: bool,
    /// The run received the command.
    pub applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub clock: Option<ClockState>,
    /// The frequency to pass with the next start.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub initial_frequency: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct NavigateResult {
    pub view_id: String,
    pub circuit: String,
    pub instance_path: Vec<String>,
}

/// The current view of the run and its latest clock.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RunState {
    pub view_id: String,
    pub circuit: String,
    pub instance_path: Vec<String>,
    #[ts(type = "number")]
    pub frame_sequence: u64,
    #[ts(type = "number")]
    pub command_sequence: u64,
    pub clock: ClockState,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub session: Option<SessionInfo>,
    pub state: Option<RunState>,
    pub last_ended: Option<EndedInfo>,
}

/// A kept frame of the current run, with its waveform up to that frame.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub session: SessionInfo,
    pub frame: Frame,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trace: Option<TraceDelta>,
}
