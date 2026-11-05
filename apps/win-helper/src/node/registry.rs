//! The capability registry (the node's manifest) and the shared runtime groups draw services from.
//!
//! Groups register with `pub fn register(reg: &mut CapabilityRegistry)` and reach shared state
//! through `reg.runtime()`: the log, environment, `$PSYCHE_HOME`, the permission preflight and a
//! typed service map (`Runtime::service`) for objects several groups share (the notification
//! bridge, the presence key). Core files never need to know a group's types.

use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{Value, json};

use super::capability::{CapResult, CapabilityError, CapabilitySpec, InvocationContext, OsPermission};
use super::log::HelperLog;
use super::paths::{Env, psyche_home};

/// Software version reported in the manifest.
pub const HELPER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Answers whether an OS permission is granted right now (preflight only; never prompts).
pub trait PermissionPreflight: Send + Sync {
    fn is_granted(&self, permission: OsPermission) -> bool;
}

/// Grants everything (tests, `--manifest`).
pub struct AllowAll;

impl PermissionPreflight for AllowAll {
    fn is_granted(&self, _: OsPermission) -> bool {
        true
    }
}

/// Process-wide state shared by every capability group.
pub struct Runtime {
    pub log: HelperLog,
    pub env: Env,
    pub home: PathBuf,
    pub started: Instant,
    pub preflight: Arc<dyn PermissionPreflight>,
    /// False for `--manifest` / tests: groups must not touch the registry, the Start menu or
    /// other persistent state while building their specs.
    pub live: bool,
    services: Mutex<HashMap<TypeId, Arc<dyn Any + Send + Sync>>>,
}

impl Runtime {
    pub fn new(env: Env, log: HelperLog, preflight: Arc<dyn PermissionPreflight>, live: bool) -> Arc<Runtime> {
        let home = psyche_home(&env);
        Arc::new(Runtime { log, env, home, started: Instant::now(), preflight, live, services: Mutex::new(HashMap::new()) })
    }

    /// A quiet, non-live runtime over `env` (tests, manifest printing).
    pub fn offline(env: Env) -> Arc<Runtime> {
        Self::new(env, HelperLog::quiet(), Arc::new(AllowAll), false)
    }

    /// The shared instance of `T`, created by `init` the first time any group asks for it.
    pub fn service<T: Any + Send + Sync>(&self, init: impl FnOnce() -> T) -> Arc<T> {
        let mut map = self.services.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(existing) = map.get(&TypeId::of::<T>()) {
            return existing.clone().downcast::<T>().expect("service type");
        }
        let created = Arc::new(init());
        map.insert(TypeId::of::<T>(), created.clone());
        created
    }

    /// The shared `T`, if a group created it.
    pub fn existing_service<T: Any + Send + Sync>(&self) -> Option<Arc<T>> {
        let map = self.services.lock().unwrap_or_else(|p| p.into_inner());
        map.get(&TypeId::of::<T>()).cloned().and_then(|s| s.downcast::<T>().ok())
    }
}

pub type BoxFuture = Pin<Box<dyn Future<Output = CapResult> + Send + 'static>>;
pub type HandlerFn = Arc<dyn Fn(InvocationContext) -> BoxFuture + Send + Sync>;

/// One capability: its spec and handler.
pub struct Capability {
    pub spec: CapabilitySpec,
    pub handler: HandlerFn,
}

pub struct CapabilityRegistry {
    runtime: Arc<Runtime>,
    ordered: Vec<Arc<Capability>>,
    index: HashMap<String, usize>,
}

impl CapabilityRegistry {
    pub fn new(runtime: Arc<Runtime>) -> Self {
        CapabilityRegistry { runtime, ordered: Vec::new(), index: HashMap::new() }
    }

    pub fn runtime(&self) -> &Arc<Runtime> {
        &self.runtime
    }

