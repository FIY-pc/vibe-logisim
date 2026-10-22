//! One failure shape for every host request, on every transport.
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Machine-readable failure classes. Append only: the UI, the AI runtime and
/// model tool results branch on these names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    // Documents
    InvalidDocument,
    InvalidCommand,
    StaleRevision,
    ExternalChange,
    Io,
    DocumentNotFound,
    // Editing
    StaleObject,
    AmbiguousObject,
    InvalidPath,
    OutOfBounds,
    Overlap,
    Obstructed,
    ShortCircuit,
    ConnectionChanged,
    WidthMismatch,
    InterfaceChanged,
    NativeUnavailable,
    NativeRejected,
    InvalidValue,
    CircuitRule,
    TooLarge,
    AmbiguousCrossing,
    // Folders and files
    NoFolder,
    FolderChanged,
    FileNotFound,
    NotCircuit,
    NameInvalid,
    NameExists,
    NoPermission,
    SourceRedirected,
    AiTurnActive,
    StaleWorkspace,
    TurnActive,
    TurnNotActive,
    ConfirmRequired,
    // AI runtime
    AgentOpUnknown,
    StaleWorkspaceContext,
    WorkspaceNotOpen,
    LoadFailed,
    ContextTooLarge,
    ToolRejected,
    ToolFailed,
    CircuitToolFailed,
    NoCircuitOpen,
    // Simulation
    InputNotOperable,
    InputOutside,
    InputFormat,
    Oscillating,
    FrequencyRange,
    NotRam,
    RamNeedsRun,
    MemoryAddress,
    MemoryWidth,
    MemoryWordChanged,
    RomIsolate,
    TracePort,
    TraceLimit,
    TraceChanged,
    ViewportBudget,
    InstanceNotReady,
    PathTooDeep,
    NotSubcircuit,
    DuplicateId,
    ComponentAmbiguous,
    ComponentMissing,
    ParentInput,
    ViewChanged,
    UnknownCircuit,
    SessionEnded,
    StartTimeout,
    StartFailed,
    Unresponsive,
    ClockFailure,
    FrameEvicted,
    // General
    InvalidInput,
    NotAllowed,
    RecoveryFailed,
    RuntimeUnavailable,
    ProcessExit,
    Timeout,
    DependencyChanged,
    Unavailable,
    Internal,
    Unknown,
}

/// A failed request. `message` is the user-facing text; `hint` says how to
/// correct the request; `retryable` means repeating the unchanged request may
/// succeed; `context` carries machine data such as positions or object ids.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, ts_rs::TS)]
pub struct HostError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hint: Option<String>,
    #[serde(default)]
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub context: Option<Value>,
}

impl HostError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            hint: None,
            retryable: matches!(code, ErrorCode::Timeout | ErrorCode::ProcessExit),
            context: None,
        }
    }
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
    pub fn with_context(mut self, context: Value) -> Self {
        self.context = Some(context);
        self
    }
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for HostError {}

impl From<vibe_logisim_adapter::simulation::Code> for ErrorCode {
    fn from(code: vibe_logisim_adapter::simulation::Code) -> Self {
        use vibe_logisim_adapter::simulation::Code as C;
        match code {
            C::InputNotOperable => Self::InputNotOperable,
            C::InputOutside => Self::InputOutside,
            C::InputFormat => Self::InputFormat,
            C::Oscillating => Self::Oscillating,
            C::FrequencyRange => Self::FrequencyRange,
            C::NotRam => Self::NotRam,
            C::RamNeedsRun => Self::RamNeedsRun,
            C::MemoryAddress => Self::MemoryAddress,
            C::MemoryWidth => Self::MemoryWidth,
            C::MemoryWordChanged => Self::MemoryWordChanged,
            C::RomIsolate => Self::RomIsolate,
            C::TracePort => Self::TracePort,
            C::TraceLimit => Self::TraceLimit,
            C::TraceChanged => Self::TraceChanged,
            C::ViewportBudget => Self::ViewportBudget,
            C::InstanceNotReady => Self::InstanceNotReady,
            C::PathTooDeep => Self::PathTooDeep,
            C::NotSubcircuit => Self::NotSubcircuit,
            C::DuplicateId => Self::DuplicateId,
            C::ComponentAmbiguous => Self::ComponentAmbiguous,
            C::ComponentMissing => Self::ComponentMissing,
            C::ParentInput => Self::ParentInput,
            C::ViewChanged => Self::ViewChanged,
            C::UnknownCircuit => Self::UnknownCircuit,
            C::SessionEnded => Self::SessionEnded,
            C::StartTimeout => Self::StartTimeout,
            C::StartFailed => Self::StartFailed,
            C::RuntimeUnavailable => Self::RuntimeUnavailable,
            C::Unresponsive => Self::Unresponsive,
            C::ClockFailure => Self::ClockFailure,
            C::FrameEvicted => Self::FrameEvicted,
            C::Internal => Self::Internal,
        }
    }
}

