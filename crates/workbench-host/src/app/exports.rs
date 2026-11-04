//! Selected conversation archives use the same ZIP/save path as project exports.
use crate::{
    AgentRequest, Host, Result,
    documents::project_info::{export_target, filename},
};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde_json::{Value, json};
use std::{
    io::{Cursor, Write},
    path::{Path, PathBuf},
};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

pub(crate) fn save_archive(
    path: &Path,
    bytes: &[u8],
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
    temp.write_all(bytes).map_err(|_| "无法写入导出文件")?;
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
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
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
            let record = json!({"schema":"vibe-logisim.conversation-export/v1","appVersion":version,"exportedAt":exported_at,"conversation":record});
            let json = serde_json::to_vec_pretty(&record).map_err(|_| "无法生成会话记录")?;
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
        }
        zip.start_file("README.md", options)
            .map_err(|_| "无法生成会话压缩包")?;
        zip.write_all(index.as_bytes())
            .map_err(|_| "无法写入会话压缩包")?;
        let bytes = zip.finish().map_err(|_| "无法完成会话压缩包")?.into_inner();
        let date = exported_at.split('T').next().unwrap_or("export");
        let name = format!("conversations-{date}.zip");
        if let Some(path) = path {
            save_archive(&path, &bytes, expected_revision.as_deref())?;
            Ok(json!({"saved":true,"name":name,"bytes":bytes.len(),"count":conversations.len()}))
        } else {
            Ok(json!({"name":name,"data":B64.encode(bytes),"count":conversations.len()}))
        }
    }
}
