//! One app recording at a time: a port of the mac helper's `AppTeachController`
//! (`PsycheHelperSystem/Teach/AppTeachController.swift`). The live part is a [`Source`] and an
//! [`Indicator`]; everything that decides what is recorded is [`Mapper`] / [`policy`] in
//! `policy.rs`. The helper holds the steps in memory only; the owner's review screen is where
//! they go next, and [`AppTeachController::collect`] hands them over once.

use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime};

use psyche_win_computer::tiers::TierSettings;
use serde_json::{Value, json};
use tokio::runtime::Handle;
use tokio::time::Instant;

use super::policy::{self, AppRef, Event, Mapper};
use crate::node::encoding::{hex, random_bytes};
use crate::node::log::HelperLog;
use crate::node::time::iso8601;
use crate::node::{CapabilityError, ErrorCode};

pub const DEFAULT_MAX_SECONDS: u64 = 900;
/// An ended recording nobody collected is forgotten after this long.
pub const DEFAULT_UNCLAIMED_SECONDS: u64 = 30 * 60;

/// Which processes an app's elements may come from.
pub type Scope = Arc<dyn Fn(u32) -> bool + Send + Sync>;

/// The live source (UI Automation + a listen-only mouse hook; tests: a fake event stream).
pub trait Source: Send {
    /// Starts watching `bundle_id`'s app. `bind` gets the processes the recording is bound to
    /// before anything is observed, so it is bound to those processes and not to a name;
    /// `on_end` is called if the app quits (or stops being the same process). Fails when the app
    /// is not running, runs elevated, or the hooks cannot be installed.
    fn start(
        &mut self,
        bundle_id: &str,
        bind: Arc<dyn Fn(Scope) + Send + Sync>,
        on_event: Arc<dyn Fn(Event) + Send + Sync>,
        on_end: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<(), CapabilityError>;
    /// Must not wait for the source's threads: it may be called from inside `on_event`.
    fn stop(&mut self);
}

/// The always-visible sign that a recording is running, with a Stop that works without the app.
pub trait Indicator: Send + Sync {
    fn show(&self, app_name: &str, on_stop: Arc<dyn Fn() + Send + Sync>);
    fn hide(&self);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum End {
    Stop,
    Timeout,
    Limit,
    Cancel,
    Interrupted,
}

impl End {
    pub fn as_str(self) -> &'static str {
        match self {
            End::Stop => "stop",
            End::Timeout => "timeout",
            End::Limit => "limit",
            End::Cancel => "cancel",
            End::Interrupted => "interrupted",
        }
    }
}

struct Active {
    id: String,
    mapper: Arc<Mapper>,
    started_at: SystemTime,
    source: Option<Box<dyn Source>>,
    ended: Option<End>,
    ended_at: Option<Instant>,
}

type MakeSource = Box<dyn Fn() -> Box<dyn Source> + Send + Sync>;
type AppName = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;
type Settings = Box<dyn Fn() -> TierSettings + Send + Sync>;

pub struct AppTeachController {
    current: Mutex<Option<Active>>,
    make_source: MakeSource,
    indicator: Arc<dyn Indicator>,
    settings: Settings,
    app_name: AppName,
    max_seconds: u64,
    unclaimed: Duration,
    log: HelperLog,
    me: Weak<AppTeachController>,
}

impl AppTeachController {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        make_source: impl Fn() -> Box<dyn Source> + Send + Sync + 'static,
        indicator: Arc<dyn Indicator>,
        settings: impl Fn() -> TierSettings + Send + Sync + 'static,
        app_name: impl Fn(&str) -> Option<String> + Send + Sync + 'static,
        max_seconds: u64,
        unclaimed_seconds: u64,
        log: HelperLog,
    ) -> Arc<AppTeachController> {
        Arc::new_cyclic(|me| AppTeachController {
            current: Mutex::new(None),
            make_source: Box::new(make_source),
            indicator,
            settings: Box::new(settings),
            app_name: Box::new(app_name),
            max_seconds,
            unclaimed: Duration::from_secs(unclaimed_seconds),
            log,
            me: me.clone(),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Active>> {
        self.current.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// For tests: the id of the recording in progress or ended, started or not.
    pub fn current_id(&self) -> Option<String> {
        self.lock().as_ref().map(|c| c.id.clone())
    }

    /// The id of the recording in progress (not one that ended and awaits collection).
    pub fn active_id(&self) -> Option<String> {
        self.lock()
            .as_ref()
            .filter(|c| c.ended.is_none())
            .map(|c| c.id.clone())
    }

    /// Starts recording `bundle_id`. Refuses an app the owner has not granted, Psyche, security
    /// prompts, password managers, and every app that cannot be driven (browsers, terminals,
    /// banking). Must run inside a Tokio runtime (the time limit and the forget timer).
    pub fn begin(&self, bundle_id: &str) -> Result<(String, AppRef), CapabilityError> {
        if bundle_id.is_empty() || bundle_id.chars().count() > 200 {
            return Err(CapabilityError::invalid_params(
                "bundleId is required",
                Some("bundleId"),
            ));
        }
        let bundle_id = bundle_id.to_lowercase();
        if let Some(why) = policy::refusal(&bundle_id, &(self.settings)()) {
            self.log.info(format!(
                "teach app refused app={bundle_id} why={}",
                why.reason()
            ));
            return Err(CapabilityError::policy_denied(why.reason(), why.message())
                .with_detail("app", bundle_id.clone()));
        }
        let Some(name) = (self.app_name)(&bundle_id) else {
            return Err(CapabilityError::unavailable(
                "app_not_running",
                "Open the app first, then record in it",
            )
            .retryable());
        };
        let handle = Handle::try_current().map_err(|_| {
            CapabilityError::internal("no_runtime", "the helper runtime is not available")
        })?;
        let id = format!("app-teach-{}", &hex(&random_bytes::<8>())[..12]);
        let mapper = Arc::new(Mapper::new(&bundle_id, &name, policy::MAX_STEPS));
        let mut source = (self.make_source)();
        {
            let mut cur = self.lock();
            if let Some(c) = cur.as_ref() {
                // An ended recording nobody collected makes way for a new one.
                if c.ended.is_none() {
                    return Err(CapabilityError::new(
                        ErrorCode::Conflict,
                        "teach_busy",
                        "A recording is already running",
                    ));
                }
                *cur = None;
            }
            *cur = Some(Active {
                id: id.clone(),
                mapper: mapper.clone(),
                started_at: SystemTime::now(),
                source: None,
                ended: None,
                ended_at: None,
            });
        }
        let (m, me, sid) = (mapper.clone(), self.me.clone(), id.clone());
        let bind: Arc<dyn Fn(Scope) + Send + Sync> = Arc::new(move |scope| m.bind_scope(scope));
        let (me_event, sid_event) = (me.clone(), sid.clone());
        let on_event: Arc<dyn Fn(Event) + Send + Sync> = Arc::new(move |event| {
            if let Some(c) = me_event.upgrade() {
                c.input(&sid_event, &event);
            }
        });
        let on_end: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            if let Some(c) = me.upgrade() {
                c.end(&sid, End::Interrupted);
            }
        });
        if let Err(e) = source.start(&bundle_id, bind, on_event, on_end) {
            let mut cur = self.lock();
            if cur.as_ref().is_some_and(|c| c.id == id) {
                *cur = None;
            }
            return Err(e);
        }
        // A Stop or Cancel that arrived while the source was starting won: tear the source down
        // again instead of leaving it recording with nothing to show for it.
        let wanted = {
            let mut cur = self.lock();
            match cur.as_mut() {
                Some(c) if c.id == id && c.ended.is_none() => {
                    // Hand the source over; end() stops it from here on.
                    c.source = Some(source);
                    None
                }
                _ => Some(source),
            }
        };
        if let Some(mut stale) = wanted {
            stale.stop();
            self.indicator.hide();
            let mut cur = self.lock();
            if cur.as_ref().is_some_and(|c| c.id == id) {
                *cur = None;
            }
            return Err(CapabilityError::new(
                ErrorCode::Conflict,
                "teach_cancelled",
                "The recording was stopped while it was starting",
            ));
        }
        let (me, tid) = (self.me.clone(), id.clone());
        self.indicator.show(
            &mapper.app.name,
            Arc::new(move || {
                if let Some(c) = me.upgrade() {
                    c.end(&tid, End::Stop);
                }
            }),
        );
        let (me, tid, seconds) = (self.me.clone(), id.clone(), self.max_seconds);
        handle.spawn(async move {
            tokio::time::sleep(Duration::from_secs(seconds)).await;
            if let Some(c) = me.upgrade() {
                c.end(&tid, End::Timeout);
            }
        });
        self.log
            .info(format!("teach app started id={id} app={bundle_id}"));
        Ok((id, mapper.app.clone()))
    }

    fn input(&self, id: &str, event: &Event) {
        let mapper = {
            let cur = self.lock();
            match cur.as_ref() {
                Some(c) if c.id == id && c.ended.is_none() => c.mapper.clone(),
                _ => return,
            }
        };
        mapper.handle(event);
        if mapper.limit_reached() {
            self.end(id, End::Limit);
        }
    }

    /// Stops watching and hides the indicator. The steps stay in memory until `collect` or `cancel`.
    pub fn end(&self, id: &str, how: End) -> bool {
        let (source, steps) = {
            let mut cur = self.lock();
            match cur.as_mut() {
                Some(c) if c.id == id && c.ended.is_none() => {
                    c.ended = Some(how);
                    c.ended_at = Some(Instant::now());
                    (c.source.take(), c.mapper.step_count())
                }
                _ => return false,
            }
        };
        if let Some(mut s) = source {
            s.stop();
        }
        self.indicator.hide();
        self.log.info(format!(
            "teach app ended id={id} by={} steps={steps}",
            how.as_str()
        ));
        // Nobody collected it: forget it on a timer, not only when someone next asks.
        if let Ok(handle) = Handle::try_current() {
            let (me, id, wait) = (self.me.clone(), id.to_owned(), self.unclaimed);
            handle.spawn(async move {
                tokio::time::sleep(wait).await;
                if let Some(c) = me.upgrade() {
                    c.forget_if_unclaimed(&id);
                }
            });
        }
        true
    }

    fn forget_if_unclaimed(&self, id: &str) {
        let mut cur = self.lock();
        if cur
            .as_ref()
            .is_some_and(|c| c.id == id && c.ended.is_some())
        {
            *cur = None;
        }
    }

    fn expire(&self, cur: &mut Option<Active>) {
        if cur
            .as_ref()
            .and_then(|c| c.ended_at)
            .is_some_and(|at| at.elapsed() > self.unclaimed)
        {
            *cur = None;
        }
    }

    /// Ends the recording if it still runs and returns what it caught, once.
    pub fn collect(&self) -> Result<Value, CapabilityError> {
        let not_found =
            || CapabilityError::not_found("teach_not_found", "Nothing is being recorded");
        let id = {
            let mut cur = self.lock();
            self.expire(&mut cur);
            cur.as_ref().map(|c| c.id.clone())
        };
        let id = id.ok_or_else(not_found)?;
        self.end(&id, End::Stop);
        let a = self.lock().take().ok_or_else(not_found)?;
        let steps = a.mapper.finish();
        let encoded: Vec<Value> = steps
            .iter()
            .filter_map(|s| serde_json::to_value(s).ok())
            .collect();
        Ok(json!({
            "id": a.id,
            "endedBy": a.ended.unwrap_or(End::Stop).as_str(),
            "app": { "bundleId": a.mapper.app.bundle_id, "name": a.mapper.app.name },
            "steps": encoded,
            "skipped": a.mapper.skipped(),
        }))
    }

    /// Drops the recording and everything it caught.
    pub fn cancel(&self) -> bool {
        let a = self.lock().take();
        let Some(mut a) = a else { return false };
        if a.ended.is_none() {
            if let Some(mut s) = a.source.take() {
                s.stop();
            }
            self.indicator.hide();
        }
        self.log.info(format!("teach app cancelled id={}", a.id));
        true
    }

    pub fn status(&self) -> Value {
        let mut cur = self.lock();
        self.expire(&mut cur);
        let Some(c) = cur.as_ref() else {
            return json!({ "active": false });
        };
        let mut o = json!({
            "active": c.ended.is_none(),
            "sessionId": c.id,
            "app": { "bundleId": c.mapper.app.bundle_id, "name": c.mapper.app.name },
            "steps": c.mapper.step_count(),
            "startedAt": iso8601(c.started_at),
        });
        if let Some(e) = c.ended {
            o["ended"] = e.as_str().into();
        }
        o
    }
}
