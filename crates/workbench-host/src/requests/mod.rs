//! Host requests grouped by domain. Each op states once whether it changes the
//! workspace, whether its document is written back to the source file, which
//! history entry it records, its diagnostics stage and whether the AI runtime
//! may call it; dispatch applies those rules for every op alike.
mod agent;
mod editing;
mod folder;
mod interface;
mod project;
mod review;
mod simulation;
mod workspace;
pub use agent::AgentRequest;
pub use editing::EditingRequest;
pub use folder::FolderRequest;
pub use interface::InterfaceRequest;
pub use project::ProjectRequest;
pub use review::ReviewRequest;
pub use simulation::SimulationRequest;
pub use workspace::WorkspaceRequest;

use crate::{
    diagnostics::Stage,
    document_history::Action,
    error::{ErrorCode, HostError},
};
use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use serde_json::Value;

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(untagged)]
pub enum Request {
    Workspace(WorkspaceRequest),
    Editing(EditingRequest),
    Interface(InterfaceRequest),
    Simulation(SimulationRequest),
    Review(ReviewRequest),
    Folder(FolderRequest),
    Project(ProjectRequest),
    Agent(AgentRequest),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Effect {
    Read,
    /// Changes the workspace; persisted after success.
    Write,
    /// Changes a document; also written back when its source is in the open folder.
    AutoSave,
}

pub(crate) struct Meta {
    pub effect: Effect,
    pub history: Option<Action>,
    pub stage: Option<Stage>,
    pub agent: bool,
}

impl Meta {
    pub(crate) fn new(effect: Effect) -> Self {
        Self {
            effect,
            history: None,
            stage: None,
            agent: false,
        }
    }
    pub(crate) fn stage(mut self, stage: Stage) -> Self {
        self.stage = Some(stage);
        self
    }
    pub(crate) fn history(mut self, action: Action) -> Self {
        self.history = Some(action);
        self
    }
    pub(crate) fn agent(mut self) -> Self {
        self.agent = true;
        self
    }
}

impl Request {
    pub(crate) fn meta(&self) -> Meta {
        match self {
            Self::Workspace(r) => r.meta(),
            Self::Editing(r) => r.meta(),
            Self::Interface(r) => r.meta(),
            Self::Simulation(r) => r.meta(),
            Self::Review(r) => r.meta(),
            Self::Folder(r) => r.meta(),
            Self::Project(r) => r.meta(),
            Self::Agent(r) => r.meta(),
        }
    }
    /// Parses a request from any transport; failures use the shared error shape.
    pub fn from_value(value: Value) -> Result<Self, HostError> {
        serde_json::from_value(value).map_err(|error| {
            HostError::new(ErrorCode::InvalidInput, format!("请求格式无效：{error}"))
        })
    }
}

impl<'de> Deserialize<'de> for Request {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        let op = match value.get("op") {
            Some(Value::String(op)) => op.as_str(),
            Some(_) => return Err(D::Error::custom("op must be a string")),
            None => return Err(D::Error::missing_field("op")),
        };
        let parsed = if WorkspaceRequest::OPS.contains(&op) {
            WorkspaceRequest::deserialize(value).map(Self::Workspace)
        } else if EditingRequest::OPS.contains(&op) {
            EditingRequest::deserialize(value).map(Self::Editing)
        } else if InterfaceRequest::OPS.contains(&op) {
            InterfaceRequest::deserialize(value).map(Self::Interface)
        } else if SimulationRequest::OPS.contains(&op) {
            SimulationRequest::deserialize(value).map(Self::Simulation)
        } else if ReviewRequest::OPS.contains(&op) {
            ReviewRequest::deserialize(value).map(Self::Review)
        } else if FolderRequest::OPS.contains(&op) {
            FolderRequest::deserialize(value).map(Self::Folder)
        } else if ProjectRequest::OPS.contains(&op) {
            ProjectRequest::deserialize(value).map(Self::Project)
        } else if AgentRequest::OPS.contains(&op) {
            AgentRequest::deserialize(value).map(Self::Agent)
        } else {
            return Err(D::Error::custom(format!("unknown op `{op}`")));
        };
        parsed.map_err(D::Error::custom)
    }
}

