//! Documents and editing independent of desktop, simulation, and AI runtimes.
mod document;
mod editing;
pub mod history;
mod journal;
mod junction;
mod patch;
mod session;
mod splice;
pub mod symbol;
mod workspace;
pub use document::*;
pub use journal::flush as flush_journals;
use serde::Serialize;
pub use symbol::{SymbolDraft, SymbolPort, SymbolShape};
pub use workspace::*;

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "code", content = "message", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Error {
    #[error("{0}")]
    InvalidDocument(String),
    #[error("{0}")]
    InvalidCommand(String),
    #[error("电路已改变，请重新读取后再修改")]
    StaleRevision,
    #[error("源文件已被其他程序修改，请先重新载入或另存为")]
    ExternalChange,
    #[error("{0}")]
    Io(String),
    #[error("找不到文档")]
    DocumentNotFound,
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}
pub type Result<T> = std::result::Result<T, Error>;
pub fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

mod folder;
pub use folder::*;

pub fn edit_schema() -> serde_json::Value {
    serde_json::to_value(schemars::schema_for!(Edit)).expect("Edit has a JSON schema")
}
