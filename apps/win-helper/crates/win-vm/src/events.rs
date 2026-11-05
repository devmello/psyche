//! `vm.watch` fan-out (mac `VMEventHub`): `{type: vm.updated, guest, at}` and
//! `{type: vm.deleted, name}` to every watching connection.

use std::sync::Mutex;

use serde_json::Value;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

type Subscribers = (u64, Vec<(u64, UnboundedSender<Value>)>);

#[derive(Default)]
pub struct EventHub {
    subs: Mutex<Subscribers>,
}

impl EventHub {
    pub fn subscribe(&self) -> (u64, UnboundedReceiver<Value>) {
        let (tx, rx) = unbounded_channel();
        let mut s = self.subs.lock().unwrap();
        s.0 += 1;
        let id = s.0;
        s.1.push((id, tx));
        (id, rx)
    }

    pub fn unsubscribe(&self, id: u64) {
        self.subs.lock().unwrap().1.retain(|(i, _)| *i != id);
    }

    pub fn publish(&self, event: Value) {
        self.subs.lock().unwrap().1.retain(|(_, tx)| tx.send(event.clone()).is_ok());
    }

    pub fn subscriber_count(&self) -> usize {
        self.subs.lock().unwrap().1.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fan_out_and_unsubscribe() {
        let hub = EventHub::default();
        let (a, mut ra) = hub.subscribe();
        let (_b, mut rb) = hub.subscribe();
        hub.publish(serde_json::json!({"type": "vm.deleted", "name": "x"}));
        assert_eq!(ra.try_recv().unwrap()["name"], "x");
        assert_eq!(rb.try_recv().unwrap()["type"], "vm.deleted");
        hub.unsubscribe(a);
        assert_eq!(hub.subscriber_count(), 1);
        drop(rb);
        hub.publish(serde_json::json!({}));
        assert_eq!(hub.subscriber_count(), 0, "closed receivers are dropped");
    }
}
