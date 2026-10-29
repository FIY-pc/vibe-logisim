//! The documents open in the workspace: their history, moves, symbol
//! drafts, portable packages and checks.
pub(crate) mod files;
pub(crate) mod history;
pub(crate) mod interfaces;
pub(crate) mod movement;
pub(crate) mod project_info;
pub(crate) mod verification;
pub use files::{SourceChange, WorkspaceChange};
pub use history::{HistoryList, HistoryReview};
pub use interfaces::{InterfaceImpact, InterfacePreview, InterfaceRead};
pub use verification::{ButtonEvent, InputEvent, TestVector, TraceWatch};
