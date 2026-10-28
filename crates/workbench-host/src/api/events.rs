use crate::Host;
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{broadcast, watch};
use vibe_logisim_runtime::simulation::{SimulationEvent, Subscription};
/// Pushed to the window as `{topic, data}`.
#[derive(Clone, Serialize)]
#[serde(tag = "topic", content = "data", rename_all = "camelCase")]
pub enum Event {
    /// `{sequence, event}` from the AI runtime.
    Agent(Value),
    /// The run's start and whole state, then its frames and end, in order.
    Simulation(Arc<SimulationEvent>),
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
    initial: bool,
    stopping: watch::Receiver<bool>,
    events: broadcast::Receiver<Event>,
    /// The run's events; each listener starts with its whole state.
    simulation: Option<Subscription>,
}
impl Host {
    pub async fn events(&self) -> Events {
        Events {
            initial: true,
            stopping: self.stopping.subscribe(),
            events: self.events.subscribe(),
            simulation: Some(self.simulation.subscribe()),
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
            event = async {
                match self.simulation.as_mut() {
                    Some(simulation) => simulation.next().await,
                    None => std::future::pending().await,
                }
            } => match event {
                Some(event) => Some(Event::Simulation(event)),
                None => {
                    self.simulation = None;
                    Some(Event::Resync(()))
                }
            },
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
