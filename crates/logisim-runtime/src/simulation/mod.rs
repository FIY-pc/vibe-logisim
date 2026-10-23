//! Simulation runs. Each run is one CircuitSession process owned by a
//! [`SimulationRegistry`]; commands, frames and the run's lifetime never wait
//! on editor or verifier work.
mod error;
mod model;
mod protocol;
mod registry;
mod session;

pub use error::{Code, SimError};
pub use model::{
    ActResult, Bounds, ButtonValue, ClockState, Command, ComponentDelta, ComponentState, Control,
    EndReason, EndedInfo, Frame, FrameImage, MemoryPage, MemoryStorage, NavigateResult, PortState,
    RunState, RunTarget, SessionInfo, Signal, SimulationEvent, Snapshot, StateEvent, Status,
    Timing, TraceDelta, TraceKey, TraceSample, TraceSignal,
};
pub use registry::{RunDocument, SimulationRegistry, Subscription, Target};
