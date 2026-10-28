//! Simulation runs. The run is one CircuitSession process owned by a
//! [`SimulationRegistry`]; commands, frames and the run's lifetime never wait
//! on editor or verifier work.
mod error;
mod model;
mod paint;
mod protocol;
mod registry;
mod run;

pub use error::{Code, SimError};
pub use model::{
    ButtonValue, ClockState, Command, ComponentState, Control, EndReason, EndedInfo, Frame,
    FrameEvent, LiveComponent, MemoryPage, MemoryStorage, PortState, RunInfo, Signal,
    SimulationEvent, Timing, TraceDelta, TraceKey, TraceSample, TraceSignal,
};
pub use paint::{Op, PaintEvent};
pub use registry::{RunDocument, SimulationRegistry, Subscription};
