use super::{Effect::*, Meta};
use crate::{
    Host, Result, diagnostics::Stage, document_history::Action, file_history, file_references,
    folder_operations::ImportChoice, value,
};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::PathBuf;

#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum FolderRequest {
    FolderOpen {
        path: PathBuf,
    },
    FolderList {
        #[serde(default)]
        path: String,
    },
    FolderRead {
        path: String,
        #[serde(default)]
        #[ts(optional)]
        folder_id: Option<String>,
    },
    FolderPreview {
        path: String,
        #[serde(default)]
        #[ts(optional)]
        folder_id: Option<String>,
    },
    FolderResolve {
        folder_id: String,
        path: String,
        #[serde(default)]
        #[ts(optional)]
        path_version: Option<u32>,
    },
    ProjectFiles {
        id: String,
        folder_id: String,
        path: String,
        #[serde(default)]
        read: bool,
    },
    FolderCreate {
        folder_id: String,
        path: String,
        #[serde(default)]
        directory: bool,
    },
    FolderRename {
        folder_id: String,
        from: String,
        to: String,
    },
    FolderTrash {
        folder_id: String,
        path: String,
    },
    FolderImportPrepare {
        folder_id: String,
        sources: Vec<PathBuf>,
        destination: String,
    },
    FolderImportApply {
        folder_id: String,
        plan_id: String,
        choices: Vec<ImportChoice>,
    },
    FolderImportCancel {
        folder_id: String,
        plan_id: String,
    },
    FolderHistory {
        folder_id: String,
    },
    FolderHistoryDetail {
        folder_id: String,
        id: String,
        path: String,
    },
    FolderHistoryUndo {
        folder_id: String,
        id: String,
    },
}

impl FolderRequest {
    pub(crate) const OPS: &[&str] = &[
        "folderOpen",
        "folderList",
        "folderRead",
        "folderPreview",
        "folderResolve",
        "projectFiles",
        "folderCreate",
        "folderRename",
        "folderTrash",
        "folderImportPrepare",
        "folderImportApply",
        "folderImportCancel",
        "folderHistory",
        "folderHistoryDetail",
        "folderHistoryUndo",
    ];
    pub(crate) fn meta(&self) -> Meta {
        match self {
            // Opening a folder writes its own pointer file; it changes no document.
            Self::FolderOpen { .. }
            | Self::FolderRead { .. }
            | Self::FolderPreview { .. }
            | Self::FolderResolve { .. } => Meta::new(Read).stage(Stage::Files),
            Self::FolderList { .. }
            | Self::FolderImportPrepare { .. }
            | Self::FolderImportCancel { .. }
            | Self::FolderHistory { .. }
            | Self::FolderHistoryDetail { .. } => Meta::new(Read),
            Self::ProjectFiles { .. } => Meta::new(Read).agent(),
            Self::FolderCreate { .. } => Meta::new(Write),
            Self::FolderTrash { .. } => Meta::new(Write).stage(Stage::Files),
            Self::FolderRename { .. }
            | Self::FolderImportApply { .. }
            | Self::FolderHistoryUndo { .. } => Meta::new(Write)
                .stage(Stage::Files)
                .history(Action::files()),
        }
    }
}