impl From<vibe_logisim_adapter::simulation::SimError> for HostError {
    fn from(error: vibe_logisim_adapter::simulation::SimError) -> Self {
        Self::new(error.code.into(), error.message)
    }
}

impl From<vibe_workspace_core::Error> for HostError {
    fn from(error: vibe_workspace_core::Error) -> Self {
        use vibe_workspace_core::Error as E;
        let code = match &error {
            E::InvalidDocument(_) => ErrorCode::InvalidDocument,
            E::InvalidCommand(_) => ErrorCode::InvalidCommand,
            E::StaleRevision => ErrorCode::StaleRevision,
            E::ExternalChange => ErrorCode::ExternalChange,
            E::Io(_) => ErrorCode::Io,
            E::DocumentNotFound => ErrorCode::DocumentNotFound,
        };
        Self::new(code, error.to_string())
    }
}

impl From<std::io::Error> for HostError {
    fn from(error: std::io::Error) -> Self {
        Self::new(ErrorCode::Io, error.to_string())
    }
}

/// Text errors from code that has not been given codes yet. The fixed document
/// texts map exactly; the rest fall into the diagnostics buckets.
impl From<String> for HostError {
    fn from(message: String) -> Self {
        use crate::diagnostics::Failure;
        let code = match message.as_str() {
            "电路已改变，请重新读取后再修改" => ErrorCode::StaleRevision,
            "源文件已被其他程序修改，请先重新载入或另存为" => {
                ErrorCode::ExternalChange
            }
            "找不到文档" => ErrorCode::DocumentNotFound,
            text => match crate::diagnostics::classify(text) {
                Failure::Timeout => ErrorCode::Timeout,
                Failure::ProcessExit => ErrorCode::ProcessExit,
                Failure::RuntimeUnavailable => ErrorCode::RuntimeUnavailable,
                Failure::Dependency => ErrorCode::DependencyChanged,
                Failure::SourceChanged => ErrorCode::StaleRevision,
                Failure::InvalidInput => ErrorCode::InvalidInput,
                Failure::Storage => ErrorCode::Io,
                Failure::Unavailable => ErrorCode::Unknown,
            },
        };
        Self::new(code, message)
    }
}

impl From<&str> for HostError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wire_shape_is_stable() {
        let error = HostError::new(ErrorCode::StaleRevision, "电路已改变，请重新读取后再修改");
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({"code":"STALE_REVISION","message":"电路已改变，请重新读取后再修改","retryable":false})
        );
        assert_eq!(
            serde_json::to_value(ErrorCode::AiTurnActive).unwrap(),
            "AI_TURN_ACTIVE"
        );
        assert_eq!(serde_json::to_value(ErrorCode::Io).unwrap(), "IO");
    }
    #[test]
    fn text_errors_keep_their_message() {
        let stale = HostError::from(vibe_workspace_core::Error::StaleRevision.to_string());
        assert_eq!(stale.code, ErrorCode::StaleRevision);
        let exited = HostError::from("Logisim 启动握手前退出");
        assert_eq!(exited.code, ErrorCode::ProcessExit);
        assert!(exited.retryable);
        assert_eq!(exited.message, "Logisim 启动握手前退出");
        assert_eq!(HostError::from("请先打开电路").code, ErrorCode::Unknown);
    }
}
