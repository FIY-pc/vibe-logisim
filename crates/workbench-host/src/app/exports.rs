//! Selected conversation archives use the same ZIP/save path as project exports.
use crate::{
    AgentRequest, Host, Result,
    documents::project_info::{export_target, filename},
};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde_json::{Value, json};
use std::{
    fs::File,
    io::{Cursor, Read, Seek, Write},
    path::{Path, PathBuf},
};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

pub(crate) fn save_archive(
    path: &Path,
    bytes: &[u8],
    expected_revision: Option<&str>,
) -> Result<()> {
    save_archive_reader(path, &mut Cursor::new(bytes), expected_revision)
}

fn save_archive_reader(
    path: &Path,
    source: &mut impl Read,
    expected_revision: Option<&str>,
) -> Result<()> {
    if path
        .extension()
        .is_none_or(|ext| !ext.eq_ignore_ascii_case("zip"))
    {
        return Err("请以 .zip 保存".into());
    }
    let parent = path
        .parent()
        .ok_or("请选择保存目录")?
        .canonicalize()
        .map_err(|_| "保存目录不可用")?;
    let path = parent.join(path.file_name().ok_or("请选择文件名")?);
    let check = || -> Result<()> {
        if export_target(&path)?["revision"].as_str() != expected_revision {
            return Err("目标文件已存在或已经改变，请重新选择保存位置".into());
        }
        Ok(())
    };
    check()?;
    let mut temp = crate::staged_user_file(&parent).map_err(|_| "无法创建导出文件")?;
    std::io::copy(source, &mut temp).map_err(|_| "无法写入导出文件")?;
    temp.as_file().sync_all().map_err(|_| "无法写入导出文件")?;
    check()?;
    if expected_revision.is_some() {
        temp.persist(&path).map_err(|_| "无法替换导出文件")?;
    } else {
        temp.persist_noclobber(&path)
            .map_err(|_| "目标文件已出现，请重新选择保存位置")?;
    }
    Ok(())
}

/// Paths embedded in tool text are never file authority. Resolve only generated
/// names under this conversation's persistent store, rejecting symlink escapes.
fn output_file(state: &Path, conversation: &str, id: &str) -> Result<File> {
    let valid_uuid =
        |value: &str| uuid::Uuid::parse_str(value).is_ok_and(|uuid| uuid.to_string() == value);
    let (stem, extension) = id.rsplit_once('.').ok_or("工具输出编号无效")?;
    if !valid_uuid(conversation) || !valid_uuid(stem) || !matches!(extension, "txt" | "json") {
        return Err("工具输出编号无效".into());
    }
    let mut path = state.canonicalize().map_err(|_| "工具输出目录不可用")?;
    for part in ["tool-outputs", conversation, id] {
        path.push(part);
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|_| format!("工具输出 {id} 缺失或不可读取"))?;
        if meta.file_type().is_symlink()
            || (part != id && !meta.is_dir())
            || (part == id && !meta.is_file())
        {
            return Err("工具输出路径无效".into());
        }
    }
    File::open(path).map_err(|_| format!("工具输出 {id} 无法读取").into())
}

