//! The documents open in the workspace: their history and snapshots, moves,
//! symbol drafts, portable packages and checks.
pub(crate) mod history;
pub(crate) mod interfaces;
pub(crate) mod movement;
pub(crate) mod project_info;
pub(crate) mod snapshots;
pub(crate) mod topology;
pub(crate) mod verification;
pub use history::{HistoryList, HistoryReview};
pub use interfaces::{InterfaceImpact, InterfacePreview, InterfaceRead};
pub use verification::{ButtonEvent, InputEvent, TestVector, TraceWatch};
