//! Runtime resolution and the Java launch plumbing shared by every native
//! process. Facts are file checks and copies that never wait for a process;
//! the launcher compiles the bridge once per runtime and builds commands.
use crate::{Result, process::java_path};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{process::Command, sync::OnceCell};
use vibe_workspace_core::digest;

/// File name of the 2.15 compatibility runtime in the product and the development cache.
/// It keeps the upstream name: the runtime records `2.15.0.2.exe` as the saving
/// program only when its own file name ends in `.exe`, and files it saves must
/// stay identical to those saved by the original program.
pub const LEGACY_RUNTIME: &str = "logisim-ita-cn-20200118.exe";

/// The runtime line that interprets a document.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
pub enum RuntimeKind {
    #[serde(rename = "current")]
    Current,
    #[serde(rename = "2.15")]
    Legacy,
}

/// The `source` attribute of the root `<project>` element, which names the
/// Logisim build that last saved the file.
fn source_version(bytes: &[u8]) -> Option<String> {
    let find =
        |haystack: &[u8], needle: &[u8]| haystack.windows(needle.len()).position(|w| w == needle);
    let start = find(bytes, b"<project")?;
    let tag = &bytes[start..];
    let tag = &tag[..find(tag, b">")?];
    let at = find(tag, b"source=")? + "source=".len();
    let quote = *tag.get(at)?;
    if quote != b'"' && quote != b'\'' {
        return None;
    }
    let value = &tag[at + 1..];
    let end = value.iter().position(|&b| b == quote)?;
    String::from_utf8(value[..end].to_vec()).ok()
}

/// The runtime version a worker reply reports, when it is a plain version string.
pub(crate) fn reported_version(bytes: &[u8]) -> Option<String> {
    xmltree::Element::parse(bytes)
        .ok()
        .and_then(|root| root.attributes.get("runtimeVersion").cloned())
        .or_else(|| {
            serde_json::from_slice::<Value>(bytes)
                .ok()
                .and_then(|value| {
                    value["runtime"]["reportedVersion"]
                        .as_str()
                        .map(str::to_owned)
                })
        })
        .filter(|version| {
            !version.is_empty()
                && version.len() <= 64
                && version
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b))
        })
}

struct Facts {
    root: PathBuf,
    runtime: Option<PathBuf>,
    observed_version: Mutex<Option<String>>,
}

/// Which runtimes are installed and the last version one reported.
#[derive(Clone)]
pub struct RuntimeFacts(Arc<Facts>);

