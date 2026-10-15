use crate::{ErrorCode, Event, Host, HostError, Request};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, oneshot},
};
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<(Value, u64), HostError>>>>>;
pub struct Agent {
    child: Mutex<Child>,
    input: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    next: AtomicU64,
    events: Arc<Mutex<(u64, VecDeque<Value>)>>,
    pub alive: Arc<AtomicBool>,
}
impl Agent {
    pub fn start(root: &Path, state: &Path, host: Host) -> Result<Self, String> {
        let runtime_root = std::env::var_os("VIBE_LOGISIM_AGENT_ROOT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| root.into());
        let bundled = runtime_root.join("packages/agent-runtime/src/worker.mjs");
        let entry = if bundled.is_file() {
            bundled
        } else {
            runtime_root.join("packages/agent-runtime/src/worker.mts")
        };
        let bundled_node = root.join(if cfg!(windows) {
            "runtimes/node/node.exe"
        } else {
            "runtimes/node/node"
        });
        let executable = std::env::var_os("VIBE_LOGISIM_NODE")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                if bundled_node.is_file() {
                    bundled_node
                } else {
                    "node".into()
                }
            });
        let mut command = Command::new(executable);
        command
            .arg("--use-env-proxy")
            .arg(entry)
            .arg(state)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        // The release app has no console; without this flag Node opens its own window.
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let mut child = command
            .spawn()
            .map_err(|e| format!("AI 运行时启动失败: {e}"))?;
        let input = Arc::new(Mutex::new(child.stdin.take().ok_or("AI stdin 不可用")?));
        let mut lines = BufReader::new(child.stdout.take().ok_or("AI stdout 不可用")?).lines();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let sequence = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
            * 1000;
        let events = Arc::new(Mutex::new((sequence, VecDeque::new())));
        let alive = Arc::new(AtomicBool::new(true));
        let connected = alive.clone();
        let output = input.clone();
        let awaiting = pending.clone();
        let observed = events.clone();
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                if line.len() > 32 * 1024 * 1024 {
                    break;
                }
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                match message["kind"].as_str() {
                    Some("result") => {
                        if let Some(id) = message["id"].as_u64()
                            && let Some(tx) = awaiting.lock().await.remove(&id)
                        {
                            let _ = tx.send(match &message["error"] {
                                Value::Null => {
                                    Ok((message["result"].clone(), observed.lock().await.0))
                                }
                                Value::String(error) => Err(error.clone().into()),
                                error => Err(serde_json::from_value(error.clone())
                                    .unwrap_or_else(|_| error.to_string().into())),
                            });
                        }
                    }
                    Some("event") => {
                        let mut queue = observed.lock().await;
                        queue.0 += 1;
                        let sequence = queue.0;
                        queue
                            .1
                            .push_back(json!({"sequence":sequence,"event":message["event"]}));
                        host.emit(Event::Agent(
                            json!({"sequence":sequence,"event":message["event"]}),
                        ));
                        while queue.1.len() > 2048 {
                            queue.1.pop_front();
                        }
                    }
                    Some("host") => {
                        // Keep reading events and stop replies while a native tool is running.
                        let host = host.clone();
                        let output = output.clone();
                        tokio::spawn(async move {
                            const OUTSIDE: &str = "AI 请求不在电路能力范围内";
                            let result = match Request::from_value(message["request"].clone()) {
                                Ok(request) if request.meta().agent => host.dispatch(request).await,
                                Ok(_) => Err(HostError::new(ErrorCode::NotAllowed, OUTSIDE)),
                                Err(error) => Err(HostError::new(ErrorCode::InvalidInput, OUTSIDE)
                                    .with_context(json!({"detail": error.message}))),
                            };
                            let reply = match result {
                                Ok(result) => {
                                    json!({"kind":"hostResult","id":message["id"],"result":result})
                                }
                                Err(error) => {
                                    json!({"kind":"hostResult","id":message["id"],"error":error})
                                }
                            };
                            let mut output = output.lock().await;
                            let _ = output
                                .write_all((reply.to_string() + "\n").as_bytes())
                                .await;
                            let _ = output.flush().await;
                        });
                    }
                    _ => {}
                }
            }
            for (_, tx) in awaiting.lock().await.drain() {
                let _ = tx.send(Err("AI 运行时已退出".into()));
            }
            connected.store(false, Ordering::Release);
            if !*host.stopping.borrow() {
                host.failures
                    .lock()
                    .await
                    .record(crate::diagnostics::Stage::Agent, "AI 运行时已退出");
            }
            let mut queue = observed.lock().await;
            queue.0 += 1;
            let sequence = queue.0;
            let event = json!({"sequence":sequence,"event":{"type":"runtime-error","message":"AI 运行时已退出，可重新连接；已有对话保留"}});
            queue.1.push_back(event.clone());
            host.emit(Event::Agent(event));
        });
        Ok(Self {
            child: Mutex::new(child),
            input,
            pending,
            next: AtomicU64::new(1),
            events,
            alive,
        })
    }
    pub async fn shutdown(&self) {
        let _ = self.input.lock().await.shutdown().await;
        let mut child = self.child.lock().await;
        if tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
    }
    pub async fn call(&self, method: &str, args: Value) -> Result<Value, HostError> {
        if method == "events" {
            let since = args["since"].as_u64().unwrap_or(0);
            let queue = self.events.lock().await;
            return Ok(
                json!({"cursor":queue.0,"events":queue.1.iter().filter(|e|e["sequence"].as_u64().unwrap_or(0)>since).collect::<Vec<_>>()}),
            );
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        if !self.alive.load(Ordering::Acquire) {
            return Err("AI 运行时已退出，请重新连接".into());
        }
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        {
            let mut input = self.input.lock().await;
            let written = input
                .write_all(
                    (json!({"id":id,"method":method,"args":args}).to_string() + "\n").as_bytes(),
                )
                .await
                .map_err(|e| e.to_string());
            if let Err(error) = written {
                self.pending.lock().await.remove(&id);
                return Err(error.into());
            }
            input.flush().await.map_err(|e| e.to_string())?;
        }
        let result = tokio::time::timeout(Duration::from_secs(90), rx).await;
        self.pending.lock().await.remove(&id);
        let (mut result, cursor) = result
            .map_err(|_| "AI 运行时请求超时".to_string())?
            .map_err(|_| "AI 运行时连接中断".to_string())??;
        if method == "status"
            && let Some(object) = result.as_object_mut()
        {
            object.insert("eventCursor".into(), json!(cursor));
        }
        Ok(result)
    }
}
