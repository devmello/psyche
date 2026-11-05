//! Active speech streams and the pushed-audio queue (`SpeechStreamRegistry.swift`,
//! `PushAudioBuffer.swift`), with blocking waits in place of Swift continuations.

use super::params::{MAX_CONCURRENT_STREAMS, PUSH_BUFFER_LIMIT_BYTES, SpeechSource};
use crate::error::{CapError, ErrorCode};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub mod errors {
    use super::*;

    pub fn microphone_busy() -> CapError {
        CapError::new(
            ErrorCode::Conflict,
            "microphone_busy",
            "Another speech stream is already using the microphone",
        )
    }
    pub fn stream_exists(id: &str) -> CapError {
        CapError::new(
            ErrorCode::Conflict,
            "stream_exists",
            "A speech stream with this id is already running",
        )
        .with_detail("streamId", id)
    }
    pub fn too_many_streams() -> CapError {
        CapError::new(
            ErrorCode::RateLimited,
            "too_many_streams",
            "Too many speech streams are running",
        )
        .retryable()
    }
    /// Retryable: a push can race the start of its `speech.transcribe_stream` invocation.
    pub fn stream_not_found(id: &str) -> CapError {
        CapError::new(
            ErrorCode::NotFound,
            "stream_not_found",
            "No active speech stream with this id",
        )
        .with_detail("streamId", id)
        .retryable()
    }
    pub fn not_push_stream() -> CapError {
        CapError::new(
            ErrorCode::Conflict,
            "not_push_stream",
            "This speech stream reads the microphone; it does not accept pushed audio",
        )
    }
    pub fn stream_finished() -> CapError {
        CapError::new(
            ErrorCode::Conflict,
            "stream_finished",
            "This speech stream no longer accepts audio",
        )
    }
    pub fn push_buffer_full(buffered: usize, limit: usize) -> CapError {
        CapError::new(
            ErrorCode::RateLimited,
            "push_buffer_full",
            "Pushed audio is arriving faster than it is transcribed; retry shortly",
        )
        .with_detail("bufferedBytes", buffered)
        .with_detail("limitBytes", limit)
        .retryable()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PushError {
    Finished,
    Overflow { buffered: usize, limit: usize },
}

/// What [`PushBuffer::next`] found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Next {
    Chunk(Vec<u8>),
    Ended,
    Timeout,
}

#[derive(Default)]
struct PushState {
    queue: VecDeque<Vec<u8>>,
    buffered: usize,
    total: usize,
    finished: bool,
}

/// Single-consumer queue of pushed audio. A push that would take the unconsumed bytes over
/// `limit` is refused (backpressure); `finish` lets the consumer drain then see `None`;
/// `cancel` drops the queue and ends it at once.
pub struct PushBuffer {
    pub limit: usize,
    state: Mutex<PushState>,
    cv: Condvar,
}

impl PushBuffer {
    pub fn new(limit: usize) -> Self {
        PushBuffer {
            limit: limit.max(1),
            state: Mutex::new(PushState::default()),
            cv: Condvar::new(),
        }
    }

    pub fn buffered(&self) -> usize {
        lock(&self.state).buffered
    }

    pub fn total_pushed(&self) -> usize {
        lock(&self.state).total
    }

    pub fn is_finished(&self) -> bool {
        lock(&self.state).finished
    }

    /// Queues `data` (empty data is allowed, e.g. a bare `final: true`); returns the unconsumed
    /// byte count after the push.
    pub fn push(&self, data: &[u8], r#final: bool) -> Result<usize, PushError> {
        let mut s = lock(&self.state);
        if s.finished {
            return Err(PushError::Finished);
        }
        if !data.is_empty() && s.buffered + data.len() > self.limit {
            return Err(PushError::Overflow {
                buffered: s.buffered,
                limit: self.limit,
            });
        }
        if !data.is_empty() {
            s.total += data.len();
            s.buffered += data.len();
            s.queue.push_back(data.to_vec());
        }
        if r#final {
            s.finished = true;
        }
        let now = s.buffered;
        drop(s);
        self.cv.notify_all();
        Ok(now)
    }

    pub fn finish(&self) {
        lock(&self.state).finished = true;
        self.cv.notify_all();
    }

    pub fn cancel(&self) {
        let mut s = lock(&self.state);
        s.finished = true;
        s.queue.clear();
        s.buffered = 0;
        drop(s);
        self.cv.notify_all();
    }

    /// Next chunk in push order, `Ended` once finished and drained, `Timeout` when nothing came.
    pub fn next(&self, timeout: Duration) -> Next {
        let mut s = lock(&self.state);
        loop {
            if let Some(d) = s.queue.pop_front() {
                s.buffered -= d.len();
                return Next::Chunk(d);
            }
            if s.finished {
                return Next::Ended;
            }
            let (g, t) = self
                .cv
                .wait_timeout(s, timeout)
                .unwrap_or_else(|e| e.into_inner());
            s = g;
            if t.timed_out() && s.queue.is_empty() && !s.finished {
                return Next::Timeout;
            }
        }
    }
}

