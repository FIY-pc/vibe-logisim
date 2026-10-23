use super::{Effect::*, Meta};
use crate::{Host, Result, agent::Agent, app::diagnostics::Stage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
    /// Starts the sidecar when needed and forwards the call as is; the
    /// sidecar reads the folder and documents itself through `status`.
    pub(crate) async fn agent_request(&self, request: AgentRequest) -> Result<Value> {
        let AgentRequest::Agent { method, args } = request;
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
