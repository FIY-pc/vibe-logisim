//! Portable source packages are frozen from the requested draft, never from a stale disk copy.
use crate::{Host, Result, simulation::observations::ObservationRecord};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
};
use vibe_circuit_document::{Document, digest};
use xmltree::Element;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};
const FILE_LIMIT: u64 = 32 * 1024 * 1024;
const PACKAGE_LIMIT: usize = 256 * 1024 * 1024;
struct Package {
    entries: BTreeMap<String, Vec<u8>>,
    known: BTreeMap<PathBuf, String>,
    libraries: Vec<Value>,
    issues: Vec<String>,
    total: usize,
    next: usize,
    depth: usize,
    main: String,
}
fn filename(name: &str, fallback: &str) -> String {
    let name = name.rsplit(['/', '\\']).next().unwrap_or(fallback);
    let mut safe: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*#".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    safe = safe.trim_end_matches([' ', '.']).to_owned();
    if safe.len() > 180 {
        let extension = Path::new(&safe)
            .extension()
            .and_then(|s| s.to_str())
            .filter(|s| s.len() <= 10)
            .map(|s| format!(".{s}"));
        while safe.len() > 168 {
            safe.pop();
        }
        if let Some(extension) = extension {
            safe.push_str(&extension);
        }
    }
    let stem = safe.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        safe.insert(0, '_');
    }
    if safe.is_empty() || safe == "." || safe == ".." {
        fallback.into()
    } else {
        safe
    }
}
fn read_library(path: &Path) -> Result<Vec<u8>> {
    let file = std::fs::File::open(path).map_err(|_| "无法读取组件库")?;
    let meta = file.metadata().map_err(|_| "无法检查组件库")?;
    if !meta.is_file() || meta.len() > FILE_LIMIT {
        return Err("组件库不是普通文件或超过 32 MB".into());
    }
    let mut bytes = Vec::new();
    file.take(FILE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取组件库")?;
    if bytes.len() as u64 > FILE_LIMIT {
        return Err("组件库超过 32 MB".into());
    }
    Ok(bytes)
}
impl Package {
    fn new(doc: &Document) -> Result<Self> {
        let mut name = filename(&doc.view().map_err(|e| e.to_string())?.name, "circuit.circ");
        if !name.to_ascii_lowercase().ends_with(".circ") {
            name.push_str(".circ");
        }
        let main = format!("project/{name}");
        let mut package = Self {
            entries: BTreeMap::new(),
            known: BTreeMap::new(),
            libraries: vec![],
            issues: vec![],
            total: doc.bytes().len(),
            next: 0,
            depth: 0,
            main: main.clone(),
        };
        if let Some(path) = &doc.path {
            package.known.insert(path.clone(), main.clone());
        }
        let bytes = package.circuit(
            doc.bytes(),
            doc.path.as_deref().and_then(Path::parent),
            &main,
        )?;
        package.entries.insert(main, bytes);
        Ok(package)
    }
    fn add_json(&mut self, name: String, value: &impl serde::Serialize) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(value).map_err(|_| "无法保存工程记录")?;
        if bytes.len() as u64 > FILE_LIMIT {
            return Err("单份工程记录超过 32 MB".into());
        }
        let size = self.entries.values().map(Vec::len).sum::<usize>();
        if size.saturating_add(bytes.len()) > PACKAGE_LIMIT {
            return Err("工程包超过 256 MB".into());
        }
        if self.entries.contains_key(&name) {
            return Err("工程记录标识重复，未导出".into());
        }
        self.entries.insert(name, bytes);
        Ok(())
    }
    fn evidence(
        &mut self,
        id: &str,
        revision: &str,
        observations: Vec<ObservationRecord>,
    ) -> Result<()> {
        let mut observation_count = 0;
        for mut record in observations
            .into_iter()
            .filter(|record| record.document_id == id && record.revision == revision)
        {
            let record_id =
                uuid::Uuid::parse_str(&record.id).map_err(|_| "观察记录标识无效，未导出")?;
            // A simulator exception may contain a local runtime path. Keep the
            // failure visible without publishing its raw exception text.
            if let Some(failure) = &mut record.frame.clock.failure {
                failure.message = "仿真故障".into();
            }
            self.add_json(format!("observations/{record_id}.json"), &record)?;
            observation_count += 1;
        }
        self.add_json(
            "project-version.json".into(),
            &json!({
                "schemaVersion":1,
                "documentId":id,
                "sourceRevision":revision,
                "entry":self.main,
                "artifactSha256":digest(&self.entries[&self.main]),
                "evidence":{
                    "revision":revision,
                    "scope":"sourceRevision",
                    "exportedContentVerified":false,
                    "observationCount":observation_count
                }
            }),
        )
    }
    fn circuit(&mut self, bytes: &[u8], base: Option<&Path>, entry: &str) -> Result<Vec<u8>> {
        if self.depth >= 32 {
            return Err("组件库嵌套超过 32 层".into());
        }
        self.depth += 1;
        let result = (|| -> Result<Vec<u8>> {
            let mut tree = Element::parse(bytes).map_err(|_| "组件库电路格式无效")?;
            if tree.name != "project" {
                return Err("组件库不是 Logisim 电路".into());
            }
            for node in &mut tree.children {
                let Some(lib) = node.as_mut_element().filter(|n| n.name == "lib") else {
                    continue;
                };
                let Some(desc) = lib.attributes.get("desc").cloned() else {
                    continue;
                };
                if desc.starts_with('#') {
                    continue;
                }
                let result = self.dependency(&desc, base, entry);
                match result {
                    Ok((rewritten, info)) => {
                        lib.attributes.insert("desc".into(), rewritten);
                        if let Some(info) = info {
                            self.libraries.push(info);
                        }
                    }
                    Err(error) => {
                        let name = filename(desc.split('#').nth(1).unwrap_or(&desc), "组件库");
                        self.issues.push(format!("{name}：{error}"));
                        self.libraries.push(
                            json!({"name":name,"kind":"external","available":false,"error":error.to_string()}),
                        );
                    }
                }
            }
            Ok(vibe_logisim_runtime::encode_xml(&tree)?)
        })();
        self.depth -= 1;
        result
    }
    fn dependency(
        &mut self,
        desc: &str,
        base: Option<&Path>,
        entry: &str,
    ) -> Result<(String, Option<Value>)> {
        let (kind, rest) = desc.split_once('#').ok_or("无法识别组件库引用")?;
        if !matches!(kind, "jar" | "file") {
            return Err("无法打包这种组件库引用".into());
        }
        let (source, suffix) = rest
            .split_once('#')
            .map(|(a, b)| (a, format!("#{b}")))
            .unwrap_or((rest, String::new()));
        let expected = if kind == "jar" { "jar" } else { "circ" };
        let name = filename(source, "library");
        if Path::new(&name)
            .extension()
            .is_none_or(|ext| !ext.eq_ignore_ascii_case(expected))
        {
            return Err(format!("需要 .{expected} 组件库").into());
        }
        let source = Path::new(source);
        let candidate = if source.is_absolute() {
            source.to_owned()
        } else {
            base.ok_or("先保存电路以定位相对组件库")?.join(source)
        };
        let path = candidate.canonicalize().map_err(|_| "组件库文件不存在")?;
        let (target, info) = if let Some(existing) = self.known.get(&path) {
            (existing.clone(), None)
        } else {
            if self.next >= 1000 {
                return Err("组件库数量超过限制".into());
            }
            let bytes = read_library(&path)?;
            self.total = self
                .total
                .checked_add(bytes.len())
                .ok_or("工程包超过大小限制")?;
            if self.total > PACKAGE_LIMIT {
                return Err("工程包超过 256 MB".into());
            }
            self.next += 1;
            let target = format!("project/libraries/{}-{name}", self.next);
            self.known.insert(path.clone(), target.clone());
            let content = if kind == "file" {
                self.circuit(&bytes, path.parent(), &target)?
            } else {
                bytes
            };
            self.entries.insert(target.clone(), content);
            (
                target,
                Some(json!({"name":name,"kind":kind,"available":true})),
            )
        };
        let parent = Path::new(entry).parent().ok_or("工程包路径无效")?;
        // The archive layout has only project/ and project/libraries/; references remain relative.
        let reference = if parent == Path::new("project") {
            target.strip_prefix("project/").unwrap().to_owned()
        } else if let Some(name) = target.strip_prefix("project/libraries/") {
            name.to_owned()
        } else {
            format!("../{}", target.strip_prefix("project/").unwrap())
        };
        Ok((format!("{kind}#{reference}{suffix}"), info))
    }
    fn archive(&self) -> Result<Vec<u8>> {
        if !self.issues.is_empty() {
            return Err(self.issues.join("\n").into());
        }
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);
        for (name, bytes) in &self.entries {
            zip.start_file(name, options)
                .map_err(|_| "无法创建工程包")?;
            zip.write_all(bytes).map_err(|_| "无法写入工程包")?;
        }
        zip.finish()
            .map(|cursor| cursor.into_inner())
            .map_err(|_| "无法完成工程包".into())
    }
}
pub(crate) fn export_target(path: &Path) -> Result<Value> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.len() > PACKAGE_LIMIT as u64 {
                return Err("请选择普通 ZIP 文件".into());
            }
            let bytes = std::fs::read(path).map_err(|_| "无法读取目标文件")?;
            Ok(json!({"revision":digest(&bytes)}))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({"revision":null})),
        Err(_) => Err("无法检查保存位置".into()),
    }
}
impl Host {
    pub(crate) async fn project_info(&self, id: &str, revision: &str) -> Result<Value> {
        let doc = self
            .workspace
            .lock()
            .await
            .get(id)
            .map_err(|e| e.to_string())?
            .clone();
        doc.check(revision).map_err(|e| e.to_string())?;
        let view = doc.view().map_err(|e| e.to_string())?;
        let package = Package::new(&doc)?;
        let native = self.native.lock().await;
        let runtime_available = native.runtime().is_ok();
        Ok(
            json!({"documentId":id,"revision":revision,"name":view.name,"path":view.path,"dirty":view.dirty,"circuits":view.circuits.len(),"builtInLibraries":view.libraries.iter().filter(|l|l.descriptor.starts_with('#')).count(),"libraries":package.libraries,"issues":package.issues,"exportable":package.issues.is_empty(),"runtimeAvailable":runtime_available,"runtimeVersion":native.observed_version(),"sourceStatus":doc.source_status(),"entry":package.main}),
        )
    }
    pub(crate) async fn project_export(
        &self,
        id: &str,
        revision: &str,
        path: Option<&Path>,
        expected_revision: Option<&str>,
    ) -> Result<Value> {
        let doc = self
            .workspace
            .lock()
            .await
            .get(id)
            .map_err(|e| e.to_string())?
            .clone();
        doc.check(revision).map_err(|e| e.to_string())?;
        let mut package = Package::new(&doc)?;
        let observations = self.observation_records(id).await?;
        package.evidence(id, revision, observations)?;
        let bytes = package.archive()?;
        // Bind publication to the exact draft reviewed when export was requested.
        let workspace = self.workspace.lock().await;
        workspace
            .get(id)
            .map_err(|e| e.to_string())?
            .check(revision)
            .map_err(|e| e.to_string())?;
        let name = format!(
            "{}.zip",
            filename(
                doc.view()
                    .map_err(|e| e.to_string())?
                    .name
                    .trim_end_matches(".circ"),
                "circuit"
            )
        );
        let Some(path) = path else {
            return Ok(json!({"name":name,"data":B64.encode(bytes),"entry":package.main}));
        };
        if path
            .extension()
            .is_none_or(|ext| !ext.eq_ignore_ascii_case("zip"))
        {
            return Err("请以 .zip 保存工程包".into());
        }
        let parent = path
            .parent()
            .ok_or("请选择保存目录")?
            .canonicalize()
            .map_err(|_| "保存目录不可用")?;
        let path = parent.join(path.file_name().ok_or("请选择文件名")?);
        if doc.path.as_ref() == Some(&path) || package.known.contains_key(&path) {
            return Err("不能覆盖工程源文件或组件库".into());
        }
        let check = || -> Result<()> {
            if export_target(&path)?["revision"].as_str() != expected_revision {
                return Err("目标文件已存在或已经改变，请重新选择保存位置".into());
            }
            Ok(())
        };
        check()?;
        let mut temp = crate::staged_user_file(&parent).map_err(|_| "无法创建工程包文件")?;
        temp.write_all(&bytes).map_err(|_| "无法写入工程包")?;
        temp.as_file().sync_all().map_err(|_| "无法写入工程包")?;
        check()?;
        if expected_revision.is_some() {
            temp.persist(&path).map_err(|_| "无法替换工程包")?;
        } else {
            temp.persist_noclobber(&path)
                .map_err(|_| "目标文件已出现，请重新选择保存位置")?;
        }
        Ok(json!({"saved":true,"name":name,"bytes":bytes.len(),"entry":package.main}))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn circuit(libraries: &str, name: &str) -> Vec<u8> {
        format!(r##"<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/>{libraries}<main name="{name}"/><circuit name="{name}"/></project>"##).into_bytes()
    }
    #[test]
    fn archive_names_work_on_windows_and_keep_extensions() {
        assert_eq!(filename("CON.circ", "circuit.circ"), "_CON.circ");
        let name = filename(&format!("{}.jar", "库".repeat(100)), "library.jar");
        assert!(name.len() < 180);
        assert!(name.ends_with(".jar"));
    }
    #[test]
    fn archive_is_portable_and_freezes_draft_and_nested_dependencies() {
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("a.circ");
        let b = temp.path().join("b.circ");
        let jar = temp.path().join("logic.jar");
        std::fs::write(&jar, b"synthetic library bytes").unwrap();
        std::fs::write(
            &b,
            circuit(r#"<lib name="1" desc="jar#logic.jar#Logic"/>"#, "unit"),
        )
        .unwrap();
        let source = circuit(r#"<lib name="1" desc="file#b.circ"/>"#, "main");
        std::fs::write(&a, &source).unwrap();
        let draft = circuit(r#"<lib name="1" desc="file#b.circ"/>"#, "draft");
        let doc = Document::from_bytes("a.circ".into(), Some(a.clone()), draft, false).unwrap();
        let package = Package::new(&doc).unwrap();
        assert!(package.issues.is_empty());
        assert_eq!(package.libraries.len(), 2);
        let bytes = package.archive().unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut root = String::new();
        archive
            .by_name("project/a.circ")
            .unwrap()
            .read_to_string(&mut root)
            .unwrap();
        assert!(root.contains("draft"));
        assert!(root.contains("file#libraries/1-b.circ"));
        assert!(!root.contains(temp.path().to_str().unwrap()));
        let mut dependency = String::new();
        archive
            .by_name("project/libraries/1-b.circ")
            .unwrap()
            .read_to_string(&mut dependency)
            .unwrap();
        assert!(dependency.contains("jar#2-logic.jar#Logic"));
        let mut blob = Vec::new();
        archive
            .by_name("project/libraries/2-logic.jar")
            .unwrap()
            .read_to_end(&mut blob)
            .unwrap();
        assert_eq!(blob, b"synthetic library bytes");
        assert_eq!(std::fs::read(&a).unwrap(), source);
        std::fs::remove_file(&jar).unwrap();
        assert!(Package::new(&doc).unwrap().archive().is_err());
    }
    #[tokio::test]
    async fn export_guards_revision_and_target_without_saving_source() {
        let temp = tempfile::tempdir().unwrap();
        let host = Host::new(temp.path().into(), temp.path().join("state"), None).unwrap();
        let doc = host
            .dispatch(crate::DocumentRequest::New {
                name: "draft.circ".into(),
            })
            .await
            .unwrap();
        let id = doc["id"].as_str().unwrap();
        let rev = doc["revision"].as_str().unwrap();
        let target = temp.path().join("out.zip");
        assert!(
            host.project_export(id, "stale", Some(&target), None)
                .await
                .is_err()
        );
        assert!(!target.exists());
        host.project_export(id, rev, Some(&target), None)
            .await
            .unwrap();
        assert!(
            host.project_export(id, rev, Some(&target), None)
                .await
                .is_err()
        );
        let previous = export_target(&target).unwrap()["revision"]
            .as_str()
            .unwrap()
            .to_owned();
        std::fs::write(&target, b"new user content").unwrap();
        assert!(
            host.project_export(id, rev, Some(&target), Some(&previous))
                .await
                .is_err()
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"new user content");
        assert!(host.workspace.lock().await.get(id).unwrap().path.is_none());
    }
    #[tokio::test]
    async fn export_keeps_only_current_evidence_and_binds_source_and_packaged_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("state");
        let host = Host::new(temp.path().into(), state.clone(), None).unwrap();
        let source = temp.path().join("main.circ");
        let library = temp.path().join("part.circ");
        std::fs::write(&library, circuit("", "part")).unwrap();
        let original = circuit(r#"<lib name="1" desc="file#part.circ"/>"#, "main");
        std::fs::write(&source, &original).unwrap();
        let document = host
            .dispatch(crate::DocumentRequest::Open {
                path: source.clone(),
            })
            .await
            .unwrap();
        let id = document["id"].as_str().unwrap();
        let revision = document["revision"].as_str().unwrap();
        let observations = state.join("observations");
        std::fs::create_dir_all(&observations).unwrap();
        let other_document = uuid::Uuid::new_v4().to_string();
        let mut current_observation = String::new();
        for (index, (document_id, record_revision)) in [
            (id, revision),
            (id, "old-revision"),
            (other_document.as_str(), revision),
        ]
        .into_iter()
        .enumerate()
        {
            let record_id = uuid::Uuid::new_v4().to_string();
            if index == 0 {
                current_observation = format!("observations/{record_id}.json");
            }
            let observation = json!({
                "id":record_id,"documentId":document_id,"documentName":"main.circ",
                "documentPath":null,"revision":record_revision,"circuit":"main",
                "rootCircuit":"main","instancePath":[],"viewId":"fixture",
                "frameSequence":1,"createdAt":1.0,"title":"State",
                "signals":[{"key":"pin:0","label":"Q","bits":"1"}],
                "frame":{
                    "frameSequence":1,"commandSequence":1,"viewId":"fixture","circuit":"main",
                    "instancePath":[],
                    "clock":{"ticks":1,"running":false,"automatic":false,"pending":false,
                        "frequency":1.0,"actualFrequency":1.0,"oscillating":false,
                        "failure":{"code":"OSCILLATING","message":source}},
                    "components":[],
                    "image":{"width":1,"height":1,
                        "bounds":{"x":0.0,"y":0.0,"width":1.0,"height":1.0},"scale":1.0},
                    "timing":{"captureMs":0.0,"encodeMs":0.0},"at":1
                }
            });
            std::fs::write(
                observations.join(format!("{record_id}.json")),
                serde_json::to_vec(&observation).unwrap(),
            )
            .unwrap();
        }
        let result = host.project_export(id, revision, None, None).await.unwrap();
        let bytes = B64.decode(result["data"].as_str().unwrap()).unwrap();
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        assert_eq!(zip.len(), 4); // Main, library, current observation, manifest.
        let read_json = |zip: &mut zip::ZipArchive<Cursor<Vec<u8>>>, name: &str| {
            let mut bytes = Vec::new();
            zip.by_name(name).unwrap().read_to_end(&mut bytes).unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains(temp.path().to_str().unwrap()));
            serde_json::from_slice::<Value>(&bytes).unwrap()
        };
        let metadata = read_json(&mut zip, "project-version.json");
        assert_eq!(metadata["sourceRevision"], revision);
        assert_eq!(metadata["evidence"]["revision"], revision);
        assert_eq!(metadata["evidence"]["scope"], "sourceRevision");
        assert_eq!(metadata["evidence"]["exportedContentVerified"], false);
        assert_eq!(metadata["evidence"]["observationCount"], 1);
        assert!(zip.by_name("evidence/verification.json").is_err());
        let observed = read_json(&mut zip, &current_observation);
        assert_eq!(observed["signals"][0]["bits"], "1");
        assert_eq!(observed["frame"]["clock"]["failure"]["message"], "仿真故障");
        let mut packaged = Vec::new();
        zip.by_name("project/main.circ")
            .unwrap()
            .read_to_end(&mut packaged)
            .unwrap();
        assert_eq!(metadata["artifactSha256"], digest(&packaged));
        assert_ne!(metadata["artifactSha256"], revision);
        assert_eq!(std::fs::read(source).unwrap(), original);
    }
    #[tokio::test]
    #[ignore = "requires the installed compatibility JAR and JDK (npm run setup)"]
    async fn extracted_package_loads_in_logisim_without_original_sources() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        std::fs::create_dir(&source).unwrap();
        let library = circuit("", "unit");
        std::fs::write(source.join("part.circ"), library).unwrap();
        let original = circuit(r#"<lib name="1" desc="file#part.circ"/>"#, "main");
        std::fs::write(source.join("main.circ"), &original).unwrap();
        let doc = Document::from_bytes(
            "main.circ".into(),
            Some(source.join("main.circ")),
            original,
            false,
        )
        .unwrap();
        let package = Package::new(&doc).unwrap();
        let archive = package.archive().unwrap();
        let extracted = temp.path().join("elsewhere");
        zip::ZipArchive::new(Cursor::new(archive))
            .unwrap()
            .extract(&extracted)
            .unwrap();
        std::fs::remove_dir_all(&source).unwrap();
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .unwrap();
        let host = Host::new(root, temp.path().join("state"), None).unwrap();
        let opened = host
            .dispatch(crate::DocumentRequest::Open {
                path: extracted.join("project/main.circ"),
            })
            .await
            .unwrap();
        let id = opened["id"].as_str().unwrap();
        let revision = opened["revision"].as_str().unwrap();
        let observation = host
            .dispatch(crate::DocumentRequest::Observe {
                id: id.into(),
                revision: revision.into(),
                circuit: "main".into(),
            })
            .await
            .unwrap();
        assert!(observation["runtime"].is_object(), "{observation}");
        let catalog = host
            .dispatch(crate::DocumentRequest::Catalog {
                id: id.into(),
                revision: revision.into(),
                circuit: "main".into(),
            })
            .await
            .unwrap();
        assert!(catalog.to_string().contains("unit"));
        let info = host.project_info(id, revision).await.unwrap();
        assert!(info["runtimeVersion"].is_string(), "{info}");
        let failed = host
            .dispatch(crate::DocumentRequest::Render {
                id: id.into(),
                revision: revision.into(),
                circuit: "missing-circuit".into(),
                x: Some(0),
                y: Some(0),
                width: Some(320),
                height: Some(200),
                scale: Some(1.0),
            })
            .await;
        assert!(failed.is_err());
        let report = host.diagnostics().await;
        assert!(
            report["failures"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["stage"] == "render")
        );
        assert!(!report.to_string().contains(temp.path().to_str().unwrap()));
        assert!(!report.to_string().contains("missing-circuit"));
        host.shutdown().await;
    }
}
