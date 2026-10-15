use super::{Effect::*, Meta};
use crate::{Host, Result, diagnostics::Stage, project_info};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum ProjectRequest {
    ProjectInfo {
        id: String,
        revision: String,
    },
    ProjectExport {
        id: String,
        revision: String,
        #[serde(default)]
        #[ts(optional)]
        path: Option<PathBuf>,
        #[serde(default)]
        #[ts(optional)]
        expected_revision: Option<String>,
    },
    ProjectExportTarget {
        path: PathBuf,
    },
    FeedbackStatus,
    FeedbackCheck {
        #[serde(default)]
        manual: bool,
    },
    FeedbackPreference {
        enabled: bool,
    },
    FeedbackDismiss {
        version: String,
    },
    Diagnostics,
    DiagnosticsExport {
        path: PathBuf,
        report: Value,
        #[serde(default)]
        #[ts(optional)]
        expected_revision: Option<String>,
    },
}

impl ProjectRequest {
    pub(crate) const OPS: &[&str] = &[
        "projectInfo",
        "projectExport",
        "projectExportTarget",
        "feedbackStatus",
        "feedbackCheck",
        "feedbackPreference",
        "feedbackDismiss",
        "diagnostics",
        "diagnosticsExport",
    ];
    pub(crate) fn meta(&self) -> Meta {
        match self {
            Self::ProjectExport { .. } => Meta::new(Read).stage(Stage::Export),
            Self::ProjectInfo { .. }
            | Self::ProjectExportTarget { .. }
            | Self::FeedbackStatus
            | Self::FeedbackCheck { .. }
            | Self::FeedbackPreference { .. }
            | Self::FeedbackDismiss { .. }
            | Self::Diagnostics
            | Self::DiagnosticsExport { .. } => Meta::new(Read),
        }
    }
}

impl Host {
    pub(crate) async fn project_request(&self, request: ProjectRequest) -> Result<Value> {
        match request {
            ProjectRequest::ProjectInfo { id, revision } => self.project_info(&id, &revision).await,
            ProjectRequest::ProjectExport {
                id,
                revision,
                path,
                expected_revision,
            } => {
                self.project_export(
                    &id,
                    &revision,
                    path.as_deref(),
                    expected_revision.as_deref(),
                )
                .await
            }
            ProjectRequest::ProjectExportTarget { path } => project_info::export_target(&path),
            ProjectRequest::FeedbackStatus => Ok(self.feedback.lock().await.status()),
            ProjectRequest::FeedbackCheck { manual } => {
                Ok(self.feedback.lock().await.check(manual).await)
            }
            ProjectRequest::FeedbackPreference { enabled } => {
                self.feedback.lock().await.preference(enabled)
            }
            ProjectRequest::FeedbackDismiss { version } => {
                self.feedback.lock().await.dismiss(version)
            }
            ProjectRequest::Diagnostics => Ok(self.diagnostics().await),
            ProjectRequest::DiagnosticsExport {
                path,
                report,
                expected_revision,
            } => self.diagnostics_export(path, report, expected_revision),
        }
    }
}
