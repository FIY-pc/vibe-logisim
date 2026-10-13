use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt};

// Rust keeps canonical paths as document identities. Java 21's java.io.File
// cannot canonicalize Windows verbatim names, including classpath entries.
pub fn java_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let units: Vec<_> = path.as_os_str().encode_wide().collect();
        PathBuf::from(std::ffi::OsString::from_wide(&windows_path(&units)))
    }
    #[cfg(not(windows))]
    path.to_owned()
}

#[cfg(any(windows, test))]
fn windows_path(path: &[u16]) -> Vec<u16> {
    const PREFIX: &[u16] = &[92, 92, 63, 92];
    const UNC: &[u16] = &[85, 78, 67, 92];
    if let Some(tail) = path.strip_prefix(PREFIX) {
        if let Some(share) = tail.strip_prefix(UNC) {
            return [vec![92, 92], share.to_vec()].concat();
        }
        if tail.len() >= 3 && matches!(tail[0], 65..=90 | 97..=122) && tail[1..3] == [58, 92] {
            return tail.to_vec();
        }
    }
    path.to_vec()
}

#[derive(Clone)]
pub struct StderrTail(Arc<Mutex<VecDeque<u8>>>);
pub struct StderrCapture {
    pub tail: StderrTail,
    reader: Option<tokio::task::JoinHandle<()>>,
}
impl StderrCapture {
    pub fn start(mut stderr: impl AsyncRead + Unpin + Send + 'static) -> Self {
        let tail = StderrTail(Arc::new(Mutex::new(VecDeque::new())));
        let buffer = tail.0.clone();
        let reader = tokio::spawn(async move {
            let mut chunk = [0; 4096];
            while let Ok(count) = stderr.read(&mut chunk).await {
                if count == 0 {
                    break;
                }
                let mut bytes = buffer.lock().unwrap_or_else(|e| e.into_inner());
                bytes.extend(&chunk[..count]);
                let excess = bytes.len().saturating_sub(8192);
                bytes.drain(..excess);
            }
        });
        Self {
            tail,
            reader: Some(reader),
        }
    }
    pub async fn finish(&mut self) -> String {
        if let Some(mut reader) = self.reader.take()
            && tokio::time::timeout(Duration::from_secs(1), &mut reader)
                .await
                .is_err()
        {
            reader.abort();
        }
        self.tail.summary()
    }
}
impl Drop for StderrCapture {
    fn drop(&mut self) {
        if let Some(reader) = self.reader.take() {
            reader.abort();
        }
    }
}
impl StderrTail {
    pub fn summary(&self) -> String {
        let bytes: Vec<_> = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .copied()
            .collect();
        safe_stderr(&String::from_utf8_lossy(&bytes))
    }
}

fn class_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value.contains('.')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '$' | '_'))
}
fn runtime_class(value: &str) -> bool {
    class_name(value)
        && [
            "java.",
            "javax.",
            "jdk.",
            "sun.",
            "com.cburch.",
            "org.w3c.",
            "org.xml.",
        ]
        .iter()
        .any(|prefix| value.starts_with(prefix))
}

// Retain Java error classes and runtime startup diagnostics, not arbitrary
// loader output, environment values, paths, circuit labels or source contents.
fn safe_stderr(stderr: &str) -> String {
    stderr
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if [
                "Error occurred during initialization of VM",
                "Error occurred during initialization of boot layer",
                "Error: Could not find Java SE Runtime Environment.",
                "Error: could not find java.dll",
                "Error: Unable to resolve current executable",
                "Error: Path length exceeds maximum length (PATH_MAX)",
                "Error: String processing operation failed",
                "Error: Could not create the Java Virtual Machine.",
                "Error: A fatal exception has occurred. Program will exit.",
            ]
            .contains(&line)
            {
                return Some(line.to_owned());
            }
            if let Some(class) = line.strip_prefix("Error: Could not find or load main class ")
                && runtime_class(class)
            {
                return Some(format!("Main class unavailable: {class}"));
            }
            let line = line
                .strip_prefix("Caused by: ")
                .or_else(|| line.strip_prefix("Exception in thread \"main\" "))
                .unwrap_or(line);
            let (class, message) = line.split_once(':').unwrap_or((line, ""));
            if class_name(class) && (class.ends_with("Exception") || class.ends_with("Error")) {
                let message = message.trim();
                let missing_class = class.ends_with("ClassNotFoundException")
                    || class.ends_with("NoClassDefFoundError");
                return Some(if missing_class && runtime_class(message) {
                    format!("{class}: {message}")
                } else {
                    class.to_owned()
                });
            }
            None
        })
        .take(8)
        .collect::<Vec<_>>()
        .join("; ")
}

