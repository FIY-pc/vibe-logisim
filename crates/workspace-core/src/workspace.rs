use crate::{Document, DocumentView, Error, Result};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
#[derive(Default)]
pub struct Workspace {
    pub documents: BTreeMap<String, Document>,
    pub active: Option<String>,
    identities: BTreeMap<PathBuf, String>,
}
impl Workspace {
    pub fn insert(&mut self, document: Document) -> Result<DocumentView> {
        let view = document.view()?;
        self.active = Some(document.id.clone());
        self.documents.insert(document.id.clone(), document);
        Ok(view)
    }
    pub fn open(&mut self, path: &Path) -> Result<DocumentView> {
        let path = path.canonicalize()?;
        if let Some(doc) = self
            .documents
            .values()
            .find(|d| d.path.as_deref() == Some(path.as_path()))
        {
            let view = doc.view()?;
            self.active = Some(doc.id.clone());
            return Ok(view);
        }
        let mut doc = Document::open(&path)?;
        if let Some(id) = self.identities.get(&path)
            && !self.documents.contains_key(id)
        {
            doc.id = id.clone();
        }
        self.identities.insert(path, doc.id.clone());
        self.insert(doc)
    }
    pub fn get(&self, id: &str) -> Result<&Document> {
        self.documents.get(id).ok_or(Error::DocumentNotFound)
    }
    pub fn get_mut(&mut self, id: &str) -> Result<&mut Document> {
        self.documents.get_mut(id).ok_or(Error::DocumentNotFound)
    }
    pub fn save(
        &mut self,
        id: &str,
        revision: &str,
        target: Option<&Path>,
    ) -> Result<DocumentView> {
        self.save_checked(id, revision, target, None)
    }
    pub fn save_checked(
        &mut self,
        id: &str,
        revision: &str,
        target: Option<&Path>,
        target_revision: Option<&str>,
    ) -> Result<DocumentView> {
        if let Some(path) = target {
            let canonical = path.canonicalize().ok();
            if self
                .documents
                .values()
                .any(|d| d.id != id && canonical.is_some() && d.path == canonical)
            {
                return Err(Error::InvalidCommand("目标文件已在另一个文档中打开".into()));
            }
        }
        let d = self.get_mut(id)?;
        d.save_checked(revision, target, target_revision)?;
        let view = d.view()?;
        // Save As transfers the current document's identity to its new source.
        self.identities.retain(|_, known| known != id);
        self.identities
            .insert(view.path.clone().unwrap(), id.into());
        Ok(view)
    }
    pub fn close(&mut self, id: &str, discard: bool) -> Result<()> {
        if self.get(id)?.dirty() && !discard {
            return Err(Error::InvalidCommand("还有未保存的修改".into()));
        }
        if let Some(path) = self.get(id)?.path.clone() {
            self.identities.insert(path, id.into());
        }
        self.documents.remove(id);
        if self.active.as_deref() == Some(id) {
            self.active = self.documents.keys().next().cloned()
        }
        Ok(())
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Checkpoint {
    schema: u32,
    active: Option<String>,
    documents: Vec<crate::Recovery>,
    #[serde(default)]
    identities: BTreeMap<PathBuf, String>,
}
impl Workspace {
    pub fn restore(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let bytes = std::fs::read(path)?;
        let saved: Checkpoint = serde_json::from_slice(&bytes).map_err(|e| {
            Error::InvalidDocument(format!("无法恢复上次工作区，原记录已保留: {e}"))
        })?;
        if saved.schema != 1 {
            return Err(Error::InvalidDocument("不支持的工作区记录版本".into()));
        }
        let mut workspace = Self {
            identities: saved.identities,
            ..Self::default()
        };
        for record in saved.documents {
            let doc = Document::restore(record)?;
            workspace.documents.insert(doc.id.clone(), doc);
        }
        workspace.active = saved
            .active
            .filter(|id| workspace.documents.contains_key(id));
        Ok(workspace)
    }
    pub fn checkpoint(&self, path: &Path) -> Result<()> {
        use std::io::Write;
        let parent = path
            .parent()
            .ok_or_else(|| Error::Io("无效恢复记录路径".into()))?;
        std::fs::create_dir_all(parent)?;
        let saved = Checkpoint {
            schema: 1,
            active: self.active.clone(),
            documents: self.documents.values().map(Document::recovery).collect(),
            identities: self
                .identities
                .iter()
                .map(|(p, id)| (p.clone(), id.clone()))
                .chain(
                    self.documents
                        .values()
                        .filter_map(|d| Some((d.path.clone()?, d.id.clone()))),
                )
                .collect(),
        };
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        serde_json::to_writer(temp.as_file_mut(), &saved).map_err(|e| Error::Io(e.to_string()))?;
        temp.flush()?;
        temp.as_file().sync_all()?;
        temp.persist(path).map_err(|e| Error::Io(e.to_string()))?;
        Ok(())
    }
    pub fn relocate(&mut self, from: &Path, to: &Path) {
        self.identities = std::mem::take(&mut self.identities)
            .into_iter()
            .map(|(p, id)| {
                let path = p
                    .strip_prefix(from)
                    .map(|relative| to.join(relative))
                    .unwrap_or(p);
                (path, id)
            })
            .collect();
        for doc in self.documents.values_mut() {
            doc.relocate(from, to)
        }
    }
}
