//! Stable failure codes for simulation requests and the user-facing text for each.
use serde::{Deserialize, Serialize};

/// The names equal the host's error codes, so a code passes through unchanged.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Code {
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
    RuntimeUnavailable,
    Unresponsive,
    ClockFailure,
    FrameEvicted,
    Internal,
}

impl Code {
    pub fn message(self) -> &'static str {
        match self {
            Self::InputNotOperable => "请选择这次运行中的可操作输入",
            Self::InputOutside => "请点在输入元件上",
            Self::InputFormat => {
                "请输入位宽内的整数（支持 0x / 0b）；三态输入也支持 x 或等位宽的 0b10x…"
            }
            Self::Oscillating => "电路出现振荡，无法继续运行；请检查反馈回路",
            Self::FrequencyRange => "时钟频率范围为 0.25–4096 tick/s",
            Self::NotRam => "请选择运行实例中的 RAM",
            Self::RamNeedsRun => "RAM 的内容只在仿真运行中存在，请先开始仿真",
            Self::MemoryAddress => "地址超出存储器范围",
            Self::MemoryWidth => "数值超出存储器字宽",
            Self::MemoryWordChanged => "这个存储单元已被修改，请刷新后重试",
            Self::RomIsolate => "这个 ROM 的内容被多处共用，请在原文件中修改",
            Self::TracePort => "这个端口不能加入波形",
            Self::TraceLimit => "波形最多 32 个信号",
            Self::TraceChanged => "波形信号已变化，请重新选择",
            Self::ViewportBudget => "运行画面未能调整到当前视野",
            Self::InstanceNotReady => "子电路实例还没有运行状态，请稍后重试",
            Self::PathTooDeep => "子电路层级过深",
            Self::NotSubcircuit => "这不是子电路实例",
            Self::DuplicateId => "电路中有重复的元件标识，无法定位实例",
            Self::ComponentAmbiguous => "元件定位有歧义，请删除或移开重复元件后重试",
            Self::ComponentMissing => "找不到元件",
            Self::ParentInput => "此输入由父电路驱动，请返回父图调整",
            Self::ViewChanged => "运行视图已切换，请重新选择对象",
            Self::UnknownCircuit => "电路不存在",
            Self::SessionEnded => "这次运行已经结束，请重新启动仿真",
            Self::StartTimeout => "仿真启动超时，请重试",
            Self::StartFailed => "仿真未能启动；详情已记入诊断",
            Self::RuntimeUnavailable => "尚未安装 Logisim 兼容运行时",
            Self::Unresponsive => "运行时未在 20 秒内响应，已停止本次仿真",
            Self::ClockFailure => "仿真运行出错，时钟已暂停；可复位或重新仿真",
            Self::FrameEvicted => "这一帧已离开缓存，请暂停后重新留存",
            Self::Internal => "仿真操作失败，请重试；详情已记入诊断",
        }
    }
    /// The code with this protocol name, if it is one.
    pub fn parse(name: &str) -> Option<Self> {
        serde_json::from_value(serde_json::Value::String(name.into())).ok()
    }
}

/// A simulation failure: a stable code, the text to show, and diagnostics
/// that never reach the user interface.
#[derive(Clone, Debug, PartialEq, Serialize, ts_rs::TS)]
pub struct SimError {
    pub code: Code,
    pub message: String,
    #[serde(skip)]
    detail: Option<String>,
}

impl SimError {
    pub fn new(code: Code) -> Self {
        Self {
            code,
            message: code.message().into(),
            detail: None,
        }
    }
    pub fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = message.into();
        self
    }
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
    /// Diagnostics for logs: raw runtime text, exit status or the offending line.
    pub fn detail(&self) -> Option<&str> {
        self.detail.as_deref()
    }
    /// A failure reported by the runtime. Known codes get their own text, except
    /// the component lookups, whose runtime text names the location. Anything
    /// else is internal. The raw text is kept as detail.
    pub(crate) fn from_java(code: Option<&str>, message: Option<&str>, error: &str) -> Self {
        let error =
            Self::new(code.and_then(Code::parse).unwrap_or(Code::Internal)).with_detail(error);
        match (error.code, message) {
            (Code::ComponentAmbiguous | Code::ComponentMissing, Some(text)) => {
                error.with_message(text)
            }
            _ => error,
        }
    }
}

impl std::fmt::Display for SimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SimError {}

impl From<Code> for SimError {
    fn from(code: Code) -> Self {
        Self::new(code)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_codes_are_known_and_unknown_ones_are_internal() {
        // Every code the session sources can raise must map to its own text.
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("java/native");
        let mut sources = vec![root.clone()];
        let mut codes = Vec::new();
        while let Some(path) = sources.pop() {
            for entry in std::fs::read_dir(&path).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    sources.push(path);
                } else if path.extension().is_some_and(|e| e == "java") {
                    let text = std::fs::read_to_string(&path).unwrap();
                    for part in text.split("new SessionError(\"").skip(1) {
                        codes.push(part.split('"').next().unwrap().to_owned());
                    }
                }
            }
        }
        assert!(codes.len() > 20, "{codes:?}");
        for code in &codes {
            let parsed = Code::parse(code).unwrap_or_else(|| panic!("unknown code {code}"));
            assert_ne!(parsed, Code::Internal);
        }
        let error = SimError::from_java(Some("NO_SUCH_CODE"), Some("raw"), "java.lang.Error: x");
        assert_eq!(error.code, Code::Internal);
        assert_eq!(error.message, Code::Internal.message());
        assert_eq!(error.detail(), Some("java.lang.Error: x"));
        let error = SimError::from_java(None, None, "java.lang.NullPointerException");
        assert_eq!(error.code, Code::Internal);
        let error = SimError::from_java(
            Some("INPUT_NOT_OPERABLE"),
            Some("Only input pins and clocks can be poked"),
            "x",
        );
        assert_eq!(error.message, "请选择这次运行中的可操作输入");
        let error = SimError::from_java(
            Some("COMPONENT_MISSING"),
            Some("找不到元件: Pin (1,2)"),
            "x",
        );
        assert_eq!(error.message, "找不到元件: Pin (1,2)");
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({"code":"COMPONENT_MISSING","message":"找不到元件: Pin (1,2)"})
        );
    }
}