impl RuntimeFacts {
    pub fn new(root: PathBuf, runtime: Option<PathBuf>) -> Self {
        Self(Arc::new(Facts {
            root,
            runtime,
            observed_version: Mutex::new(None),
        }))
    }
    pub fn root(&self) -> &Path {
        &self.0.root
    }
    pub fn runtime(&self) -> Result<PathBuf> {
        let candidates = [
            self.0.runtime.clone(),
            std::env::var_os("VIBE_LOGISIM_JAR").map(PathBuf::from),
            Some(self.0.root.join("native/Logisim-ITA.jar")),
            Some(self.0.root.join(".workbench-cache/Logisim-ITA.jar")),
        ];
        candidates
            .into_iter()
            .flatten()
            .find(|p| p.is_file())
            .ok_or_else(|| {
                "尚未安装 Logisim 兼容运行时；开发环境请运行 npm run setup，或设置 VIBE_LOGISIM_JAR"
                    .into()
            })
    }
    fn legacy_runtime(&self) -> Option<PathBuf> {
        [
            std::env::var_os("VIBE_LOGISIM_LEGACY_JAR").map(PathBuf::from),
            Some(self.0.root.join("native").join(LEGACY_RUNTIME)),
            Some(self.0.root.join(".workbench-cache").join(LEGACY_RUNTIME)),
        ]
        .into_iter()
        .flatten()
        .find(|p| p.is_file())
    }
    /// The runtime that interprets this file the way the program that saved it did.
    /// Builds of the 2.15 line write `<project source="2.15.*">` and accept
    /// attributes that ITA 2.16 rejects or reads differently (for example
    /// level-triggered flip-flops), so their files run on the matching runtime.
    pub fn runtime_for(&self, source: &[u8]) -> Result<(PathBuf, RuntimeKind)> {
        if self.0.runtime.is_none()
            && source_version(source).is_some_and(|v| v.starts_with("2.15."))
        {
            return self
                .legacy_runtime()
                .map(|path| (path, RuntimeKind::Legacy))
                .ok_or_else(|| {
                    "这个文件由 Logisim 2.15 保存，需要配套的 2.15 兼容运行时，但应用里缺少它；请重新安装应用（开发环境运行 npm run setup）"
                        .into()
                });
        }
        Ok((self.runtime()?, RuntimeKind::Current))
    }
    pub fn status(&self) -> Value {
        let legacy = self.legacy_runtime().is_some();
        match self.runtime() {
            Ok(p) => json!({"available":true,"path":p,"legacyAvailable":legacy}),
            Err(e) => json!({"available":false,"message":e,"legacyAvailable":legacy}),
        }
    }
    pub fn observed_version(&self) -> Option<String> {
        self.0
            .observed_version
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub(crate) fn record_version(&self, version: String) {
        *self
            .0
            .observed_version
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(version);
    }
}

struct Launch {
    facts: RuntimeFacts,
    state: PathBuf,
    classes: Mutex<BTreeMap<PathBuf, Arc<OnceCell<PathBuf>>>>,
}

/// Starts native processes. Clones share one bridge build per runtime.
#[derive(Clone)]
pub struct Launcher(Arc<Launch>);

impl Launcher {
    pub fn new(facts: RuntimeFacts, state: PathBuf) -> Self {
        Self(Arc::new(Launch {
            facts,
            state,
            classes: Mutex::new(BTreeMap::new()),
        }))
    }
    pub fn facts(&self) -> &RuntimeFacts {
        &self.0.facts
    }
    pub fn state(&self) -> &Path {
        &self.0.state
    }
    /// The bridge compiled against one runtime. Packages ship it precompiled per
    /// runtime digest; other runtimes compile once into the state directory.
    /// Concurrent callers share one build; a failed build is retried next time.
    pub(crate) async fn classes(&self, runtime: &Path) -> Result<PathBuf> {
        let cell = self
            .0
            .classes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(runtime.into())
            .or_default()
            .clone();
        cell.get_or_try_init(|| self.build(runtime)).await.cloned()
    }
    async fn build(&self, runtime: &Path) -> Result<PathBuf> {
        let runtime_bytes = std::fs::read(runtime).map_err(|e| e.to_string())?;
        let packaged = self.facts().root().join("native");
        let precompiled = packaged.join("classes").join(digest(&runtime_bytes));
        if precompiled
            .join("com/cburch/logisim/file/CircuitSession.class")
            .is_file()
        {
            return Ok(precompiled);
        }
        let base = self.facts().root().join("crates/logisim-adapter/java");
        let mut sources = Vec::new();
        let folders = if packaged.join("src").is_dir() {
            vec![packaged.join("src")]
        } else {
            vec![base.join("native"), base.join("observer/src")]
        };
        for folder in folders {
            collect_java(&folder, &mut sources)?
        }
        sources.sort();
        let mut bytes = runtime_bytes;
        for p in &sources {
            bytes.extend(std::fs::read(p).map_err(|e| e.to_string())?)
        }
        let classes = self.0.state.join("java").join(digest(&bytes));
        if !classes
            .join("com/cburch/logisim/file/CircuitSession.class")
            .is_file()
        {
            std::fs::create_dir_all(&classes).map_err(|e| e.to_string())?;
            let mut command = Command::new(self.java_executable("javac"));
            command
                .args(["-encoding", "UTF-8", "-cp"])
                .arg(java_path(runtime))
                .arg("-d")
                .arg(java_path(&classes))
                .args(sources.iter().map(|source| java_path(source)))
                .kill_on_drop(true);
            #[cfg(windows)]
            command.creation_flags(CREATE_NO_WINDOW);
            let output = tokio::time::timeout(Duration::from_secs(90), command.output())
                .await
                .map_err(|_| "Logisim 兼容模块编译超时")?
                .map_err(|e| format!("需要 JDK 17 或更新版本: {e}"))?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr)
                    .chars()
                    .take(6000)
                    .collect());
            }
        }
        Ok(classes)
    }
    fn java_executable(&self, name: &str) -> PathBuf {
        let binary = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.into()
        };
        let bundled = self.facts().root().join("runtimes/java/bin").join(&binary);
        if bundled.is_file() {
            java_path(&bundled)
        } else {
            PathBuf::from(binary)
        }
    }
    /// A JVM running one bridge class against `runtime`, with piped stdio.
    pub(crate) async fn command(&self, class: &str, runtime: &Path) -> Result<Command> {
        let classes = self.classes(runtime).await?;
        let cp = std::env::join_paths([java_path(&classes), java_path(runtime)])
            .map_err(|e| e.to_string())?;
        let mut cmd = Command::new(self.java_executable("java"));
        cmd.args(["-Xmx768m", "-Djava.awt.headless=true", "-cp"])
            .arg(cp)
            .arg(format!("com.cburch.logisim.file.{class}"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        Ok(cmd)
    }
}

/// The release app has no console, so each console child would open its own window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn collect_java(path: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let p = entry.map_err(|e| e.to_string())?.path();
        if p.is_dir() {
            collect_java(&p, out)?
        } else if p.extension().is_some_and(|e| e == "java") {
            out.push(p)
        }
    }
    Ok(())
}
