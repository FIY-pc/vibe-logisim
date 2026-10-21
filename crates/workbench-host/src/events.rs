use crate::Host;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{broadcast, watch};
/// Pushed to the window as `{topic, data}`.
#[derive(Clone, Serialize)]
#[serde(tag = "topic", content = "data", rename_all = "camelCase")]
pub enum Event {
    /// `{sequence, event}` from the AI runtime.
    Agent(Value),
    /// The running simulation's state, or null when none runs.
    Simulation(Value),
    /// Snapshots may be stale; read them again.
    Resync(()),
    /// A change took effect but something around it failed.
    Warning(Warning),
}
#[derive(Clone, Serialize)]
pub struct Warning {
    pub message: String,
}
pub struct Events {
    host: Host,
    initial: bool,
    stopping: watch::Receiver<bool>,
    events: broadcast::Receiver<Event>,
    simulation: watch::Receiver<()>,
}
impl Host {
    pub async fn events(&self) -> Events {
        Events {
            host: self.clone(),
            initial: true,
            stopping: self.stopping.subscribe(),
            events: self.events.subscribe(),
            simulation: self.native.lock().await.updates(),
        }
    }
    pub(crate) fn emit(&self, event: Event) {
        let _ = self.events.send(event);
    }
}
impl Events {
    pub async fn next(&mut self) -> Option<Event> {
        if *self.stopping.borrow() {
            return None;
        }
        if std::mem::take(&mut self.initial) {
            return Some(Event::Resync(()));
        }
        tokio::select! {
            _ = self.stopping.changed() => None,
            event = self.events.recv() => Some(event.unwrap_or(Event::Resync(()))),
            _ = self.simulation.changed() => {
                // Read under the native lock: navigation and replacement finish before a frame is published.
                let native = self.host.native.lock().await;
                Some(Event::Simulation(native.simulation.as_ref().map(|s| s.state()).unwrap_or(Value::Null)))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn events_keep_the_topic_data_shape() {
        assert_eq!(
            serde_json::to_value(Event::Resync(())).unwrap(),
            serde_json::json!({"topic":"resync","data":null})
        );
        assert_eq!(
            serde_json::to_value(Event::Warning(Warning {
                message: "m".into()
            }))
            .unwrap(),
            serde_json::json!({"topic":"warning","data":{"message":"m"}})
        );
    }
}