impl Host {
    pub(crate) async fn folder_request(&self, request: FolderRequest) -> Result<Value> {
        match request {
            FolderRequest::FolderOpen { path } => {
                let folder = vibe_workspace_core::Folder::open(&path)?;
                std::fs::create_dir_all(&self.state)?;
                std::fs::write(
                    self.state.join("folder.json"),
                    serde_json::to_vec(&folder).map_err(|e| e.to_string())?,
                )?;
                let history_warning = file_history::History::open(&self.state, &folder)
                    .err()
                    .map(|error| error.to_string());
                let mut result = value(&folder)?;
                if let Some(warning) = history_warning {
                    result["historyWarning"] = json!(warning);
                }
                *self.folder.lock().await = Some(folder);
                Ok(result)
            }
            FolderRequest::FolderList { path } => {
                let guard = self.folder.lock().await;
                let folder = guard.as_ref().ok_or("请先打开工程文件夹")?;
                let history_warning = file_history::History::open(&self.state, folder)
                    .err()
                    .map(|error| error.to_string());
                Ok(
                    json!({"folder":folder,"entries":folder.list(&path)?,"historyWarning":history_warning}),
                )
            }
            FolderRequest::FolderResolve {
                folder_id,
                path,
                path_version,
            } => {
                let guard = self.folder.lock().await;
                let folder = guard
                    .as_ref()
                    .filter(|f| f.id == folder_id)
                    .ok_or("工程文件夹已改变，请先打开引用所属文件夹")?;
                file_references::References::open(&self.state, folder)?.resolve(
                    folder,
                    &path,
                    path_version,
                )
            }
            FolderRequest::FolderRead { path, folder_id } => {
                let guard = self.folder.lock().await;
                let folder = guard.as_ref().ok_or("请先打开工程文件夹")?;
                if folder_id.as_ref().is_some_and(|id| id != &folder.id) {
                    return Err("工程文件夹已改变，未读取同名文件".into());
                }
                let (bytes, mut result) = file_references::References::open(&self.state, folder)?
                    .read(folder, &path, 2 * 1024 * 1024)?;
                result["text"] =
                    json!(String::from_utf8(bytes).map_err(|_| "文件不是 UTF-8 文本")?);
                Ok(result)
            }
            FolderRequest::FolderPreview { path, folder_id } => {
                let guard = self.folder.lock().await;
                let folder = guard.as_ref().ok_or("请先打开工程文件夹")?;
                if folder_id.as_ref().is_some_and(|id| id != &folder.id) {
                    return Err("工程文件夹已改变，未读取同名文件".into());
                }
                let extension = std::path::Path::new(&path)
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_ascii_lowercase();
                let mime = match extension.as_str() {
                    "pdf" => "application/pdf",
                    "png" => "image/png",
                    "jpg" | "jpeg" => "image/jpeg",
                    "webp" => "image/webp",
                    _ => return Err("不支持这个文件的预览".into()),
                };
                let (bytes, mut result) = file_references::References::open(&self.state, folder)?
                    .read(folder, &path, 24 * 1024 * 1024)?;
                result["data"] = json!(B64.encode(bytes));
                result["mime"] = json!(mime);
                Ok(result)
            }
            FolderRequest::ProjectFiles {
                id,
                folder_id,
                path,
                read,
            } => {
                let folder_guard = self.folder.lock().await;
                let folder = folder_guard.as_ref().ok_or("没有打开工程文件夹")?;
                if folder.id != folder_id {
                    return Err("工程文件夹已改变，请重新绑定".into());
                }
                let workspace = self.workspace.lock().await;
                let document = workspace.get(&id)?;
                if !document
                    .path
                    .as_ref()
                    .is_some_and(|p| p.starts_with(&folder.path))
                {
                    return Err("当前文档不属于这个工程文件夹".into());
                }
                if read {
                    let (bytes, mut result) = file_references::References::open(
                        &self.state,
                        folder,
                    )?
                    .read(folder, &path, 2 * 1024 * 1024)?;
                    result["text"] =
                        json!(String::from_utf8(bytes).map_err(|_| "文件不是 UTF-8 文本")?);
                    Ok(result)
                } else {
                    value(folder.list(&path)?)
                }
            }
            FolderRequest::FolderCreate {
                folder_id,
                path,
                directory,
            } => {
                self.create_project_entry(&folder_id, &path, directory)
                    .await
            }
            FolderRequest::FolderImportPrepare {
                folder_id,
                sources,
                destination,
            } => {
                self.prepare_file_import(&folder_id, sources, &destination)
                    .await
            }
            FolderRequest::FolderImportApply {
                folder_id,
                plan_id,
                choices,
            } => self.apply_file_import(&folder_id, &plan_id, choices).await,
            FolderRequest::FolderImportCancel { folder_id, plan_id } => {
                self.cancel_file_import(&folder_id, &plan_id).await
            }
            FolderRequest::FolderHistory { folder_id } => self.file_history(&folder_id).await,
            FolderRequest::FolderHistoryDetail {
                folder_id,
                id,
                path,
            } => self.file_history_detail(&folder_id, &id, &path).await,
            FolderRequest::FolderHistoryUndo { folder_id, id } => {
                self.undo_file_history(&folder_id, &id).await
            }
            FolderRequest::FolderRename {
                folder_id,
                from,
                to,
            } => self.move_project_entry(&folder_id, &from, &to).await,
            FolderRequest::FolderTrash { folder_id, path } => {
                self.trash_project_entry(&folder_id, &path).await
            }
        }
    }
}