    /// Adds an async handler. Panics on a duplicate name (a programming error, as in Swift).
    pub fn add<F, Fut>(&mut self, spec: CapabilitySpec, handler: F)
    where
        F: Fn(InvocationContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = CapResult> + Send + 'static,
    {
        let f: HandlerFn = Arc::new(move |ctx| Box::pin(handler(ctx)));
        self.insert(Capability { spec, handler: f });
    }

    /// Adds a blocking handler (Win32 / COM work), run on the blocking pool. Every runtime thread
    /// is in the COM multithreaded apartment.
    pub fn add_blocking<F>(&mut self, spec: CapabilitySpec, handler: F)
    where
        F: Fn(InvocationContext) -> CapResult + Send + Sync + 'static,
    {
        let handler = Arc::new(handler);
        let f: HandlerFn = Arc::new(move |ctx| {
            let h = handler.clone();
            Box::pin(async move {
                match tokio::task::spawn_blocking(move || {
                    crate::win::com::ensure_mta();
                    h(ctx)
                })
                .await
                {
                    Ok(r) => r,
                    Err(e) if e.is_cancelled() => Err(CapabilityError::cancelled()),
                    Err(_) => Err(CapabilityError::internal("internal", "The capability panicked")),
                }
            })
        });
        self.insert(Capability { spec, handler: f });
    }

    fn insert(&mut self, cap: Capability) {
        assert!(!self.index.contains_key(&cap.spec.name), "duplicate capability {}", cap.spec.name);
        self.index.insert(cap.spec.name.clone(), self.ordered.len());
        self.ordered.push(Arc::new(cap));
    }

    pub fn get(&self, name: &str) -> Option<Arc<Capability>> {
        self.index.get(name).map(|&i| self.ordered[i].clone())
    }

    pub fn len(&self) -> usize {
        self.ordered.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ordered.is_empty()
    }

    pub fn names(&self) -> Vec<String> {
        self.ordered.iter().map(|c| c.spec.name.clone()).collect()
    }

    /// `NodeCapability[]` for `connect`.
    pub fn manifest_entries(&self) -> Vec<Value> {
        self.ordered.iter().map(|c| c.spec.manifest_entry()).collect()
    }

    /// `CapabilityManifest` (what `psyche-helper --manifest` prints).
    pub fn manifest(&self, version: &str) -> Value {
        json!({ "platform": "windows", "version": version, "capabilities": self.manifest_entries() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::capability::{CapabilityOutput, SideEffect};

    #[test]
    fn manifest_keeps_order_and_platform() {
        let mut reg = CapabilityRegistry::new(Runtime::offline(Env::default()));
        reg.add(CapabilitySpec::new("b.one", "first", SideEffect::Read), |_| async { Ok(CapabilityOutput::new(json!({}))) });
        reg.add_blocking(CapabilitySpec::new("a.two", "second", SideEffect::Write), |_| Ok(CapabilityOutput::new(json!(1))));
        let m = reg.manifest("9.9.9");
        assert_eq!(m["platform"], "windows");
        assert_eq!(m["version"], "9.9.9");
        assert_eq!(m["capabilities"][0]["name"], "b.one");
        assert_eq!(m["capabilities"][1]["name"], "a.two");
        assert_eq!(reg.len(), 2);
        assert!(reg.get("a.two").is_some() && reg.get("zzz").is_none());
    }

    #[test]
    #[should_panic(expected = "duplicate capability")]
    fn duplicate_names_panic() {
        let mut reg = CapabilityRegistry::new(Runtime::offline(Env::default()));
        reg.add_blocking(CapabilitySpec::new("x", "", SideEffect::Read), |_| Ok(CapabilityOutput::new(json!(1))));
        reg.add_blocking(CapabilitySpec::new("x", "", SideEffect::Read), |_| Ok(CapabilityOutput::new(json!(1))));
    }

    #[test]
    fn services_are_shared_singletons() {
        let rt = Runtime::offline(Env::default());
        let a = rt.service(|| Mutex::new(1u32));
        *a.lock().unwrap() = 7;
        let b = rt.service(|| Mutex::new(0u32));
        assert_eq!(*b.lock().unwrap(), 7);
        assert!(rt.existing_service::<String>().is_none());
    }
}