pub async fn exit_failure(
    child: &mut tokio::process::Child,
    stderr: &mut StderrCapture,
    label: &str,
) -> String {
    let status = tokio::time::timeout(Duration::from_secs(1), child.wait())
        .await
        .ok()
        .and_then(|r| r.ok());
    let code = status.map(|s| {
        s.code()
            .map(|code| format!("{code}, 0x{:08X}", code as u32))
            .unwrap_or_else(|| s.to_string())
    });
    let detail = stderr.finish().await;
    format!(
        "{label}{}{}",
        code.map(|v| format!("（退出码 {v}）")).unwrap_or_default(),
        if detail.is_empty() {
            let count = stderr
                .tail
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len();
            if count == 0 {
                "；stderr 为空".to_owned()
            } else {
                format!("；stderr 最后 {count} 字节不含可公开的运行时诊断")
            }
        } else {
            format!("；stderr: {detail}")
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn child_exit_fixture() {
        if std::env::var_os("VIBE_TEST_JAVA_EXIT").is_some() {
            eprintln!("Picked up JAVA_TOOL_OPTIONS: private-fixture-token");
            eprintln!(
                "Error: Could not find or load main class com.cburch.logisim.file.CircuitWorker"
            );
            eprintln!(
                "Caused by: java.lang.ClassNotFoundException: com.cburch.logisim.file.CircuitWorker"
            );
            std::process::exit(17);
        }
    }

    #[tokio::test]
    async fn exited_process_reports_code_and_safe_stderr() {
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "process::tests::child_exit_fixture",
                "--nocapture",
            ])
            .env("VIBE_TEST_JAVA_EXIT", "1")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stderr = StderrCapture::start(child.stderr.take().unwrap());
        let error = exit_failure(&mut child, &mut stderr, "Logisim 进程已退出").await;
        assert!(error.contains("17, 0x00000011"), "{error}");
        assert!(
            error.contains("ClassNotFoundException: com.cburch.logisim.file.CircuitWorker"),
            "{error}"
        );
        assert!(!error.contains("private-fixture-token"));
        // Re-reading a failed process must not poll an already consumed task.
        assert_eq!(
            error,
            exit_failure(&mut child, &mut stderr, "Logisim 进程已退出").await
        );
    }

    #[test]
    fn windows_java_arguments_preserve_disk_unc_and_unicode() {
        for (input, expected) in [
            (
                r"\\?\C:\Vibe resources\电路\classes",
                r"C:\Vibe resources\电路\classes",
            ),
            (
                r"\\?\UNC\server\share\电路.circ",
                r"\\server\share\电路.circ",
            ),
            (
                r"C:\already normal\test.circ",
                r"C:\already normal\test.circ",
            ),
            (r"relative\file.circ", r"relative\file.circ"),
            (r"\\?\Volume{opaque}\file", r"\\?\Volume{opaque}\file"),
        ] {
            assert_eq!(
                windows_path(&input.encode_utf16().collect::<Vec<_>>()),
                expected.encode_utf16().collect::<Vec<_>>()
            );
        }
    }
    #[test]
    fn windows_launcher_errors_are_visible_without_paths() {
        let detail = safe_stderr(
            "Error: could not find java.dll\nError: Could not find Java SE Runtime Environment.\nC:\\Users\\private\\java.dll\n",
        );
        assert_eq!(
            detail,
            "Error: could not find java.dll; Error: Could not find Java SE Runtime Environment."
        );
    }
    #[tokio::test]
    async fn stderr_is_bounded_and_excludes_private_payloads() {
        use tokio::io::AsyncWriteExt;
        let (mut writer, reader) = tokio::io::duplex(1024);
        let mut capture = StderrCapture::start(reader);
        let writing = tokio::spawn(async move {
            writer.write_all(&vec![b'x'; 50_000]).await.unwrap();
            writer.write_all(b"\nPicked up JAVA_TOOL_OPTIONS: secret-token\nError: Could not find or load main class com.cburch.logisim.file.CircuitWorker\nCaused by: java.lang.ClassNotFoundException: com.cburch.logisim.file.CircuitWorker\njava.io.FileNotFoundException: C:\\Users\\private\\source.circ\nloader: <project secret='hidden'/>\n").await.unwrap();
        });
        writing.await.unwrap();
        let detail = capture.finish().await;
        assert!(capture.tail.0.lock().unwrap().len() <= 8192);
        assert!(detail.contains("ClassNotFoundException"));
        assert!(detail.contains("CircuitWorker"));
        for forbidden in ["secret", "private", "source.circ", "project", "Users"] {
            assert!(!detail.contains(forbidden));
        }
    }
}
