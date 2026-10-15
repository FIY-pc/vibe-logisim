use super::{Effect::*, Meta};
use crate::{Host, Result, diagnostics::Stage, document_history::Action};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum InterfaceRequest {
    InterfaceRead {
        id: String,
        revision: String,
        circuit: String,
    },
    InterfacePreview {
        id: String,
        revision: String,
        circuit: String,
        draft: vibe_workspace_core::SymbolDraft,
    },
    InterfaceApply {
        id: String,
        revision: String,
        circuit: String,
        preview_id: String,
        draft: vibe_workspace_core::SymbolDraft,
    },
    InterfaceRender {
        id: String,
        revision: String,
        preview_id: String,
        circuit: String,
    },
}

impl InterfaceRequest {
    pub(crate) const OPS: &[&str] = &[
        "interfaceRead",
        "interfacePreview",
        "interfaceApply",
        "interfaceRender",
    ];
    pub(crate) fn meta(&self) -> Meta {
        match self {
            Self::InterfaceRead { .. } | Self::InterfacePreview { .. } => Meta::new(Read),
            Self::InterfaceApply { id, .. } => Meta::new(AutoSave)
                .stage(Stage::Edit)
                .history(Action::document("interface", "修改封装与接口", id)),
            Self::InterfaceRender { .. } => Meta::new(Read).stage(Stage::Render),
        }
    }
}

impl Host {
    pub(crate) async fn interface_request(&self, request: InterfaceRequest) -> Result<Value> {
        match request {
            InterfaceRequest::InterfaceRead {
                id,
                revision,
                circuit,
            } => self.read_interface(&id, &revision, &circuit).await,
            InterfaceRequest::InterfacePreview {
                id,
                revision,
                circuit,
                draft,
            } => {
                self.preview_interface(&id, &revision, &circuit, &draft)
                    .await
            }
            InterfaceRequest::InterfaceApply {
                id,
                revision,
                circuit,
                preview_id,
                draft,
            } => {
                self.apply_interface(&id, &revision, &circuit, &preview_id, &draft)
                    .await
            }
            InterfaceRequest::InterfaceRender {
                id,
                revision,
                preview_id,
                circuit,
            } => {
                self.render_interface(&id, &revision, &preview_id, &circuit)
                    .await
            }
        }
    }
}
