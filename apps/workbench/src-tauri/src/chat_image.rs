use base64::{Engine, engine::general_purpose::STANDARD};
use std::{fs::File, io::Read, path::Path};

const MAX_BYTES: u64 = 8 * 1024 * 1024;

fn read_image(path: &Path) -> Result<serde_json::Value, String> {
    let file = File::open(path).map_err(|_| "无法读取图片文件")?;
    let metadata = file.metadata().map_err(|_| "无法读取图片文件")?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Err("图片超过 8 MB，或不是普通文件".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取图片文件")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("图片超过 8 MB，请缩小后重试".into());
    }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return Err("只支持 PNG、JPEG 和 WebP 图片".into());
    };
    Ok(serde_json::json!({
        "name": path.file_name().unwrap_or_default().to_string_lossy(),
        "mime": mime,
        "data": STANDARD.encode(bytes),
    }))
}

#[tauri::command]
pub async fn read_chat_image(path: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || read_image(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}
