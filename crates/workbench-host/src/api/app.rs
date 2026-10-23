//! The application itself: update feedback and diagnostics.
use super::{Effect::*, Meta};
use crate::{Host, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum AppRequest {
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

impl AppRequest {
    pub(crate) const OPS: &[&str] = &[
        "feedbackStatus",
        "feedbackCheck",
        "feedbackPreference",
        "feedbackDismiss",
        "diagnostics",
        "diagnosticsExport",
    ];
    pub(crate) fn meta(&self) -> Meta {
        match self {
            Self::FeedbackStatus
            | Self::FeedbackCheck { .. }
            | Self::FeedbackPreference { .. }
            | Self::FeedbackDismiss { .. }
            | Self::Diagnostics
            | Self::DiagnosticsExport { .. } => Meta::new(Read),
        }
    }
}

impl Host {
    pub(crate) async fn app_request(&self, request: AppRequest) -> Result<Value> {
        match request {
            AppRequest::FeedbackStatus => Ok(self.feedback.lock().await.status()),
            AppRequest::FeedbackCheck { manual } => {
                Ok(self.feedback.lock().await.check(manual).await)
            }
            AppRequest::FeedbackPreference { enabled } => {
                self.feedback.lock().await.preference(enabled)
            }
            AppRequest::FeedbackDismiss { version } => self.feedback.lock().await.dismiss(version),
            AppRequest::Diagnostics => Ok(self.diagnostics().await),
            AppRequest::DiagnosticsExport {
                path,
                report,
                expected_revision,
            } => self.diagnostics_export(path, report, expected_revision),
        }
    }
}
