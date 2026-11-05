//! Fans notification responses out to open `notify.subscribe` invocations (port of
//! `NotificationResponseHub`). The protocol has no unsolicited node→Gateway event, so responses
//! ride a long-lived streaming invocation; while no subscriber is attached (helper started by a
//! toast click, Gateway reconnecting) up to 100 responses are buffered, oldest dropped first.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use super::plan::NotificationResponse;

pub const DEFAULT_CAPACITY: usize = 100;

struct State {
    buffer: VecDeque<NotificationResponse>,
    subscribers: HashMap<u64, mpsc::UnboundedSender<NotificationResponse>>,
    next_id: u64,
    dropped: usize,
}

pub struct ResponseHub {
    capacity: usize,
    state: Mutex<State>,
}

/// A live subscription; dropping it unsubscribes.
pub struct Subscription {
    hub: Arc<ResponseHub>,
    id: u64,
    pub rx: mpsc::UnboundedReceiver<NotificationResponse>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.hub.lock().subscribers.remove(&self.id);
    }
}

impl ResponseHub {
    pub fn new(capacity: usize) -> Arc<ResponseHub> {
        Arc::new(ResponseHub {
            capacity: capacity.max(1),
            state: Mutex::new(State {
                buffer: VecDeque::new(),
                subscribers: HashMap::new(),
                next_id: 0,
                dropped: 0,
            }),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn pending_count(&self) -> usize {
        self.lock().buffer.len()
    }

    pub fn dropped_count(&self) -> usize {
        self.lock().dropped
    }

    pub fn subscriber_count(&self) -> usize {
        self.lock().subscribers.len()
    }

    pub fn publish(&self, response: NotificationResponse) {
        let mut s = self.lock();
        let mut delivered = false;
        s.subscribers.retain(|_, tx| {
            let ok = tx.send(response.clone()).is_ok();
            delivered |= ok;
            ok
        });
        if delivered {
            return;
        }
        s.buffer.push_back(response);
        while s.buffer.len() > self.capacity {
            s.buffer.pop_front();
            s.dropped += 1;
        }
    }

    /// Everything buffered first, then live responses.
    pub fn subscribe(self: &Arc<Self>) -> Subscription {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut s = self.lock();
        let id = s.next_id;
        s.next_id += 1;
        for r in s.buffer.drain(..) {
            let _ = tx.send(r);
        }
        s.subscribers.insert(id, tx);
        drop(s);
        Subscription {
            hub: self.clone(),
            id,
            rx,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(id: &str) -> NotificationResponse {
        NotificationResponse::new(id, "default", None, None)
    }

    #[tokio::test]
    async fn buffers_until_a_subscriber_then_streams() {
        let hub = ResponseHub::new(2);
        hub.publish(r("a"));
        hub.publish(r("b"));
        hub.publish(r("c"));
        assert_eq!(hub.pending_count(), 2);
        assert_eq!(hub.dropped_count(), 1);
        let mut sub = hub.subscribe();
        assert_eq!(sub.rx.recv().await.unwrap().notification_id, "b");
        assert_eq!(sub.rx.recv().await.unwrap().notification_id, "c");
        hub.publish(r("d"));
        assert_eq!(sub.rx.recv().await.unwrap().notification_id, "d");
        assert_eq!(hub.pending_count(), 0);
        drop(sub);
        assert_eq!(hub.subscriber_count(), 0);
        hub.publish(r("e"));
        assert_eq!(hub.pending_count(), 1);
    }
}
