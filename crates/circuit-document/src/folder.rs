use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub path: PathBuf,
    pub name: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub directory: bool,
    pub size: u64,
}
impl Folder {
    pub fn open(path: &Path) -> Result<Self> {
        let path = path.canonicalize()?;
        if !path.is_dir() {
            return Err(Error::InvalidCommand("请选择文件夹".into()));
        }
        Ok(Self {
            id: format!(
                "folder:{}",
                crate::digest(path.to_string_lossy().as_bytes())
            ),
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            path,
        })
    }
    pub fn resolve(&self, relative: &str, existing: bool) -> Result<PathBuf> {
        let rel = Path::new(relative);
        if rel.is_absolute()
            || rel.components().any(|c| {
                matches!(
                    c,
                    std::path::Component::ParentDir
                        | std::path::Component::Prefix(_)
                        | std::path::Component::RootDir
                )
            })
        {
            return Err(Error::InvalidCommand("路径不在当前工程内".into()));
        }
        let target = self.path.join(rel);
        let resolved = if existing {
            target.canonicalize()?
        } else {
            target
                .parent()
                .ok_or_else(|| Error::InvalidCommand("无效路径".into()))?
                .canonicalize()?
                .join(
                    target
                        .file_name()
                        .ok_or_else(|| Error::InvalidCommand("无效文件名".into()))?,
                )
        };
        if !resolved.starts_with(&self.path) {
            return Err(Error::InvalidCommand("链接指向当前工程之外".into()));
        }
        Ok(resolved)
    }
    pub fn list(&self, relative: &str) -> Result<Vec<Entry>> {
        let target = self.resolve(relative, true)?;
        let mut entries = Vec::new();
        for entry in fs::read_dir(target)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if [".git", "node_modules", ".workbench-state", "target"].contains(&name.as_str()) {
                continue;
            }
            let metadata = entry.metadata()?;
            entries.push(Entry {
                name,
                path: entry
                    .path()
                    .strip_prefix(&self.path)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                directory: metadata.is_dir(),
                size: metadata.len(),
            });
            if entries.len() >= 5000 {
                break;
            }
        }
        entries.sort_by(|a, b| {
            b.directory
                .cmp(&a.directory)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }
    pub fn create(&self, relative: &str, directory: bool) -> Result<PathBuf> {
        let path = self.resolve(relative, false)?;
        if directory {
            fs::create_dir(&path)?
        } else {
            use std::io::Write;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?;
            if path.extension().is_some_and(|s| s == "circ") {
                file.write_all(crate::EMPTY_CIRCUIT.as_bytes())?;
                file.sync_all()?
            }
        }
        Ok(path)
    }
    pub fn read(&self, relative: &str) -> Result<String> {
        let path = self.resolve(relative, true)?;
        if fs::metadata(&path)?.len() > 2 * 1024 * 1024 {
            return Err(Error::InvalidCommand(
                "文件超过 2 MB，请使用外部编辑器".into(),
            ));
        }
        fs::read_to_string(path).map_err(Into::into)
    }
    pub fn rename(&self, from: &str, to: &str) -> Result<(PathBuf, PathBuf)> {
        let from = self.entry_path(from)?;
        let to = self.resolve(to, false)?;
        if from == self.path {
            return Err(Error::InvalidCommand("不能移动工程根目录".into()));
        }
        if to.starts_with(&from) {
            return Err(Error::InvalidCommand("不能移动到自身或自己的子目录".into()));
        }
        if to.symlink_metadata().is_ok() {
            return Err(Error::InvalidCommand("目标已存在".into()));
        }
        rename_without_replace(&from, &to)?;
        Ok((from, to))
    }
    /// Resolve the entry itself: moving a symlink must not move its target.
    pub fn entry_path(&self, relative: &str) -> Result<PathBuf> {
        let path = self.resolve(relative, false)?;
        if path == self.path {
            return Err(Error::InvalidCommand("不能修改工程根目录".into()));
        }
        path.symlink_metadata()?;
        Ok(path)
    }
}

fn rename_without_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        rustix::fs::renameat_with(
            rustix::fs::CWD,
            from,
            rustix::fs::CWD,
            to,
            rustix::fs::RenameFlags::NOREPLACE,
        )?;
        Ok(())
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        // MoveFileW refuses an existing destination, unlike std::fs::rename.
        if unsafe { windows_sys::Win32::Storage::FileSystem::MoveFileW(from.as_ptr(), to.as_ptr()) }
            == 0
        {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = (from, to);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Moving project files is not supported on this platform",
        ))
    }
}
