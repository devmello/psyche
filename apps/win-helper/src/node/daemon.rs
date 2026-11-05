//! Keeps the helper connected (port of `NodeDaemon`): connect → handshake → serve, reconnecting
//! with capped exponential backoff when the Gateway restarts, while pairing is pending, or after a
//! denial. The pipe location and the handshake secret are re-read before every attempt, so a
//! restarted Gateway (new pipe, new secret) is followed.

use std::sync::Arc;
use std::time::Duration;

use super::cancel::CancelToken;
use super::channel::{FrameReader, spawn_writer};
use super::handshake::{Completion, HandshakeOptions, perform};
use super::identity::DeviceIdentity;
use super::log::HelperLog;
use super::paths::{Env, node_pipe, read_handshake_secret};
use super::registry::CapabilityRegistry;
use super::session::NodeSession;
use super::transport::{ConnectError, connect};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Backoff {
    pub initial: Duration,
    pub max: Duration,
    pub pending_retry: Duration,
    pub denied_retry: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Backoff {
            initial: Duration::from_millis(500),
            max: Duration::from_secs(30),
            pending_retry: Duration::from_secs(5),
            denied_retry: Duration::from_secs(300),
        }
    }
}

impl Backoff {
    /// Delay before the next attempt after `n` consecutive failures.
    pub fn delay(&self, failures: u32) -> Duration {
        let factor = 2f64.powi(failures.min(30) as i32);
        self.initial.mul_f64(factor).min(self.max)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Served,
    Pending(Option<String>),
    Denied,
    Failed,
}

pub struct NodeDaemon {
    identity: DeviceIdentity,
    registry: Arc<CapabilityRegistry>,
    env: Env,
    log: HelperLog,
    pub backoff: Backoff,
    stop: CancelToken,
}

impl NodeDaemon {
    pub fn new(
        identity: DeviceIdentity,
        registry: Arc<CapabilityRegistry>,
        env: Env,
        log: HelperLog,
    ) -> Self {
        NodeDaemon {
            identity,
            registry,
            env,
            log,
            backoff: Backoff::default(),
            stop: CancelToken::new(),
        }
    }

    pub fn stop_token(&self) -> CancelToken {
        self.stop.clone()
    }

    /// Runs until the stop token is cancelled.
    pub async fn run(&self) {
        let mut failures = 0u32;
        while !self.stop.is_cancelled() {
            let delay = match self.run_once().await {
                Outcome::Served => {
                    failures = 0;
                    self.backoff.initial
                }
                Outcome::Pending(_) => self.backoff.pending_retry,
                Outcome::Denied => self.backoff.denied_retry,
                Outcome::Failed => {
                    let d = self.backoff.delay(failures);
                    failures = failures.saturating_add(1);
                    d
                }
            };
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = self.stop.cancelled() => {}
            }
        }
    }

    /// One connect → handshake → serve cycle.
    pub async fn run_once(&self) -> Outcome {
        let pipe = node_pipe(&self.env);
        let client = match connect(&pipe.path).await {
            Ok(c) => c,
            Err(ConnectError::Missing) => return Outcome::Failed,
            Err(e) => {
                self.log.error(format!("{e} (source={})", pipe.source));
                return Outcome::Failed;
            }
        };
        let (read_half, write_half) = tokio::io::split(client);
        let mut reader = FrameReader::new(read_half);
        let (writer, writer_task) = spawn_writer(write_half);
        let options = HandshakeOptions {
            handshake_secret: read_handshake_secret(&self.env),
            capabilities: self.registry.manifest_entries(),
            ..HandshakeOptions::default()
        };
        let outcome = tokio::select! {
            r = perform(&self.identity, &options, &mut reader, &writer, &self.log) => r,
            _ = self.stop.cancelled() => return Outcome::Failed,
        };
        let result = match outcome {
            Ok(Completion::Completed(r)) => r,
            Ok(Completion::ChallengeOnly { .. }) => return Outcome::Failed,
            Err(e) => {
                self.log.error(e.to_string());
                return Outcome::Failed;
            }
        };
        let out = match result.phase.as_str() {
            "paired" => {
                self.log
                    .info(format!("serving capabilities={}", self.registry.len()));
                let session =
                    NodeSession::new(self.registry.clone(), writer.clone(), self.log.clone());
                tokio::select! {
                    r = session.serve(&mut reader) => {
                        if let Err(e) = r {
                            self.log.error(format!("connection error: {}", e.kind()));
                        }
                        self.log.info("gateway closed the connection");
                    }
                    _ = self.stop.cancelled() => session.cancel_all(),
                }
                Outcome::Served
            }
            "pending" => {
                // The pairing code is shown to the owner to compare in the app; not a secret.
                self.log.info(format!(
                    "pairing pending: approve this device in Psyche (code {})",
                    result.code.as_deref().unwrap_or("?")
                ));
                Outcome::Pending(result.code)
            }
            _ => {
                self.log.error(format!(
                    "pairing denied{}",
                    result.code.map(|c| format!(" ({c})")).unwrap_or_default()
                ));
                Outcome::Denied
            }
        };
        drop(writer);
        writer_task.abort();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_and_caps() {
        let b = Backoff::default();
        assert_eq!(b.delay(0), Duration::from_millis(500));
        assert_eq!(b.delay(1), Duration::from_secs(1));
        assert_eq!(b.delay(3), Duration::from_secs(4));
        assert_eq!(b.delay(10), Duration::from_secs(30));
        assert_eq!(b.delay(u32::MAX), Duration::from_secs(30));
    }
}
