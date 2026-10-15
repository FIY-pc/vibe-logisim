use super::{Effect::*, Meta};
use crate::{Host, Result, agent::Agent, diagnostics::Stage};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{Arc, atomic::Ordering};

#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum AgentRequest {
    Agent {
        method: String,
        #[serde(default)]
        args: Value,
    },
}

impl AgentRequest {
    pub(crate) const OPS: &[&str] = &["agent"];
    pub(crate) fn meta(&self) -> Meta {
        match self {
            Self::Agent { .. } => Meta::new(Read).stage(Stage::Agent),
        }
    }
}

impl Host {
    pub(crate) async fn agent_request(&self, request: AgentRequest) -> Result<Value> {
        let AgentRequest::Agent { method, mut args } = request;
        if method == "bind" {
            let id = args["id"].as_str().ok_or("请先打开电路")?;
            let revision = args["revision"].as_str().ok_or("缺少电路版本")?;
            let view = {
                let workspace = self.workspace.lock().await;
                let doc = workspace.get(id)?;
                doc.check(revision)?;
                doc.view()?
            };
            let folder = self.folder.lock().await;
            let key = folder
                .as_ref()
                .filter(|f| view.path.as_ref().is_some_and(|p| p.starts_with(&f.path)))
                .map(|f| f.id.clone())
                .unwrap_or(view.id);
            args["folderId"] = if key.starts_with("folder:") {
                json!(&key)
            } else {
                Value::Null
            };
            args["workspaceKey"] = json!(key);
        }
        let runtime = {
            let mut guard = self.agent.lock().await;
            if guard.is_none()
                || (method != "events"
                    && guard
                        .as_ref()
                        .is_some_and(|a| !a.alive.load(Ordering::Acquire)))
            {
                *guard = Some(Arc::new(Agent::start(
                    &self.root,
                    &self.state,
                    self.clone(),
                )?));
            }
            guard.as_ref().unwrap().clone()
        };
        runtime.call(&method, args).await
    }
}
