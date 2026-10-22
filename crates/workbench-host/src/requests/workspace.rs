use super::{Effect::*, Meta};
use crate::{Host, Result, diagnostics::Stage, document_history::Action, value};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::PathBuf;
use vibe_workspace_core::Document;

#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum WorkspaceRequest {
    Status,
    Open {
        path: PathBuf,
    },
    New {
        name: String,
    },
    Import {
        name: String,
        xml: String,
    },
    Read {
        id: String,
    },
    Activate {
        id: String,
    },
    Source {
        id: String,
        #[serde(default)]
        #[ts(optional)]
        revision: Option<String>,
    },
    SourceStatus {
        id: String,
    },
    Reload {
        id: String,
        revision: String,
        source_revision: String,
        #[serde(default)]
        discard: bool,
    },
    Close {
        id: String,
        revision: String,
        #[serde(default)]
        discard: bool,
    },
    Save {
        id: String,
        revision: String,
        path: Option<PathBuf>,
        #[serde(default)]
        #[ts(optional)]
        target_revision: Option<String>,
    },
    SaveTarget {
        path: PathBuf,
    },
}

impl WorkspaceRequest {
    pub(crate) const OPS: &[&str] = &[
        "status",
        "open",
        "new",
        "import",
        "read",
        "activate",
        "source",
        "sourceStatus",
        "reload",
        "close",
        "save",
        "saveTarget",
    ];
    pub(crate) fn meta(&self) -> Meta {
        match self {
            // The runtime reads status to resolve the open folder and file facts.
            Self::Status | Self::SourceStatus { .. } | Self::SaveTarget { .. } => {
                Meta::new(Read).agent()
            }
            Self::Read { .. } | Self::Source { .. } => Meta::new(Read).agent(),
            Self::Open { .. } | Self::Import { .. } => {
                Meta::new(Write).stage(Stage::Open).history(Action::open())
            }
            Self::New { .. } => Meta::new(Write).history(Action::open()),
            Self::Activate { .. } | Self::Close { .. } => Meta::new(Write),
            Self::Reload { id, .. } => Meta::new(Write)
                .stage(Stage::Open)
                .history(Action::document("reload", "读取磁盘版本", id)),
            Self::Save { id, .. } => Meta::new(Write)
                .stage(Stage::Save)
                .history(Action::document("save", "保存版本", id)),
        }
    }
}

impl Host {
    pub(crate) async fn workspace_request(&self, request: WorkspaceRequest) -> Result<Value> {
        match request {
            WorkspaceRequest::Status => {
                let w = self.workspace.lock().await;
                let documents = w
                    .documents
                    .values()
                    .map(|d| d.view())
                    .collect::<vibe_workspace_core::Result<Vec<_>>>()?;
                let active = w.active.clone();
                drop(w);
                Ok(
                    json!({"documents":documents,"active":active,"recoveryError":self.recovery_error,"folder":self.folder.lock().await.clone(),"runtime":self.native.lock().await.status()}),
                )
            }
            WorkspaceRequest::New { name } => {
                value(self.workspace.lock().await.insert(Document::new(name))?)
            }
            WorkspaceRequest::Open { path } => value(self.workspace.lock().await.open(&path)?),
            WorkspaceRequest::Import { name, xml } => {
                value(self.workspace.lock().await.insert(Document::from_bytes(
                    name,
                    None,
                    xml.into_bytes(),
                    false,
                )?)?)
            }
            WorkspaceRequest::Read { id } => value(self.workspace.lock().await.get(&id)?.view()?),
            WorkspaceRequest::Activate { id } => {
                let mut w = self.workspace.lock().await;
                w.get(&id)?;
                w.active = Some(id);
                Ok(Value::Null)
            }
            WorkspaceRequest::Source { id, revision } => {
                let workspace = self.workspace.lock().await;
                let document = workspace.get(&id)?;
                if let Some(revision) = revision {
                    document.check(&revision)?;
                }
                Ok(
                    json!({"xml":String::from_utf8_lossy(document.bytes()),"revision":document.revision()}),
                )
            }
            WorkspaceRequest::SourceStatus { id } => {
                value(self.workspace.lock().await.get(&id)?.source_status())
            }
            WorkspaceRequest::Reload {
                id,
                revision,
                source_revision,
                discard,
            } => {
                let mut w = self.workspace.lock().await;
                let d = w.get_mut(&id)?;
                d.reload(&revision, &source_revision, discard)?;
                value(d.view()?)
            }
            WorkspaceRequest::Close {
                id,
                revision,
                discard,
            } => {
                let mut w = self.workspace.lock().await;
                w.get(&id)?.check(&revision)?;
                // Dispatch ends a run of the closed document after this request.
                w.close(&id, discard)?;
                Ok(json!({"closed":true}))
            }
            WorkspaceRequest::Save {
                id,
                revision,
                path,
                target_revision,
            } => {
                self.save_with_references(
                    &id,
                    &revision,
                    path.as_deref(),
                    target_revision.as_deref(),
                )
                .await
            }
            WorkspaceRequest::SaveTarget { path } => match std::fs::metadata(&path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({"revision":null})),
                Err(e) => Err(e.into()),
                Ok(meta) if !meta.is_file() || meta.len() > 32 * 1024 * 1024 => {
                    Err("请选择不超过 32 MB 的电路文件".into())
                }
                Ok(_) => Ok(json!({"revision":vibe_workspace_core::digest(&std::fs::read(path)?)})),
            },
        }
    }
}
