use crate::Host;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{broadcast, watch};
#[derive(Clone, Serialize)]
pub struct Event {
    pub topic: &'static str,
    pub data: Value,
}
pub struct Events {
    host: Host,
    initial: bool,
    stopping: watch::Receiver<bool>,
    agent: broadcast::Receiver<Event>,
    simulation: watch::Receiver<()>,
}
impl Host {
    pub async fn events(&self) -> Events {
        Events {
            host: self.clone(),
            initial: true,
            stopping: self.stopping.subscribe(),
            agent: self.events.subscribe(),
            simulation: self.native.lock().await.updates(),
        }
    }
    pub(crate) fn emit_agent(&self, data: Value) {
        let _ = self.events.send(Event {
            topic: "agent",
            data,
        });
    }
}
impl Events {
    pub async fn next(&mut self) -> Option<Event> {
        if *self.stopping.borrow() {
            return None;
        }
        if std::mem::take(&mut self.initial) {
            return Some(Event {
                topic: "resync",
                data: Value::Null,
            });
        }
        tokio::select! {
            _ = self.stopping.changed() => None,
            event = self.agent.recv() => Some(event.unwrap_or(Event { topic: "resync", data: json!(null) })),
            _ = self.simulation.changed() => {
                // Read under the native lock: navigation and replacement finish before a frame is published.
                let native = self.host.native.lock().await;
                Some(Event { topic: "simulation", data: native.simulation.as_ref().map(|s| s.state()).unwrap_or(Value::Null) })
            }
        }
    }
}