type StopHandler = Box<dyn FnOnce() + Send>;

/// One registered stream. `request_stop` runs the handler the pipeline installs (or runs it as
/// soon as it is installed when the stop came first).
pub struct Handle {
    pub id: String,
    pub source: SpeechSource,
    pub push: Option<Arc<PushBuffer>>,
    stop: Mutex<(bool, Option<StopHandler>)>,
}

impl std::fmt::Debug for Handle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Handle")
            .field("id", &self.id)
            .field("source", &self.source)
            .finish_non_exhaustive()
    }
}

impl Handle {
    pub fn is_stop_requested(&self) -> bool {
        lock(&self.stop).0
    }

    pub fn set_stop_handler(&self, handler: impl FnOnce() + Send + 'static) {
        let mut s = lock(&self.stop);
        if s.0 {
            drop(s);
            handler();
            return;
        }
        s.1 = Some(Box::new(handler));
    }

    /// Idempotent. Push streams also finish their buffer so queued audio drains and ends.
    pub fn request_stop(&self) {
        let handler = {
            let mut s = lock(&self.stop);
            if s.0 {
                return;
            }
            s.0 = true;
            s.1.take()
        };
        if let Some(p) = &self.push {
            p.finish();
        }
        if let Some(h) = handler {
            h();
        }
    }
}

/// Active `speech.transcribe_stream` invocations by stream id (= invocation id): one microphone
/// stream at a time and a small cap on concurrent streams.
pub struct Registry {
    pub max_streams: usize,
    streams: Mutex<HashMap<String, Arc<Handle>>>,
}

impl Default for Registry {
    fn default() -> Self {
        Registry::new(MAX_CONCURRENT_STREAMS)
    }
}

impl Registry {
    pub fn new(max_streams: usize) -> Self {
        Registry {
            max_streams: max_streams.max(1),
            streams: Mutex::new(HashMap::new()),
        }
    }

    pub fn register(&self, id: &str, source: SpeechSource) -> Result<Arc<Handle>, CapError> {
        self.register_with_limit(id, source, PUSH_BUFFER_LIMIT_BYTES)
    }

    pub fn register_with_limit(
        &self,
        id: &str,
        source: SpeechSource,
        push_limit: usize,
    ) -> Result<Arc<Handle>, CapError> {
        let mut m = lock(&self.streams);
        if m.contains_key(id) {
            return Err(errors::stream_exists(id));
        }
        if source == SpeechSource::Microphone
            && m.values().any(|h| h.source == SpeechSource::Microphone)
        {
            return Err(errors::microphone_busy());
        }
        if m.len() >= self.max_streams {
            return Err(errors::too_many_streams());
        }
        let push = (source == SpeechSource::Push).then(|| Arc::new(PushBuffer::new(push_limit)));
        let h = Arc::new(Handle {
            id: id.to_string(),
            source,
            push,
            stop: Mutex::new((false, None)),
        });
        m.insert(id.to_string(), h.clone());
        Ok(h)
    }

    pub fn handle(&self, id: &str) -> Option<Arc<Handle>> {
        lock(&self.streams).get(id).cloned()
    }

    pub fn remove(&self, id: &str) {
        lock(&self.streams).remove(id);
    }

    pub fn active_count(&self) -> usize {
        lock(&self.streams).len()
    }

    pub fn microphone_busy(&self) -> bool {
        lock(&self.streams)
            .values()
            .any(|h| h.source == SpeechSource::Microphone)
    }

    /// `speech.audio_push`: returns the unconsumed byte count after the push.
    pub fn push(&self, id: &str, audio: &[u8], r#final: bool) -> Result<usize, CapError> {
        let h = self
            .handle(id)
            .ok_or_else(|| errors::stream_not_found(id))?;
        let buf = h.push.as_ref().ok_or_else(errors::not_push_stream)?;
        buf.push(audio, r#final).map_err(|e| match e {
            PushError::Finished => errors::stream_finished(),
            PushError::Overflow { buffered, limit } => errors::push_buffer_full(buffered, limit),
        })
    }

    /// `speech.stop`.
    pub fn stop(&self, id: &str) -> Result<(), CapError> {
        self.handle(id)
            .ok_or_else(|| errors::stream_not_found(id))?
            .request_stop();
        Ok(())
    }
}

