use super::{Effect::*, Meta};
use crate::{
    Host, Result,
    diagnostics::Stage,
    document_history::Action,
    verification::{self, InputEvent, TestVector, TraceWatch, VerificationInput},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum ReviewRequest {
    ProposalObserve {
        id: String,
        revision: String,
        original: String,
        xml: String,
        circuit: String,
    },
    ProposalReview {
        id: String,
        revision: String,
        original: String,
        xml: String,
    },
    ProposalPreview {
        id: String,
        revision: String,
        original: String,
        xml: String,
        circuit: String,
        candidate: bool,
    },
    ProposalDetail {
        id: String,
        revision: String,
        original: String,
        xml: String,
        circuit: String,
    },
    ProposalVerify {
        id: String,
        revision: String,
        original: String,
        xml: String,
        circuit: String,
        verification: VerificationInput,
    },
    /// Runs 1–256 input vectors through a circuit of the given revision in a
    /// separate runtime, each from fresh state, and compares the output pins
    /// named in `expected`. Isolated from the live run: it neither reads nor
    /// changes what the user sees. The agent's vector tool uses it.
    Simulate {
        id: String,
        revision: String,
        circuit: String,
        vectors: Vec<TestVector>,
    },
    /// Runs a circuit of the given revision for 1–256 clock ticks in a
    /// separate runtime from fresh state, applying the input events at their
    /// ticks and sampling 1–16 watched ports (`component` id and `port`)
    /// after every tick. Isolated from the live run, like `simulate`. The
    /// agent's trace tool uses it.
    Trace {
        id: String,
        revision: String,
        circuit: String,
        ticks: u32,
        inputs: BTreeMap<String, u32>,
        watches: Vec<TraceWatch>,
        #[serde(default)]
        events: Vec<InputEvent>,
    },
    HistoryList {
        id: String,
    },
    HistoryReview {
        id: String,
        revision: String,
        entry: String,
        mode: String,
    },
    HistoryPreview {
        id: String,
        revision: String,
        entry: String,
        mode: String,
        circuit: String,
        candidate: bool,
    },
    HistoryDetail {
        id: String,
        revision: String,
        entry: String,
        mode: String,
        circuit: String,
    },
    HistoryRestore {
        id: String,
        revision: String,
        entry: String,
    },
}

impl ReviewRequest {
    pub(crate) const OPS: &[&str] = &[
        "proposalObserve",
        "proposalReview",
        "proposalPreview",
        "proposalDetail",
        "proposalVerify",
        "simulate",
        "trace",
        "historyList",
        "historyReview",
        "historyPreview",
        "historyDetail",
        "historyRestore",
    ];
    pub(crate) fn meta(&self) -> Meta {
        match self {
            Self::ProposalObserve { .. } | Self::ProposalReview { .. } => Meta::new(Read).agent(),
            Self::ProposalPreview { .. } => Meta::new(Read).stage(Stage::Render).agent(),
            Self::ProposalVerify { .. } | Self::Simulate { .. } | Self::Trace { .. } => {
                Meta::new(Read).stage(Stage::Verify).agent()
            }
            Self::ProposalDetail { .. }
            | Self::HistoryList { .. }
            | Self::HistoryReview { .. }
            | Self::HistoryDetail { .. } => Meta::new(Read),
            Self::HistoryPreview { .. } => Meta::new(Read).stage(Stage::Render),
            Self::HistoryRestore { id, entry, .. } => Meta::new(AutoSave)
                .stage(Stage::Edit)
                .history(Action::restore(id, entry)),
        }
    }
}

impl Host {
    pub(crate) async fn review_request(&self, request: ReviewRequest) -> Result<Value> {
        match request {
            ReviewRequest::ProposalObserve {
                id,
                revision,
                original,
                xml,
                circuit,
            } => {
                self.observe_proposal(&id, &revision, &original, &xml, &circuit)
                    .await
            }
            ReviewRequest::ProposalReview {
                id,
                revision,
                original,
                xml,
            } => self.review_proposal(&id, &revision, &original, &xml).await,
            ReviewRequest::ProposalPreview {
                id,
                revision,
                original,
                xml,
                circuit,
                candidate,
            } => {
                self.preview_proposal(&id, &revision, &original, &xml, &circuit, candidate)
                    .await
            }
            ReviewRequest::ProposalDetail {
                id,
                revision,
                original,
                xml,
                circuit,
            } => {
                self.detail_proposal(&id, &revision, &original, &xml, &circuit)
                    .await
            }
            ReviewRequest::ProposalVerify {
                id,
                revision,
                original,
                xml,
                circuit,
                verification,
            } => {
                self.verify_proposal(&id, &revision, &original, &xml, &circuit, verification)
                    .await
            }
            ReviewRequest::Simulate {
                id,
                revision,
                circuit,
                vectors,
            } => self.verify_vectors(&id, &revision, &circuit, vectors).await,
            ReviewRequest::Trace {
                id,
                revision,
                circuit,
                ticks,
                inputs,
                watches,
                events,
            } => {
                self.verify_trace(
                    &id,
                    &revision,
                    &circuit,
                    verification::TraceProgram {
                        ticks,
                        inputs,
                        watches,
                        events,
                    },
                )
                .await
            }
            ReviewRequest::HistoryList { id } => self.history_list(&id).await,
            ReviewRequest::HistoryReview {
                id,
                revision,
                entry,
                mode,
            } => self.history_review(&id, &revision, &entry, &mode).await,
            ReviewRequest::HistoryPreview {
                id,
                revision,
                entry,
                mode,
                circuit,
                candidate,
            } => {
                self.history_preview(&id, &revision, &entry, &mode, &circuit, candidate)
                    .await
            }
            ReviewRequest::HistoryDetail {
                id,
                revision,
                entry,
                mode,
                circuit,
            } => {
                self.history_detail(&id, &revision, &entry, &mode, &circuit)
                    .await
            }
            ReviewRequest::HistoryRestore {
                id,
                revision,
                entry,
            } => self.history_restore(&id, &revision, &entry).await,
        }
    }
}
