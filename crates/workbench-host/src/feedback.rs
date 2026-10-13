//! Public release metadata and explicit, allowlisted diagnostic exports.
use crate::{Host, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use vibe_workspace_core::digest;
use xmltree::{Element, XMLNode};

const RELEASES: &str = "https://github.com/FIY-pc/vibe-logisim/releases";
const FEED: &str = "https://github.com/FIY-pc/vibe-logisim/releases.atom";
const MAX_FEED_BYTES: usize = 2 * 1024 * 1024;
const INTERVAL: u64 = 6 * 60 * 60;

#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct Preferences {
    enabled: Option<bool>,
    last_checked_at: Option<u64>,
    latest: Option<String>,
    dismissed_version: Option<String>,
}
pub(crate) struct Feedback {
    path: PathBuf,
    preferences: Preferences,
    error: Option<String>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn version(text: &str) -> Option<[u64; 3]> {
    let text = text.strip_prefix('v').unwrap_or(text);
    let parts: Vec<_> = text.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    Some([
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    ])
}
fn latest_release(bytes: &[u8]) -> Result<String> {
    if bytes.len() > MAX_FEED_BYTES {
        return Err("发布列表超过大小限制".into());
    }
    let feed = Element::parse(bytes).map_err(|_| "发布列表格式无法识别")?;
    if feed.name != "feed" {
        return Err("发布列表格式无法识别".into());
    }
    let mut latest = None;
    for entry in feed
        .children
        .iter()
        .filter_map(XMLNode::as_element)
        .filter(|entry| entry.name == "entry")
    {
        let Some(id) = entry.get_child("id").and_then(Element::get_text) else {
            continue;
        };
        let Some(tag) = id.rsplit('/').next() else {
            continue;
        };
        if let Some(parsed) = version(tag)
            && latest.is_none_or(|prior| parsed > prior)
        {
            latest = Some(parsed);
        }
    }
    latest
        .map(|[a, b, c]| format!("{a}.{b}.{c}"))
        .ok_or_else(|| "发布列表中没有可识别的版本".into())
}
fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().ok_or("保存目录不可用")?;
    std::fs::create_dir_all(parent).map_err(|_| "无法创建设置目录")?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法写入设置")?;
    serde_json::to_writer_pretty(&mut file, value).map_err(|_| "无法写入设置")?;
    file.as_file().sync_all().map_err(|_| "无法写入设置")?;
    file.persist(path).map_err(|_| "无法保存设置")?;
    Ok(())
}
impl Feedback {
    pub fn new(state: &Path) -> Self {
        let path = state.join("feedback.json");
        let preferences = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            path,
            preferences,
            error: None,
        }
    }
    pub fn status(&self) -> Value {
        let current = env!("CARGO_PKG_VERSION");
        let latest = self
            .preferences
            .latest
            .as_deref()
            .filter(|latest| version(latest).is_some());
        let development = version(current).is_none();
        let newer = version(current)
            .zip(latest.and_then(version))
            .is_some_and(|(current, latest)| latest > current);
        json!({"enabled":self.preferences.enabled.unwrap_or(true),"forcedOff":std::env::var("VIBE_LOGISIM_NO_UPDATE_CHECK").is_ok_and(|value|value=="1"),"current":current,"development":development,"latest":latest,"url":latest.map(|tag|format!("{RELEASES}/tag/v{tag}")),"lastCheckedAt":self.preferences.last_checked_at,"dismissedVersion":self.preferences.dismissed_version,"newer":newer,"available":newer && latest != self.preferences.dismissed_version.as_deref(),"error":self.error})
    }
    pub fn preference(&mut self, enabled: bool) -> Result<Value> {
        self.preferences.enabled = Some(enabled);
        atomic_json(&self.path, &self.preferences)?;
        Ok(self.status())
    }
    pub fn dismiss(&mut self, value: String) -> Result<Value> {
        if version(&value).is_none() {
            return Err("版本号无效".into());
        }
        self.preferences.dismissed_version = Some(value);
        atomic_json(&self.path, &self.preferences)?;
        Ok(self.status())
    }
    pub async fn check(&mut self, manual: bool) -> Value {
        let state = self.status();
        if state["forcedOff"] == true
            || (!manual
                && (state["enabled"] == false
                    || self
                        .preferences
                        .last_checked_at
                        .is_some_and(|last| now().saturating_sub(last) < INTERVAL)))
        {
            return state;
        }
        self.error = None;
        match download().await.and_then(|bytes| latest_release(&bytes)) {
            Ok(latest) => {
                self.preferences.latest = Some(latest);
                self.preferences.last_checked_at = Some(now());
                if let Err(error) = atomic_json(&self.path, &self.preferences) {
                    self.error = Some(error);
                }
            }
            Err(error) => self.error = Some(error),
        }
        self.status()
    }
}
async fn download() -> Result<Vec<u8>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("Vibe-Logisim/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "无法初始化更新检查")?;
    let mut response = client
        .get(FEED)
        .header("Accept", "application/atom+xml")
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "检查更新超时"
            } else {
                "无法连接 GitHub"
            }
        })?;
    if !response.status().is_success() {
        return Err(format!("GitHub 返回 HTTP {}", response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_FEED_BYTES as u64)
    {
        return Err("发布列表超过大小限制".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "发布列表读取失败")? {
        if bytes.len().saturating_add(chunk.len()) > MAX_FEED_BYTES {
            return Err("发布列表超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Diagnostics {
    schema: u8,
    app_version: String,
    platform: String,
    architecture: String,
    native_runtime_available: bool,
    simulation_active: bool,
    recovery_issue: bool,
    #[serde(default)]
    runtime_version: Option<String>,
    #[serde(default)]
    failures: Vec<crate::diagnostics::FailureCount>,
}
fn validated_report(report: Value) -> Result<Vec<u8>> {
    let report: Diagnostics =
        serde_json::from_value(report).map_err(|_| "诊断预览已失效，请重新打开")?;
    if report.schema != 1
        || report.app_version != env!("CARGO_PKG_VERSION")
        || report.platform != std::env::consts::OS
        || report.architecture != std::env::consts::ARCH
    {
        return Err("诊断预览已失效，请重新打开".into());
    }
    if report.failures.len() > 128
        || report.runtime_version.as_ref().is_some_and(|version| {
            version.is_empty()
                || version.len() > 64
                || !version
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b))
        })
    {
        return Err("诊断预览已失效，请重新打开".into());
    }
    let value = serde_json::to_value(report).map_err(|_| "无法生成诊断")?;
    let mut bytes = serde_json::to_vec_pretty(&value).map_err(|_| "无法生成诊断")?;
    bytes.push(b'\n');
    Ok(bytes)
}
impl Host {
    pub(crate) async fn diagnostics(&self) -> Value {
        let native = self.native.lock().await;
        json!({"schema":1,"appVersion":env!("CARGO_PKG_VERSION"),"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,"nativeRuntimeAvailable":native.runtime().is_ok(),"simulationActive":native.simulation.is_some(),"recoveryIssue":self.recovery_error.is_some(),"runtimeVersion":native.observed_version(),"failures":self.failures.lock().await.report()})
    }
    pub(crate) fn diagnostics_export(
        &self,
        path: PathBuf,
        report: Value,
        expected_revision: Option<String>,
    ) -> Result<Value> {
        let bytes = validated_report(report)?;
        if path.extension().is_none_or(|extension| extension != "json") {
            return Err("请以 .json 保存诊断".into());
        }
        let parent = path
            .parent()
            .ok_or("请选择保存目录")?
            .canonicalize()
            .map_err(|_| "保存目录不可用")?;
        let path = parent.join(path.file_name().ok_or("请选择文件名")?);
        let check = || -> Result<()> {
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) => {
                    if !metadata.is_file() || metadata.len() > 32 * 1024 * 1024 {
                        return Err("请选择普通 JSON 文件".into());
                    }
                    let current = std::fs::read(&path).map_err(|_| "无法读取目标文件")?;
                    if expected_revision.as_deref() != Some(digest(&current).as_str()) {
                        return Err("目标文件已存在或已经改变，请重新选择保存位置".into());
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    if expected_revision.is_some() {
                        return Err("目标文件已经改变，请重新选择保存位置".into());
                    }
                }
                Err(_) => return Err("无法检查目标文件".into()),
            }
            Ok(())
        };
        check()?;
        let mut file = tempfile::NamedTempFile::new_in(&parent).map_err(|_| "无法写入诊断")?;
        file.write_all(&bytes).map_err(|_| "无法写入诊断")?;
        file.as_file().sync_all().map_err(|_| "无法写入诊断")?;
        check()?;
        if expected_revision.is_some() {
            file.persist(&path).map_err(|_| "无法保存诊断")?;
        } else {
            file.persist_noclobber(&path)
                .map_err(|_| "目标文件已出现，请重新选择保存位置")?;
        }
        Ok(json!({"saved":true,"bytes":bytes.len()}))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn releases_are_numeric_and_links_are_constructed() {
        let data=br#"<feed><entry><id>tag:github.com,2008:Repository/1/v0.5.0</id></entry><entry><id>tag:github.com,2008:Repository/1/v0.4.2</id></entry><entry><id>tag:github.com,2008:Repository/1/build-inputs</id></entry><entry><id>tag:github.com,2008:Repository/1/v0.6.0-dev</id></entry></feed>"#;
        assert_eq!(latest_release(data).unwrap(), "0.5.0");
        assert!(version("0.6.0-dev").is_none());
        assert!(version("1.2.3/../../foo").is_none());
        assert!(latest_release(&vec![b' '; MAX_FEED_BYTES + 1]).is_err());
    }
    #[test]
    fn reports_reject_private_fields_and_changed_targets() {
        let directory = tempfile::tempdir().unwrap();
        let host = Host::new(
            directory.path().into(),
            directory.path().join("state"),
            None,
        )
        .unwrap();
        let report = json!({"schema":1,"appVersion":env!("CARGO_PKG_VERSION"),"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,"nativeRuntimeAvailable":false,"simulationActive":false,"recoveryIssue":false});
        let mut injected = report.clone();
        injected["path"] = json!("private");
        assert!(validated_report(injected).is_err());
        let path = directory.path().join("diagnostics.json");
        host.diagnostics_export(path.clone(), report.clone(), None)
            .unwrap();
        assert_eq!(
            std::fs::read(&path).unwrap(),
            validated_report(report.clone()).unwrap()
        );
        assert!(
            host.diagnostics_export(path.clone(), report.clone(), None)
                .is_err()
        );
        let revision = digest(&std::fs::read(&path).unwrap());
        std::fs::write(&path, b"external change").unwrap();
        assert!(
            host.diagnostics_export(path.clone(), report.clone(), Some(revision))
                .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"external change");
        let revision = digest(&std::fs::read(&path).unwrap());
        host.diagnostics_export(path, report, Some(revision))
            .unwrap();
    }
}
