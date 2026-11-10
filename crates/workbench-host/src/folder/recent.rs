//! App-local project shortcuts. Removing a shortcut never touches the project.
use crate::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const FILE: &str = "recent-projects.json";
const LIMIT: usize = 10;

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct RecentProject {
    pub name: String,
    pub path: PathBuf,
    pub available: bool,
}

pub(crate) fn load(state: &Path) -> Result<Vec<PathBuf>> {
    match std::fs::read(state.join(FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
            "最近项目记录无法读取，请检查应用数据目录中的 recent-projects.json".into()
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Previous versions kept only the currently open folder. Retain it
            // even if its disk is temporarily disconnected.
            #[derive(Deserialize)]
            struct Previous {
                path: PathBuf,
            }
            match std::fs::read(state.join("folder.json")) {
                Ok(bytes) => Ok(serde_json::from_slice::<Previous>(&bytes)
                    .map(|folder| vec![folder.path])
                    .unwrap_or_default()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
                Err(error) => Err(error.into()),
            }
        }
        Err(error) => Err(error.into()),
    }
}

fn save(state: &Path, paths: &[PathBuf]) -> Result<()> {
    let mut file = tempfile::NamedTempFile::new_in(state)?;
    serde_json::to_writer_pretty(&mut file, paths).map_err(|e| e.to_string())?;
    file.as_file().sync_all()?;
    file.persist(state.join(FILE)).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn list(state: &Path) -> Result<Vec<RecentProject>> {
    Ok(load(state)?
        .into_iter()
        .take(LIMIT)
        .map(|path| RecentProject {
            name: path
                .file_name()
                .unwrap_or(path.as_os_str())
                .to_string_lossy()
                .into_owned(),
            available: path.is_dir(),
            path,
        })
        .collect())
}

pub(crate) fn remember(state: &Path, mut paths: Vec<PathBuf>, path: &Path) -> Result<()> {
    paths.retain(|old| super::target_key(old) != super::target_key(path));
    paths.insert(0, path.into());
    paths.truncate(LIMIT);
    save(state, &paths)
}

pub(crate) fn forget(state: &Path, path: &Path) -> Result<()> {
    let mut paths = load(state)?;
    paths.retain(|old| super::target_key(old) != super::target_key(path));
    save(state, &paths)
}

pub(crate) fn preserve_legacy(state: &Path) -> Result<()> {
    if !state.join(FILE).try_exists()? {
        save(state, &load(state)?)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FolderRequest, Host};
    use serde_json::json;

    #[tokio::test]
    async fn recent_projects_survive_close_restart_and_missing_directory() {
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("state");
        let host = Host::new(temp.path().into(), state.clone(), None).unwrap();
        for n in 0..12 {
            let path = temp.path().join(format!("电路项目 {n}"));
            std::fs::create_dir(&path).unwrap();
            host.dispatch(FolderRequest::FolderOpen { path })
                .await
                .unwrap();
        }
        let recent = host.dispatch(FolderRequest::FolderRecent).await.unwrap();
        assert_eq!(recent.as_array().unwrap().len(), 10);
        assert_eq!(recent[0]["name"], "电路项目 11");
        assert_eq!(recent[9]["name"], "电路项目 2");
        let reopened = PathBuf::from(recent[3]["path"].as_str().unwrap());
        let last = host
            .dispatch(FolderRequest::FolderOpen {
                path: reopened.clone(),
            })
            .await
            .unwrap();
        let recent = host.dispatch(FolderRequest::FolderRecent).await.unwrap();
        assert_eq!(recent[0]["path"], json!(reopened));
        assert_eq!(recent.as_array().unwrap().len(), 10);
        assert!(
            host.dispatch(FolderRequest::FolderOpen {
                path: temp.path().join("absent")
            })
            .await
            .is_err()
        );
        assert_eq!(
            host.dispatch(FolderRequest::FolderRecent).await.unwrap(),
            recent
        );
        host.dispatch(FolderRequest::FolderClose {
            folder_id: last["id"].as_str().unwrap().into(),
            documents: Default::default(),
            discard: false,
        })
        .await
        .unwrap();
        drop(host);
        std::fs::remove_dir(&reopened).unwrap();
        let host = Host::new(temp.path().into(), state, None).unwrap();
        let recent = host.dispatch(FolderRequest::FolderRecent).await.unwrap();
        assert_eq!(recent[0]["available"], false);
        let kept = PathBuf::from(recent[1]["path"].as_str().unwrap());
        std::fs::write(kept.join("keep.txt"), "untouched").unwrap();
        host.dispatch(FolderRequest::FolderForget { path: kept.clone() })
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(kept.join("keep.txt")).unwrap(),
            "untouched"
        );
        assert_eq!(
            host.dispatch(FolderRequest::FolderRecent)
                .await
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            9
        );
    }

    #[test]
    fn legacy_migration_and_corrupt_history_do_not_lose_records() {
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path();
        let old = state.join("previous project");
        std::fs::write(state.join("folder.json"), json!({"path":old}).to_string()).unwrap();
        preserve_legacy(state).unwrap();
        std::fs::remove_file(state.join("folder.json")).unwrap();
        assert_eq!(load(state).unwrap(), vec![old.clone()]);
        forget(state, &old).unwrap();
        assert!(load(state).unwrap().is_empty());
        std::fs::write(state.join(FILE), "broken").unwrap();
        assert!(load(state).is_err());
        assert!(forget(state, &old).is_err());
        assert_eq!(std::fs::read_to_string(state.join(FILE)).unwrap(), "broken");
    }
}
