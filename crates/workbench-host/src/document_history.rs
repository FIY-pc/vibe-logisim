use crate::{
    Host, Request, Result,
    proposal_review::{ComparisonDetail, ProposalReview},
    value,
    verification::VerificationRecord,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use vibe_workspace_core::{
    Document, Edit, SourceStatus,
    history::{DocumentHistory, HistoricalSnapshot, HistoryEntry},
};

#[derive(Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryList {
    entries: Vec<HistoryEntry>,
    current_revision: String,
    saved_revision: Option<String>,
    warning: Option<String>,
}
#[derive(Serialize, ts_rs::TS)]
pub struct HistoryReview {
    entry: HistoryEntry,
    mode: String,
    review: ProposalReview,
    original: String,
    xml: String,
    evidence: Vec<VerificationRecord>,
}
pub(crate) struct Action {
    pub kind: &'static str,
    pub title: &'static str,
    pub target: Option<String>,
    pub restored: Option<String>,
}
pub(crate) fn action(request: &Request) -> Option<Action> {
    let (kind, title, target, restored) = match request {
        Request::Open { .. } | Request::New { .. } | Request::Import { .. } => {
            ("open", "打开工程", None, None)
        }
        Request::Save { id, .. } => ("save", "保存版本", Some(id.clone()), None),
        Request::Undo { id, .. } => ("undo", "撤销修改", Some(id.clone()), None),
        Request::Redo { id, .. } => ("redo", "重做修改", Some(id.clone()), None),
        Request::Reload { id, .. } => ("reload", "读取磁盘版本", Some(id.clone()), None),
        Request::InterfaceApply { id, .. } => {
            ("interface", "修改封装与接口", Some(id.clone()), None)
        }
        Request::MemoryWrite { id, .. } => ("memory", "修改存储器内容", Some(id.clone()), None),
        Request::HistoryRestore { id, entry, .. } => (
            "restore",
            "恢复历史版本",
            Some(id.clone()),
            Some(entry.clone()),
        ),
        Request::Edit { id, edit, .. } => (
            "edit",
            match edit {
                Edit::Place { .. } => "放置元件",
                Edit::Wire { .. } => "绘制导线",
                Edit::Move { .. } => "移动对象",
                Edit::Attributes { .. } => "修改元件属性",
                Edit::Replace { .. } => "替换电路内容",
                Edit::AddCircuit { .. } => "添加电路",
                Edit::RenameCircuit { .. } => "重命名电路",
                Edit::DeleteCircuit => "删除电路",
                Edit::SetMain => "设置主电路",
                _ => "编辑电路",
            },
            Some(id.clone()),
            None,
        ),
        Request::FolderRename { .. }
        | Request::FolderImportApply { .. }
        | Request::FolderHistoryUndo { .. } => ("files", "工程文件更新", None, None),
        _ => return None,
    };
    Some(Action {
        kind,
        title,
        target,
        restored,
    })
}
impl Host {
    pub(crate) fn history_store(&self) -> DocumentHistory {
        DocumentHistory::new(self.state.join("document-history"))
    }
    pub(crate) fn history_snapshot(&self, doc: &Document) -> Result<HistoricalSnapshot> {
        let view = doc.view().map_err(|e| e.to_string())?;
        let (artifact, _) = self.materialize(doc)?;
        Ok(HistoricalSnapshot {
            name: view.name,
            path: doc.path.clone(),
            xml: String::from_utf8_lossy(doc.bytes()).into_owned(),
            revision: doc.revision(),
            dependencies: vibe_logisim_adapter::artifact_dependencies(&artifact).ok(),
        })
    }
    fn ensure_history(&self, doc: &Document) -> Result<()> {
        let store = self.history_store();
        if !store.is_empty(&doc.id).map_err(|e| e.to_string())? {
            return Ok(());
        }
        let view = doc.view().map_err(|e| e.to_string())?;
        for bytes in doc.legacy_versions() {
            let version = Document::from_bytes(view.name.clone(), doc.path.clone(), bytes, false)
                .map_err(|e| e.to_string())?;
            let snapshot = HistoricalSnapshot {
                name: view.name.clone(),
                path: doc.path.clone(),
                xml: String::from_utf8_lossy(version.bytes()).into_owned(),
                revision: version.revision(),
                dependencies: None,
            };
            store
                .append(&doc.id, None, &snapshot, "legacy", "恢复记录中的版本", None)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub(crate) async fn history_before(
        &self,
        action: &Action,
    ) -> Result<BTreeMap<String, (Document, HistoricalSnapshot)>> {
        let documents = self
            .workspace
            .lock()
            .await
            .documents
            .iter()
            .filter(|(id, _)| action.target.as_ref().is_none_or(|target| *id == target))
            .map(|(id, d)| (id.clone(), d.clone()))
            .collect::<Vec<_>>();
        documents
            .into_iter()
            .map(|(id, doc)| {
                self.ensure_history(&doc)?;
                let snapshot = self.history_snapshot(&doc)?;
                Ok((id, (doc, snapshot)))
            })
            .collect()
    }
    pub(crate) async fn history_after(
        &self,
        action: &Action,
        before: BTreeMap<String, (Document, HistoricalSnapshot)>,
    ) -> Result<()> {
        let documents = self
            .workspace
            .lock()
            .await
            .documents
            .iter()
            .filter(|(id, _)| action.target.as_ref().is_none_or(|target| *id == target))
            .map(|(id, d)| (id.clone(), d.clone()))
            .collect::<Vec<_>>();
        let store = self.history_store();
        for (id, doc) in documents {
            let previous = before.get(&id);
            let changed = previous
                .is_none_or(|(old, _)| old.revision() != doc.revision() || old.path != doc.path);
            if !changed && action.kind != "save" {
                continue;
            }
            let after = self.history_snapshot(&doc)?;
            let kind = if previous.is_none() {
                "open"
            } else {
                action.kind
            };
            store
                .append(
                    &id,
                    previous.map(|(_, s)| s),
                    &after,
                    kind,
                    if kind == "open" {
                        "打开工程"
                    } else {
                        action.title
                    },
                    action.restored.clone(),
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub(crate) async fn history_list(&self, id: &str) -> Result<Value> {
        let _gate = self.history_gate.lock().await;
        let doc = self
            .workspace
            .lock()
            .await
            .get(id)
            .map_err(|e| e.to_string())?
            .clone();
        self.ensure_history(&doc)?;
        let entries = self
            .history_store()
            .entries(id)
            .map_err(|e| e.to_string())?;
        let legacy = entries.iter().any(|e| e.kind == "legacy");
        value(HistoryList {
            entries,
            current_revision: doc.revision(),
            saved_revision: doc.saved_revision().map(str::to_string),
            warning: legacy
                .then(|| "早期恢复记录没有操作时间或冻结的组件库；只保留可恢复内容。".into()),
        })
    }
    async fn history_pair(
        &self,
        id: &str,
        revision: &str,
        entry: &str,
        mode: &str,
    ) -> Result<(HistoryEntry, HistoricalSnapshot, HistoricalSnapshot)> {
        if !matches!(mode, "change" | "current") {
            return Err("无效对照方式".into());
        }
        let doc = self
            .workspace
            .lock()
            .await
            .get(id)
            .map_err(|e| e.to_string())?
            .clone();
        doc.check(revision).map_err(|e| e.to_string())?;
        let (entry, before, after) = self
            .history_store()
            .resolve(id, entry, mode == "change")
            .map_err(|e| e.to_string())?;
        if mode == "current" {
            Ok((entry, after, self.history_snapshot(&doc)?))
        } else {
            Ok((entry, before.unwrap_or_else(|| after.clone()), after))
        }
    }
    pub(crate) fn historical_native(
        &self,
        id: &str,
        snapshot: &HistoricalSnapshot,
    ) -> Result<Document> {
        let doc = snapshot.document(id).map_err(|e| e.to_string())?;
        let expected = snapshot
            .dependencies
            .as_ref()
            .ok_or("这个历史版本没有冻结的组件库身份，无法精确重放；源码仍可查看和恢复")?;
        let (artifact, _) = self.materialize(&doc)?;
        if &vibe_logisim_adapter::artifact_dependencies(&artifact)? != expected {
            return Err("此版本引用的组件库已改变，不能用当前库冒充历史运行结果".into());
        }
        Ok(doc)
    }
    pub(crate) async fn history_review(
        &self,
        id: &str,
        revision: &str,
        entry: &str,
        mode: &str,
    ) -> Result<Value> {
        let (entry, before, after) = self.history_pair(id, revision, entry, mode).await?;
        let review = self.describe_pair(
            id,
            revision,
            &before.document(id).map_err(|e| e.to_string())?,
            &after.document(id).map_err(|e| e.to_string())?,
        )?;
        value(HistoryReview {
            entry,
            mode: mode.into(),
            evidence: review.evidence.clone(),
            review,
            original: before.xml,
            xml: after.xml,
        })
    }
    pub(crate) async fn history_preview(
        &self,
        id: &str,
        revision: &str,
        entry: &str,
        mode: &str,
        circuit: &str,
        candidate: bool,
    ) -> Result<Value> {
        let (_, before, after) = self.history_pair(id, revision, entry, mode).await?;
        let chosen = if candidate { after } else { before };
        let doc = self.historical_native(id, &chosen)?;
        self.preview_document(&doc, circuit).await
    }
    pub(crate) async fn history_detail(
        &self,
        id: &str,
        revision: &str,
        entry: &str,
        mode: &str,
        circuit: &str,
    ) -> Result<Value> {
        let (_, before, after) = self.history_pair(id, revision, entry, mode).await?;
        let native_ok = self
            .historical_native(id, &before)
            .and_then(|_| self.historical_native(id, &after));
        let before = before.document(id).map_err(|e| e.to_string())?;
        let after = after.document(id).map_err(|e| e.to_string())?;
        if let Err(error) = native_ok {
            return value(ComparisonDetail::unavailable(circuit, error));
        }
        value(self.compare_documents(&before, &after, circuit).await?)
    }
    pub(crate) async fn history_restore(
        &self,
        id: &str,
        revision: &str,
        entry: &str,
    ) -> Result<Value> {
        let (_, _, snapshot) = self
            .history_store()
            .resolve(id, entry, false)
            .map_err(|e| e.to_string())?;
        let historical = snapshot.document(id).map_err(|e| e.to_string())?;
        if snapshot.dependencies.is_some() {
            self.historical_native(id, &snapshot)?;
        }
        let mut workspace = self.workspace.lock().await;
        let current = workspace.get_mut(id).map_err(|e| e.to_string())?;
        current.check(revision).map_err(|e| e.to_string())?;
        if !matches!(
            current.source_status(),
            SourceStatus::Untitled | SourceStatus::Unchanged { .. }
        ) {
            return Err("磁盘源文件已改变，请先处理外部改动".into());
        }
        let xml = String::from_utf8(
            historical
                .bytes_at_path(current.path.as_deref())
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let main = current.view().map_err(|e| e.to_string())?.main;
        current
            .edit(revision, &main, Edit::Replace { xml })
            .map_err(|e| e.to_string())?;
        value(current.view().map_err(|e| e.to_string())?)
    }
}
