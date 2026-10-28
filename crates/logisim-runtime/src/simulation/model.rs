//! The simulation contract: requests the host accepts and what it reports back.
use super::{error::SimError, paint::PaintEvent};
use crate::runtime::RuntimeKind;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};
use ts_rs::TS;

/// The run: one root circuit of one document revision.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
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

/// The clock and propagation as of one frame.
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

/// A component as frames carry it. Values are Logisim's binary text without
/// spaces, most significant bit first: `0`, `1`, `x` unknown, `E` error, and
/// `-` for a port without width.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LiveComponent {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub control: Option<Control>,
    /// The value an input pin drives, as set by the user.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub input: Option<String>,
    /// One value per port, in port order.
    pub ports: Vec<String>,
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

impl Signal {
    /// The long form of a frame value.
    pub fn of(bits: &str) -> Self {
        if bits == "-" {
            return Self {
                width: 0,
                bits: bits.into(),
                value: None,
            };
        }
        let width = bits.chars().count();
        let mut grouped = String::with_capacity(width + width / 4);
        for (index, bit) in bits.chars().enumerate() {
            if index > 0 && (width - index).is_multiple_of(4) {
                grouped.push(' ');
            }
            grouped.push(bit);
        }
        let value = (width <= 32 && bits.bytes().all(|bit| bit == b'0' || bit == b'1'))
            .then(|| u32::from_str_radix(bits, 2).ok())
            .flatten();
        Self {
            width: width as u32,
            bits: grouped,
            value,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PortState {
    pub index: u32,
    #[serde(flatten)]
    pub signal: Signal,
}

/// A component in Logisim's long form, as a kept observation stores it.
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

impl ComponentState {
    pub fn of(id: &str, live: &LiveComponent) -> Self {
        Self {
            id: id.into(),
            control: live.control,
            input: live.input.as_deref().map(Signal::of),
            ports: (0..)
                .zip(&live.ports)
                .map(|(index, bits)| PortState {
                    index,
                    signal: Signal::of(bits),
                })
                .collect(),
        }
    }
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
#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize, Serialize, TS)]
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
/// and `samples` holds only those taken since the previous frame.
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

/// One frame of the run. A `full` frame carries the whole state of the shown
/// instance (the first frame of the run and of every instance shown, and the
/// first frame a subscription gets); otherwise each part carries only what
/// changed since the previous frame: components, the memory page and the
/// waveform when they changed, and the picture's changes.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FrameEvent {
    pub full: bool,
    pub circuit: String,
    /// Subcircuit instance ids from the root circuit to the shown instance.
    pub instance_path: Vec<String>,
    /// The number of commands the runtime had taken.
    #[ts(type = "number")]
    pub command_sequence: u64,
    pub clock: ClockState,
    pub components: BTreeMap<String, LiveComponent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub memory: Option<MemoryPage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trace: Option<TraceDelta>,
    pub paint: PaintEvent,
    pub timing: Timing,
}

/// The run's newest state in Logisim's long form, as a kept observation stores it.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    /// The number of commands the runtime had taken.
    #[ts(type = "number")]
    pub command_sequence: u64,
    pub circuit: String,
    /// Subcircuit instance ids from the root circuit to the shown instance.
    pub instance_path: Vec<String>,
    pub clock: ClockState,
    pub components: Vec<ComponentState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub memory: Option<MemoryPage>,
    pub timing: Timing,
    /// Milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub at: u64,
}

impl Frame {
    /// Keeps at most `limit` components, in order, optionally only those with
    /// an id in `ids`.
    pub fn page(&mut self, ids: Option<&[String]>, offset: usize, limit: usize) {
        let components = std::mem::take(&mut self.components);
        self.components = components
            .into_iter()
            .filter(|component| ids.is_none_or(|ids| ids.contains(&component.id)))
            .skip(offset)
            .take(limit)
            .collect();
    }
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

/// Events in order: `run` starts a run, its frames follow, and `ended` is its
/// last event. A subscription starts with the current run and a full frame
/// (or how the last run ended when none is running).
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SimulationEvent {
    Run { run: RunInfo },
    Frame(Box<FrameEvent>),
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

/// What the user asks the run to do. Component ids are those of the shown
/// instance.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    /// Pauses a running clock, or runs a paused one, as the run is now.
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
    /// Releasing a button that is not held does nothing.
    Button {
        component_id: String,
        value: ButtonValue,
    },
    /// Press and release a button.
    Pulse {
        component_id: String,
    },
    /// Records these signals from now on; an empty list records nothing.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_values_read_in_the_long_form() {
        assert_eq!(
            Signal::of("00001x1x"),
            Signal {
                width: 8,
                bits: "0000 1x1x".into(),
                value: None
            }
        );
        assert_eq!(Signal::of("110011").bits, "11 0011");
        assert_eq!(Signal::of("110011").value, Some(51));
        assert_eq!(Signal::of("1").value, Some(1));
        assert_eq!(Signal::of("-").width, 0);
        assert_eq!(Signal::of(&"1".repeat(32)).value, Some(u32::MAX));
    }
}
