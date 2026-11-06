use super::{Effect::*, Meta};
use crate::{
    ErrorCode, Host, HostError, Result,
    app::diagnostics::Stage,
    documents::history::Action,
    folder::{ImportChoice, file_history, file_references},
    value,
};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum FolderRequest {
    FolderOpen {
        path: PathBuf,
    },
    FolderClose {
        folder_id: String,
        documents: BTreeMap<String, String>,
        #[serde(default)]
        discard: bool,
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
    /// Creates an empty file (a `.circ` gets an empty circuit) or directory.
    /// Recorded as its own folder history entry unless `checkpoint` is
    /// false: then the caller's next `folderCheckpoint` includes it (the AI
    /// keeps a whole turn in one entry).
    FolderCreate {
        folder_id: String,
        path: String,
        #[serde(default)]
        directory: bool,
        #[serde(default)]
        #[ts(optional)]
        checkpoint: Option<bool>,
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
    /// Records the files changed since the last checkpoint as one entry of
    /// the folder history, titled as given. Nothing changed: no entry.
    FolderCheckpoint {
        folder_id: String,
        title: String,
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
        "folderClose",
        "folderList",
        "folderRead",
        "folderPreview",
        "folderResolve",
        "folderCreate",
        "folderRename",
        "folderTrash",
        "folderImportPrepare",
        "folderImportApply",
        "folderImportCancel",
        "folderCheckpoint",
        "folderHistory",
        "folderHistoryDetail",
        "folderHistoryUndo",
    ];
    pub(crate) fn meta(&self) -> Meta {
        match self {
            // Opening a folder writes its own pointer file; it changes no document.
            Self::FolderOpen { .. } | Self::FolderPreview { .. } | Self::FolderResolve { .. } => {
                Meta::new(Read).stage(Stage::Files)
            }
            Self::FolderClose { .. } => Meta::new(Write).stage(Stage::Files),
            Self::FolderRead { .. } => Meta::new(Read).stage(Stage::Files).agent(),
            Self::FolderList { .. } | Self::FolderHistory { .. } => Meta::new(Read).agent(),
            Self::FolderImportPrepare { .. }
            | Self::FolderImportCancel { .. }
            | Self::FolderHistoryDetail { .. } => Meta::new(Read),
            Self::FolderCreate { .. } => Meta::new(Write).agent(),
            Self::FolderCheckpoint { .. } => Meta::new(Write).stage(Stage::Files).agent(),
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
                let mut current = self.folder.lock().await;
                let folder = vibe_circuit_document::Folder::open(&path)?;
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
                *current = Some(folder);
                Ok(result)
            }
            FolderRequest::FolderClose {
                folder_id,
                documents,
                discard,
            } => {
                let mut current = self.folder.lock().await;
                if current.as_ref().map(|folder| folder.id.as_str()) != Some(folder_id.as_str()) {
                    return Err("文件夹已改变，请刷新后重试".into());
                }
                let mut workspace = self.workspace.lock().await;
                // Check the entire confirmation snapshot before closing even one document.
                if workspace.documents.len() != documents.len()
                    || workspace
                        .documents
                        .keys()
                        .any(|id| !documents.contains_key(id))
                {
                    return Err(HostError::new(
                        ErrorCode::StaleRevision,
                        "打开的文档已改变，请刷新后重试",
                    ));
                }
                for (id, revision) in &documents {
                    let document = workspace.get(id)?;
                    document.check(revision)?;
                    if document.dirty() && !discard {
                        return Err(HostError::new(
                            ErrorCode::InvalidCommand,
                            "还有未保存的修改，请先保存或确认放弃",
                        ));
                    }
                }
                match std::fs::remove_file(self.state.join("folder.json")) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
                // No await or remaining fallible validation between the checks and removal.
                for id in documents.keys() {
                    workspace
                        .close(id, true)
                        .expect("validated while holding workspace lock");
                }
                *current = None;
                Ok(json!({"closed": true}))
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
                    "pptx" => {
                        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                    }
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
            FolderRequest::FolderCreate {
                folder_id,
                path,
                directory,
                checkpoint,
            } => {
                self.create_project_entry(&folder_id, &path, directory, checkpoint != Some(false))
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
            FolderRequest::FolderCheckpoint { folder_id, title } => {
                self.checkpoint_folder(&folder_id, &title).await
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DocumentRequest, Event};
    use vibe_circuit_document::{Document, Edit, Point};

    async fn documents(host: &Host) -> BTreeMap<String, String> {
        host.workspace
            .lock()
            .await
            .documents
            .iter()
            .map(|(id, document)| (id.clone(), document.revision()))
            .collect()
    }

    async fn open_folder(host: &Host, project: &std::path::Path) -> String {
        host.dispatch(FolderRequest::FolderOpen {
            path: project.into(),
        })
        .await
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn changed_document(name: &str, path: &std::path::Path) -> Document {
        let mut document = Document::new(name.into());
        document.id = name.into();
        document.save(&document.revision(), Some(path)).unwrap();
        document
            .edit(
                &document.revision(),
                "main",
                Edit::Wire {
                    points: vec![Point { x: 10, y: 10 }, Point { x: 40, y: 10 }],
                },
            )
            .unwrap();
        document
    }

    #[tokio::test]
    async fn presentation_preview_preserves_bytes_revisions_and_file_boundaries() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let host = Host::new(temp.path().into(), temp.path().join("state"), None).unwrap();
        let folder_id = open_folder(&host, &project).await;
        let path = project.join("slides.PPTX");
        // Deliberately malformed binary: like PDF/image previews, the host transports
        // the source unchanged and leaves format/load errors to the client renderer.
        let original = b"PK\x03\x04\x00\xffsynthetic presentation";
        std::fs::write(&path, original).unwrap();
        let preview = |path: &str| FolderRequest::FolderPreview {
            path: path.into(),
            folder_id: Some(folder_id.clone()),
        };
        let listed = host
            .dispatch(FolderRequest::FolderList { path: "".into() })
            .await
            .unwrap();
        assert!(listed["entries"].as_array().unwrap().iter().any(|entry| {
            entry["path"] == "slides.PPTX"
                && entry["directory"] == false
                && entry["size"] == original.len()
        }));
        let first = host.dispatch(preview("slides.PPTX")).await.unwrap();
        assert_eq!(
            first["mime"],
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        );
        assert_eq!(
            B64.decode(first["data"].as_str().unwrap()).unwrap(),
            original
        );
        assert_eq!(first["revision"], vibe_circuit_document::digest(original));
        assert_eq!(first["folderId"], folder_id);
        assert_eq!(first["path"], "slides.PPTX");
        assert_eq!(first["relativePath"], "slides.PPTX");
        let version = first["pathVersion"].as_u64().unwrap() as u32;
        assert_eq!(
            first["url"],
            format!("workspace://slides.PPTX?pathVersion={version}")
        );
        assert_eq!(std::fs::read(&path).unwrap(), original);

        // An in-place change keeps the file identity but gets a new content revision.
        let changed = b"PK\x03\x04\x00\xfesynthetic presentation";
        std::fs::write(&path, changed).unwrap();
        let next = host.dispatch(preview("slides.PPTX")).await.unwrap();
        assert_eq!(B64.decode(next["data"].as_str().unwrap()).unwrap(), changed);
        assert_eq!(next["revision"], vibe_circuit_document::digest(changed));
        assert_ne!(next["revision"], first["revision"]);
        let resolve = || FolderRequest::FolderResolve {
            folder_id: folder_id.clone(),
            path: "slides.PPTX".into(),
            path_version: Some(version),
        };
        assert_eq!(
            host.dispatch(resolve()).await.unwrap()["path"],
            "slides.PPTX"
        );
        // A replacement at the same path must not take over an earlier reference.
        std::fs::rename(&path, project.join("original.PPTX")).unwrap();
        std::fs::write(&path, original).unwrap();
        assert!(
            host.dispatch(resolve())
                .await
                .unwrap_err()
                .to_string()
                .contains("文件身份已改变")
        );

        let oversized = std::fs::File::create(project.join("large.pptx")).unwrap();
        oversized.set_len(24 * 1024 * 1024 + 1).unwrap();
        std::fs::create_dir(project.join("directory.pptx")).unwrap();
        std::fs::write(temp.path().join("outside.pptx"), original).unwrap();
        for (request, message) in [
            (preview("large.pptx"), "文件超过 24 MB"),
            (preview("directory.pptx"), "请选择普通文件"),
            (preview("../outside.pptx"), "路径不在当前工程内"),
            (preview("slides.ppt"), "不支持这个文件的预览"),
            (
                FolderRequest::FolderPreview {
                    path: "slides.PPTX".into(),
                    folder_id: Some("other".into()),
                },
                "工程文件夹已改变",
            ),
        ] {
            let error = host.dispatch(request).await.unwrap_err().to_string();
            assert!(error.contains(message), "{error}");
        }
        assert!(host.dispatch(preview("missing.pptx")).await.is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(temp.path().join("outside.pptx"), project.join("link.pptx"))
                .unwrap();
            assert!(
                host.dispatch(preview("link.pptx"))
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("链接指向当前工程之外")
            );
        }
    }

    #[tokio::test]
    async fn close_folder_rejects_the_whole_snapshot_without_partial_close() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let state = temp.path().join("state");
        let host = Host::new(temp.path().into(), state.clone(), None).unwrap();
        // The UI stops before taking its confirmation snapshot. No sidecar
        // is installed under this temporary root; stop must still succeed.
        host.dispatch(crate::AgentRequest::Agent {
            method: "stop".into(),
            args: json!({}),
        })
        .await
        .unwrap();
        assert!(host.agent.lock().await.is_none());
        let folder_id = open_folder(&host, &project).await;
        let clean_path = project.join("clean.circ");
        let mut clean = Document::new("clean.circ".into());
        clean.id = "a".into();
        clean.save(&clean.revision(), Some(&clean_path)).unwrap();
        let dirty_path = temp.path().join("outside.circ");
        let dirty = changed_document("z", &dirty_path);
        let original = std::fs::read(&dirty_path).unwrap();
        {
            let mut workspace = host.workspace.lock().await;
            workspace.insert(clean).unwrap();
            workspace.insert(dirty).unwrap();
            host.persist(&mut workspace).await;
        }
        // A refused folder close must not run follow_files(close_missing=true),
        // which would silently remove this otherwise clean document.
        std::fs::remove_file(&clean_path).unwrap();
        let expected = documents(&host).await;
        let mut missing = expected.clone();
        missing.remove("z");
        let mut extra = expected.clone();
        extra.insert("extra".into(), "revision".into());
        let mut wrong_id = expected.clone();
        let revision = wrong_id.remove("z").unwrap();
        wrong_id.insert("other".into(), revision);
        let mut stale = expected.clone();
        stale.insert("z".into(), "outdated".into());
        for (folder, snapshot, discard) in [
            ("stale".to_owned(), expected.clone(), true),
            (folder_id.clone(), missing, true),
            (folder_id.clone(), extra, true),
            (folder_id.clone(), wrong_id, true),
            (folder_id.clone(), stale, true),
            (folder_id.clone(), expected.clone(), false),
        ] {
            assert!(
                host.dispatch(FolderRequest::FolderClose {
                    folder_id: folder,
                    documents: snapshot,
                    discard,
                })
                .await
                .is_err()
            );
            assert_eq!(documents(&host).await, expected);
            assert_eq!(host.workspace.lock().await.active.as_deref(), Some("z"));
            assert_eq!(host.folder.lock().await.as_ref().unwrap().id, folder_id);
            assert!(state.join("folder.json").is_file());
            assert_eq!(std::fs::read(&dirty_path).unwrap(), original);
        }
        assert!(
            host.agent.lock().await.is_none(),
            "Closing must not start the sidecar"
        );
        drop(host);
        let restored = Host::new(temp.path().into(), state, None).unwrap();
        assert_eq!(documents(&restored).await, expected);
        assert!(restored.workspace.lock().await.get("z").unwrap().dirty());
    }

    #[tokio::test]
    async fn close_folder_saved_or_discarded_documents_stay_closed_after_restart() {
        for discard in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let project = temp.path().join("project");
            std::fs::create_dir(&project).unwrap();
            let state = temp.path().join("state");
            let host = Host::new(temp.path().into(), state.clone(), None).unwrap();
            let folder_id = open_folder(&host, &project).await;
            let source = project.join("source.circ");
            let changed = changed_document("a", &source);
            let original = std::fs::read(&source).unwrap();
            let mut untitled = Document::new("untitled.circ".into());
            untitled.id = "b".into();
            {
                let mut workspace = host.workspace.lock().await;
                workspace.insert(changed).unwrap();
                workspace.insert(untitled).unwrap();
                host.persist(&mut workspace).await;
            }
            let saved_target = temp.path().join("saved.circ");
            if !discard {
                for (id, revision) in documents(&host).await {
                    host.dispatch(DocumentRequest::Save {
                        path: (id == "b").then(|| saved_target.clone()),
                        id,
                        revision,
                        target_revision: None,
                    })
                    .await
                    .unwrap();
                }
                assert!(saved_target.is_file());
                assert_ne!(std::fs::read(&source).unwrap(), original);
            }
            let source_before_close = std::fs::read(&source).unwrap();
            let mut events = host.events.subscribe();
            let result = host
                .dispatch(FolderRequest::FolderClose {
                    folder_id,
                    documents: documents(&host).await,
                    discard,
                })
                .await
                .unwrap();
            assert_eq!(result["closed"], true);
            assert!(host.folder.lock().await.is_none());
            assert!(!state.join("folder.json").exists());
            assert!(documents(&host).await.is_empty());
            assert!(host.workspace.lock().await.active.is_none());
            assert_eq!(std::fs::read(&source).unwrap(), source_before_close);
            if discard {
                assert_eq!(source_before_close, original);
                assert!(!saved_target.exists());
            }
            assert!(matches!(events.try_recv(), Ok(Event::Workspace(change))
                if change.documents.is_empty() && change.active.is_none()));
            assert!(host.agent.lock().await.is_none());
            drop(host);
            let restored = Host::new(temp.path().into(), state, None).unwrap();
            assert!(restored.folder.lock().await.is_none());
            assert!(documents(&restored).await.is_empty());
            assert!(restored.workspace.lock().await.active.is_none());
        }
    }

    #[tokio::test]
    async fn close_folder_clears_restore_pointer_and_rejects_stale_id() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir(&project).unwrap();
        std::fs::write(project.join("keep.txt"), "keep").unwrap();
        let state = temp.path().join("state");
        let host = Host::new(temp.path().into(), state.clone(), None).unwrap();
        let folder = host
            .dispatch(FolderRequest::FolderOpen {
                path: project.clone(),
            })
            .await
            .unwrap();
        assert!(
            host.dispatch(FolderRequest::FolderClose {
                folder_id: "stale".into(),
                documents: BTreeMap::new(),
                discard: false,
            })
            .await
            .is_err()
        );
        assert!(state.join("folder.json").exists());
        assert!(host.folder.lock().await.is_some());
        host.dispatch(FolderRequest::FolderClose {
            folder_id: folder["id"].as_str().unwrap().into(),
            documents: BTreeMap::new(),
            discard: false,
        })
        .await
        .unwrap();
        assert!(host.folder.lock().await.is_none());
        assert!(!state.join("folder.json").exists());
        assert_eq!(
            std::fs::read_to_string(project.join("keep.txt")).unwrap(),
            "keep"
        );
        drop(host);
        let restored = Host::new(temp.path().into(), state, None).unwrap();
        assert!(restored.folder.lock().await.is_none());
    }
}