macro_rules! domain_from {
    ($($variant:ident($ty:ident)),*) => {$(
        impl From<$ty> for Request {
            fn from(request: $ty) -> Self {
                Self::$variant(request)
            }
        }
    )*};
}
domain_from!(
    Workspace(WorkspaceRequest),
    Editing(EditingRequest),
    Interface(InterfaceRequest),
    Simulation(SimulationRequest),
    Review(ReviewRequest),
    Folder(FolderRequest),
    Project(ProjectRequest),
    Agent(AgentRequest)
);

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use ts_rs::TS;
    fn declared<T: TS>() -> BTreeSet<String> {
        let config = ts_rs::Config::default();
        T::decl(&config)
            .split("\"op\": \"")
            .skip(1)
            .map(|rest| rest.split('"').next().unwrap().to_string())
            .collect()
    }
    fn listed(ops: &[&str]) -> BTreeSet<String> {
        let set = ops.iter().map(|op| op.to_string()).collect::<BTreeSet<_>>();
        assert_eq!(set.len(), ops.len(), "duplicate op in {ops:?}");
        set
    }
    #[test]
    fn every_op_routes_to_exactly_one_domain() {
        let domains = [
            (
                declared::<WorkspaceRequest>(),
                listed(WorkspaceRequest::OPS),
            ),
            (declared::<EditingRequest>(), listed(EditingRequest::OPS)),
            (
                declared::<InterfaceRequest>(),
                listed(InterfaceRequest::OPS),
            ),
            (
                declared::<SimulationRequest>(),
                listed(SimulationRequest::OPS),
            ),
            (declared::<ReviewRequest>(), listed(ReviewRequest::OPS)),
            (declared::<FolderRequest>(), listed(FolderRequest::OPS)),
            (declared::<ProjectRequest>(), listed(ProjectRequest::OPS)),
            (declared::<AgentRequest>(), listed(AgentRequest::OPS)),
        ];
        let mut all = BTreeSet::new();
        for (declared, listed) in domains {
            assert_eq!(declared, listed);
            for op in listed {
                assert!(all.insert(op.clone()), "{op} is listed in two domains");
            }
        }
    }
    #[test]
    fn requests_parse_by_op() {
        let parsed = Request::from_value(serde_json::json!({"op":"read","id":"a"})).unwrap();
        assert!(matches!(
            parsed,
            Request::Workspace(WorkspaceRequest::Read { .. })
        ));
        let parsed = Request::from_value(serde_json::json!({"op":"simulationStatus"})).unwrap();
        assert!(matches!(
            parsed,
            Request::Simulation(SimulationRequest::SimulationStatus)
        ));
        let unknown = Request::from_value(serde_json::json!({"op":"format"})).unwrap_err();
        assert_eq!(unknown.code, ErrorCode::InvalidInput);
        assert!(unknown.message.contains("unknown op `format`"));
        let missing = Request::from_value(serde_json::json!({"op":"read"})).unwrap_err();
        assert!(missing.message.contains("missing field `id`"));
        assert!(
            Request::from_value(serde_json::json!({"id":"a"}))
                .unwrap_err()
                .message
                .contains("missing field `op`")
        );
    }
    #[test]
    fn writes_and_ai_access_follow_the_op() {
        let edit = Request::from_value(serde_json::json!({"op":"edit","id":"a","revision":"r","circuit":"main","edit":{"kind":"setMain"}})).unwrap();
        let meta = edit.meta();
        assert_eq!(meta.effect, Effect::AutoSave);
        assert!(meta.agent);
        assert_eq!(meta.history.unwrap().title, "设置主电路");
        let save = Request::from_value(
            serde_json::json!({"op":"save","id":"a","revision":"r","path":null}),
        )
        .unwrap();
        assert_eq!(save.meta().effect, Effect::Write);
        assert!(!save.meta().agent);
        let create = Request::from_value(
            serde_json::json!({"op":"folderCreate","folder_id":"f","path":"a.circ"}),
        )
        .unwrap();
        assert_eq!(create.meta().effect, Effect::Write);
    }
}
