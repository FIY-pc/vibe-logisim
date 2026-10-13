//! Session diagnostics never retain request data, source paths, or process output.
use crate::Request;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Stage {
    Open,
    Save,
    Edit,
    Render,
    Observe,
    Simulation,
    Verify,
    Library,
    Agent,
    Files,
    Export,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Failure {
    RuntimeUnavailable,
    ProcessExit,
    Timeout,
    Dependency,
    SourceChanged,
    InvalidInput,
    Storage,
    Unavailable,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct FailureCount {
    stage: Stage,
    code: Failure,
    count: u32,
    last_at: u64,
}
#[derive(Default)]
pub(crate) struct FailureLog {
    entries: Vec<FailureCount>,
}
impl FailureLog {
    pub fn record(&mut self, stage: Stage, error: &str) {
        let code = classify(error);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        if let Some(prior) = self
            .entries
            .iter_mut()
            .find(|e| e.stage == stage && e.code == code)
        {
            prior.count = prior.count.saturating_add(1);
            prior.last_at = now;
        } else {
            self.entries.push(FailureCount {
                stage,
                code,
                count: 1,
                last_at: now,
            });
        }
    }
    pub fn report(&self) -> Vec<FailureCount> {
        self.entries.clone()
    }
}
fn classify(error: &str) -> Failure {
    let text = error.to_ascii_lowercase();
    if text.contains("超时") || text.contains("timeout") || text.contains("timed out") {
        Failure::Timeout
    } else if text.contains("退出") || text.contains("exited") || text.contains("broken pipe") {
        Failure::ProcessExit
    } else if text.contains("logisim-ita")
        || text.contains("logisim 兼容运行时")
        || text.contains("需要 jdk")
        || text.contains("java 不")
        || text.contains("java 未")
        || text.contains("找不到 java")
        || text.contains("未找到 java")
        || text.contains("找不到 logisim")
        || text.contains("未找到 logisim")
    {
        Failure::RuntimeUnavailable
    } else if text.contains("组件库")
        || text.contains("library")
        || text.contains("classnotfound")
        || text.contains("noclassdeffound")
    {
        Failure::Dependency
    } else if text.contains("已改变")
        || text.contains("已修改")
        || text.contains("版本不匹配")
        || text.contains("外部")
    {
        Failure::SourceChanged
    } else if text.contains("无效")
        || text.contains("invalid")
        || text.contains("超过")
        || text.contains("格式")
    {
        Failure::InvalidInput
    } else if text.contains("保存")
        || text.contains("写入")
        || text.contains("permission")
        || text.contains("space left")
        || text.contains("read-only")
    {
        Failure::Storage
    } else {
        Failure::Unavailable
    }
}
pub(crate) fn stage(request: &Request) -> Option<Stage> {
    Some(match request {
        Request::Open { .. } | Request::Import { .. } | Request::Reload { .. } => Stage::Open,
        Request::Save { .. } => Stage::Save,
        Request::Edit { .. }
        | Request::Undo { .. }
        | Request::Redo { .. }
        | Request::InterfaceApply { .. }
        | Request::MemoryWrite { .. }
        | Request::HistoryRestore { .. } => Stage::Edit,
        Request::Render { .. }
        | Request::ProposalPreview { .. }
        | Request::HistoryPreview { .. }
        | Request::InterfaceRender { .. } => Stage::Render,
        Request::Observe { .. } => Stage::Observe,
        Request::SimulationStart { .. }
        | Request::SimulationAction { .. }
        | Request::SimulationView { .. }
        | Request::SimulationCommand { .. } => Stage::Simulation,
        Request::Simulate { .. } | Request::Trace { .. } | Request::ProposalVerify { .. } => {
            Stage::Verify
        }
        Request::Catalog { .. }
        | Request::Template { .. }
        | Request::Properties { .. }
        | Request::Memory { .. } => Stage::Library,
        Request::Agent { .. } => Stage::Agent,
        Request::FolderOpen { .. }
        | Request::FolderRead { .. }
        | Request::FolderPreview { .. }
        | Request::FolderResolve { .. }
        | Request::FolderRename { .. }
        | Request::FolderTrash { .. }
        | Request::FolderImportApply { .. }
        | Request::FolderHistoryUndo { .. } => Stage::Files,
        Request::ProjectExport { .. } => Stage::Export,
        _ => return None,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failures_do_not_retain_payloads() {
        let mut log = FailureLog::default();
        log.record(
            Stage::Simulation,
            "Logisim 启动握手前退出 /private/source.circ secret-token",
        );
        log.record(Stage::Simulation, "Logisim 启动握手前退出 other text");
        let report = serde_json::to_string(&log.report()).unwrap();
        assert!(report.contains("processExit"));
        assert!(report.contains("\"count\":2"));
        assert!(!report.contains("private"));
        assert!(!report.contains("secret-token"));
        assert!(serde_json::from_str::<FailureCount>(r#"{"stage":"simulation","code":"processExit","count":1,"lastAt":1,"log":"private"}"#).is_err());
    }
}