/// Removes a stream from its registry when the pipeline ends, however it ends.
pub struct Registration<'a> {
    pub registry: &'a Registry,
    pub handle: Arc<Handle>,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.registry.remove(&self.handle.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn orders_finishes_and_backpressure() {
        let b = PushBuffer::new(10);
        assert_eq!(b.push(&[1, 2, 3], false), Ok(3));
        assert_eq!(
            b.push(&[4; 8], false),
            Err(PushError::Overflow {
                buffered: 3,
                limit: 10
            })
        );
        assert_eq!(b.push(&[4, 5], true), Ok(5));
        assert_eq!(b.push(&[6], false), Err(PushError::Finished));
        assert_eq!(b.next(Duration::from_millis(1)), Next::Chunk(vec![1, 2, 3]));
        assert_eq!(b.next(Duration::from_millis(1)), Next::Chunk(vec![4, 5]));
        assert_eq!(b.next(Duration::from_millis(1)), Next::Ended);
        assert_eq!(b.total_pushed(), 5);
    }

    #[test]
    fn wakes_a_waiting_consumer_and_times_out() {
        let b = Arc::new(PushBuffer::new(100));
        assert_eq!(b.next(Duration::from_millis(5)), Next::Timeout);
        let b2 = b.clone();
        let t = std::thread::spawn(move || b2.next(Duration::from_secs(5)));
        std::thread::sleep(Duration::from_millis(20));
        b.push(&[9], false).unwrap();
        assert_eq!(t.join().unwrap(), Next::Chunk(vec![9]));
        b.push(&[1], false).unwrap();
        b.cancel();
        assert_eq!(
            b.next(Duration::from_millis(1)),
            Next::Ended,
            "cancel drops what was queued"
        );
        assert_eq!(b.buffered(), 0);
    }

    #[test]
    fn one_microphone_at_a_time_and_a_stream_cap() {
        let r = Registry::new(2);
        let _m = r.register("a", SpeechSource::Microphone).unwrap();
        assert_eq!(
            r.register("b", SpeechSource::Microphone)
                .unwrap_err()
                .reason,
            "microphone_busy"
        );
        assert_eq!(
            r.register("a", SpeechSource::Push).unwrap_err().reason,
            "stream_exists"
        );
        r.register("c", SpeechSource::Push).unwrap();
        assert_eq!(
            r.register("d", SpeechSource::Push).unwrap_err().reason,
            "too_many_streams"
        );
        assert!(r.microphone_busy());
        r.remove("a");
        assert!(!r.microphone_busy());
        assert_eq!(r.active_count(), 1);
    }

    #[test]
    fn push_and_stop() {
        let r = Registry::default();
        assert_eq!(
            r.push("x", &[1], false).unwrap_err().reason,
            "stream_not_found"
        );
        assert!(r.push("x", &[1], false).unwrap_err().retryable);
        let mic = r.register("m", SpeechSource::Microphone).unwrap();
        assert_eq!(
            r.push("m", &[1], false).unwrap_err().reason,
            "not_push_stream"
        );
        let h = r.register_with_limit("p", SpeechSource::Push, 4).unwrap();
        assert_eq!(r.push("p", &[1, 2], false).unwrap(), 2);
        let e = r.push("p", &[1, 2, 3], false).unwrap_err();
        assert_eq!(
            (e.reason.as_str(), e.details["limitBytes"].as_u64()),
            ("push_buffer_full", Some(4))
        );
        r.stop("p").unwrap();
        assert!(h.is_stop_requested());
        assert_eq!(
            r.push("p", &[1], false).unwrap_err().reason,
            "stream_finished"
        );
        assert_eq!(
            h.push.as_ref().unwrap().next(Duration::from_millis(1)),
            Next::Chunk(vec![1, 2]),
            "queued audio drains"
        );
        drop(mic);
    }

    #[test]
    fn stop_handler_runs_once_even_when_stop_comes_first() {
        let r = Registry::default();
        let h = r.register("s", SpeechSource::Push).unwrap();
        let n = Arc::new(AtomicUsize::new(0));
        h.request_stop();
        h.request_stop();
        let n2 = n.clone();
        h.set_stop_handler(move || {
            n2.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(n.load(Ordering::SeqCst), 1);
        let h2 = r.register("t", SpeechSource::Push).unwrap();
        let n3 = n.clone();
        h2.set_stop_handler(move || {
            n3.fetch_add(1, Ordering::SeqCst);
        });
        h2.request_stop();
        h2.request_stop();
        assert_eq!(n.load(Ordering::SeqCst), 2);
        {
            let _reg = Registration {
                registry: &r,
                handle: h2,
            };
        }
        assert!(r.handle("t").is_none());
    }
}
