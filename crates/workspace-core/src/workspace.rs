use crate::{Document, DocumentView, Error, Result, session::Session};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
#[derive(Default)]
pub struct Workspace {
    pub documents: BTreeMap<String, Document>,
    pub active: Option<String>,
    identities: BTreeMap<PathBuf, String>,
    session: Option<Session>,
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
    /// Writes a document back to its own source file. Only `dirty` changes,
    /// so no view is built.
    pub fn save_in_place(&mut self, id: &str, revision: &str) -> Result<()> {
        self.get_mut(id)?.save_checked(revision, None, None)
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

impl Workspace {
    /// Reopens the documents a previous run left in the session directory.
    pub fn restore(dir: &Path) -> Result<Self> {
        let restored = Session::restore(dir.to_path_buf())?;
        Ok(Self {
            documents: restored.documents,
            active: restored.active,
            identities: restored.identities,
            session: Some(restored.session),
        })
    }
    /// Records every change since the last call in the session directory;
    /// an edit costs a record the size of the change.
    pub fn persist(&mut self, dir: &Path) -> Result<()> {
        if self.session.as_ref().is_none_or(|s| s.dir != dir) {
            self.session = Some(Session::new(dir.to_path_buf()));
            for document in self.documents.values_mut() {
                document.pending = None;
            }
        }
        let identities = self
            .identities
            .iter()
            .map(|(p, id)| (p.clone(), id.clone()))
            .chain(
                self.documents
                    .values()
                    .filter_map(|d| Some((d.path.clone()?, d.id.clone()))),
            )
            .collect();
        let session = self.session.as_mut().expect("set above");
        session.persist(&mut self.documents, self.active.clone(), identities)
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
