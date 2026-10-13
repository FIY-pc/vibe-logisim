mod recycle;
use crate::{Host, Result};
use serde_json::{Value, json};

impl Host {
    pub(crate) async fn move_project_entry(
        &self,
        folder_id: &str,
        from: &str,
        to: &str,
    ) -> Result<Value> {
        let folder = self.folder.lock().await;
        let folder = folder.as_ref().ok_or("请先打开工程文件夹")?;
        if folder.id != folder_id {
            return Err("工程文件夹已改变，请重新操作".into());
        }
        let target = folder
            .resolve(to, false)
            .map_err(|error| error.to_string())?;
        let mut workspace = self.workspace.lock().await;
        if workspace.documents.values().any(|document| {
            document
                .path
                .as_ref()
                .is_some_and(|path| path.starts_with(&target))
        }) {
            return Err("目标路径已有打开的文档，请先关闭该文档".into());
        }
        let (from, to) = folder.rename(from, to).map_err(|error| error.to_string())?;
        workspace.relocate(&from, &to);
        Ok(json!({"from":from,"to":to}))
    }

    pub(crate) async fn trash_project_entry(
        &self,
        folder_id: &str,
        relative: &str,
    ) -> Result<Value> {
        let folder = self.folder.lock().await;
        let folder = folder.as_ref().ok_or("请先打开工程文件夹")?;
        if folder.id != folder_id {
            return Err("工程文件夹已改变，请重新操作".into());
        }
        let path = folder
            .entry_path(relative)
            .map_err(|error| error.to_string())?;
        let mut workspace = self.workspace.lock().await;
        let mut closed = Vec::new();
        for document in workspace.documents.values() {
            if document
                .path
                .as_ref()
                .is_some_and(|source| source.starts_with(&path))
            {
                if document.dirty() {
                    return Err(format!(
                        "“{}”还有未保存的修改，请先保存或关闭该文档",
                        document.view().map_err(|error| error.to_string())?.name
                    ));
                }
                closed.push(document.id.clone());
            }
        }
        // Hold the document lock until the OS operation finishes: an edit cannot race
        // the dirty check and turn a clean close into a silent discard.
        tokio::task::spawn_blocking(move || recycle::send(&path))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| format!("无法移入回收站：{error}"))?;
        for id in &closed {
            workspace
                .close(id, false)
                .map_err(|error| error.to_string())?;
        }
        drop(workspace);
        let mut native = self.native.lock().await;
        if native
            .simulation
            .as_ref()
            .is_some_and(|session| closed.contains(&session.document_id))
        {
            native.stop_simulation().await;
        }
        Ok(json!({"trashed":true,"closed":closed}))
    }
}