impl Host {
    pub(crate) async fn conversation_export(
        &self,
        workspace_key: String,
        ids: Vec<String>,
        path: Option<PathBuf>,
        expected_revision: Option<String>,
    ) -> Result<Value> {
        let export_id = uuid::Uuid::new_v4().to_string();
        let snapshot = self
            .state
            .join("conversation-exports")
            .join(format!("{export_id}.json"));
        let reply = self
            .agent_request(AgentRequest::Agent {
                method: "exportConversations".into(),
                args: json!({"workspaceKey":workspace_key,"ids":ids,"exportId":export_id}),
            })
            .await;
        let data = if reply.is_ok() {
            std::fs::read(&snapshot)
        } else {
            Ok(Vec::new())
        };
        let _ = std::fs::remove_file(&snapshot);
        reply?;
        let data = data.map_err(|_| "无法读取导出的会话")?;
        let snapshot: Value = serde_json::from_slice(&data).map_err(|_| "无法读取导出的会话")?;
        let conversations = snapshot["conversations"]
            .as_array()
            .ok_or("会话导出内容无效")?;
        let exported_at = snapshot["exportedAt"].as_str().unwrap_or_default();
        let version = env!("CARGO_PKG_VERSION");
        let archive = tempfile::tempfile().map_err(|_| "无法创建会话压缩包")?;
        let mut zip = ZipWriter::new(archive);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        let mut index = format!(
            "# 导出的会话\n\nVibe Logisim {version}\n\n导出时间：{exported_at}\n\n共 {} 条已选择的会话。每个目录中的 conversation.md 可直接阅读；conversation.json 保留完整结构化记录。\n\n文件包含这些会话的消息、思考摘要、工具参数、结果和内容中引用的资料；不包含账号配置或凭据文件。正在进行的会话保留导出时已有的内容。\n\n",
            conversations.len()
        );
        for (number, item) in conversations.iter().enumerate() {
            let record = &item["conversation"];
            let title = record["title"].as_str().unwrap_or("会话");
            let directory = format!("{:04}-{}", number + 1, filename(title, "conversation"));
            index.push_str(&format!("- {directory}/\n"));
            let envelope = json!({"schema":"vibe-logisim.conversation-export/v1","appVersion":version,"exportedAt":exported_at,"conversation":record});
            let json = serde_json::to_vec_pretty(&envelope).map_err(|_| "无法生成会话记录")?;
            let markdown = format!(
                "Vibe Logisim {version}\n\n{}",
                item["markdown"].as_str().ok_or("会话记录无效")?
            );
            for (name, bytes) in [
                ("conversation.json", json.as_slice()),
                ("conversation.md", markdown.as_bytes()),
            ] {
                zip.start_file(format!("{directory}/{name}"), options)
                    .map_err(|_| "无法生成会话压缩包")?;
                zip.write_all(bytes).map_err(|_| "无法写入会话压缩包")?;
            }
            if let Some(outputs) = record["outputArtifacts"].as_array() {
                let conversation_id = record["id"].as_str().ok_or("会话编号无效")?;
                for artifact in outputs {
                    let id = artifact["id"].as_str().ok_or("工具输出编号无效")?;
                    let mut file = output_file(&self.state, conversation_id, id)?;
                    let expected = artifact["bytes"].as_u64().ok_or("工具输出大小无效")?;
                    if file.metadata().map_err(|_| "无法读取工具输出")?.len() != expected {
                        return Err(format!("工具输出 {id} 已改变，请重新导出").into());
                    }
                    zip.start_file(format!("{directory}/outputs/{id}"), options)
                        .map_err(|_| "无法生成会话压缩包")?;
                    if std::io::copy(&mut file, &mut zip).map_err(|_| "无法写入工具输出")?
                        != expected
                    {
                        return Err(format!("工具输出 {id} 已改变，请重新导出").into());
                    }
                }
            }
        }
        zip.start_file("README.md", options)
            .map_err(|_| "无法生成会话压缩包")?;
        zip.write_all(index.as_bytes())
            .map_err(|_| "无法写入会话压缩包")?;
        let mut archive = zip.finish().map_err(|_| "无法完成会话压缩包")?;
        let length = archive.metadata().map_err(|_| "无法读取会话压缩包")?.len();
        archive.rewind().map_err(|_| "无法读取会话压缩包")?;
        let date = exported_at.split('T').next().unwrap_or("export");
        let name = format!("conversations-{date}.zip");
        if let Some(path) = path {
            save_archive_reader(&path, &mut archive, expected_revision.as_deref())?;
            Ok(json!({"saved":true,"name":name,"bytes":length,"count":conversations.len()}))
        } else {
            let mut bytes = Vec::new();
            archive
                .read_to_end(&mut bytes)
                .map_err(|_| "无法读取会话压缩包")?;
            Ok(json!({"name":name,"data":B64.encode(bytes),"count":conversations.len()}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_export_paths() {
        let state = tempfile::tempdir().unwrap();
        let conversation = uuid::Uuid::new_v4().to_string();
        let id = format!("{}.txt", uuid::Uuid::new_v4());
        let root = state.path().join("tool-outputs").join(&conversation);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(&id), "saved output").unwrap();
        assert!(output_file(state.path(), &conversation, &id).is_ok());
        assert!(output_file(state.path(), "../profile", &id).is_err());
        assert!(output_file(state.path(), &conversation, &format!("../{id}")).is_err());
        assert!(output_file(state.path(), &conversation, "missing.txt").is_err());
        assert!(output_file(state.path(), &conversation, &id.replace(".txt", ".zip")).is_err());
        #[cfg(unix)]
        {
            let escaped = format!("{}.json", uuid::Uuid::new_v4());
            std::os::unix::fs::symlink(root.join(&id), root.join(&escaped)).unwrap();
            assert!(output_file(state.path(), &conversation, &escaped).is_err());
            let other = uuid::Uuid::new_v4().to_string();
            std::os::unix::fs::symlink(&root, state.path().join("tool-outputs").join(&other))
                .unwrap();
            assert!(output_file(state.path(), &other, &id).is_err());
        }
    }
}
