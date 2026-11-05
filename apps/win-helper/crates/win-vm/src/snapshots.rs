//! Snapshots and resets (port of `Snapshots.swift`) with VHDX differencing layers instead of
//! APFS clones. A guest's writable disks are leaves: `system.vhdx` (child of the image's
//! `rootfs.vhdx` or of a snapshot layer) and `sessiondata.vhdx`.
//!
//! - **Snapshot** (stopped or saved guest): the leaves move into `snapshots\<id>\` and become
//!   read-only layers; new empty children take their place. Instant, copy-on-write. A saved
//!   machine state (`SavedState.vmrs`) is copied with them.
//! - **Restore**: the current leaves are discarded and new children of the snapshot's layers
//!   take their place (the snapshot is kept). Instant.
//! - **Delete**: the record is retired (`snapshot.json` → `retired.json`); its layers are removed
//!   as soon as no remaining disk is built on them (garbage collection after every change).
//!
//! The protocol's `VmSnapshot` record is `snapshot.json`; `method` is `vhdx-differencing`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{VmError, VmResult};
use crate::fsx;
use crate::model::{Phase, VmConfig, VmState};
use crate::paths::Bundle;
use crate::vhd::DiskOps;

pub const MAX_MANUAL: usize = 10;
pub const KEEP_TASKS: usize = 3;
pub const METHOD: &str = "vhdx-differencing";
const SYSTEM: &str = "system.vhdx";
const SESSION: &str = "sessiondata.vhdx";
const SAVED: &str = "SavedState.vmrs";
const RECORD: &str = "snapshot.json";
const RETIRED: &str = "retired.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRecord {
    pub id: String,
    pub label: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub created_at: String,
    /// Required and nullable in the protocol.
    #[serde(rename = "guestOS")]
    pub guest_os: Option<String>,
    pub bytes: u64,
    pub saved_state: bool,
    pub provisioned: bool,
    pub psyche_installed: bool,
    pub method: String,
}

pub const KINDS: [&str; 3] = ["base", "manual", "task"];

/// `^[a-z0-9][a-z0-9-]{0,63}$`
pub fn is_valid_id(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `<kind>-yyyyMMdd-HHmmss-<base36>`
pub fn new_id(kind: &str, now_secs: u64) -> String {
    let r = u32::from_le_bytes(crate::model::random_bytes::<4>());
    format!("{kind}-{}-{}", crate::model::compact_stamp(now_secs, true), base36(r))
}

fn base36(mut n: u32) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(D[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn default_label(kind: &str) -> &'static str {
    match kind {
        "base" => "Fresh PC",
        "task" => "Before a task",
        _ => "Snapshot",
    }
}

/// Newest first (`createdAt`, then id).
pub fn load(bundle: &Bundle) -> Vec<SnapshotRecord> {
    let mut out: Vec<SnapshotRecord> = std::fs::read_dir(bundle.snapshots())
        .map(|rd| rd.filter_map(|e| e.ok()).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .filter(|id| is_valid_id(id))
        .filter_map(|id| fsx::read_json::<SnapshotRecord>(&bundle.snapshot(&id).join(RECORD)))
        .collect();
    out.sort_by(|a, b| (&b.created_at, &b.id).cmp(&(&a.created_at, &a.id)));
    out
}

/// Task snapshots beyond the newest `KEEP_TASKS` (records newest first).
pub fn tasks_to_prune(records: &[SnapshotRecord]) -> Vec<String> {
    records.iter().filter(|r| r.kind == "task").skip(KEEP_TASKS).map(|r| r.id.clone()).collect()
}

pub fn find(bundle: &Bundle, id: &str) -> VmResult<SnapshotRecord> {
    if !is_valid_id(id) {
        return Err(VmError::not_found("snapshot_not_found", format!("No snapshot {id}")));
    }
    load(bundle).into_iter().find(|r| r.id == id).ok_or_else(|| VmError::not_found("snapshot_not_found", format!("No snapshot {id}")))
}

pub struct SnapshotStore<'a> {
    pub disks: &'a dyn DiskOps,
}

impl SnapshotStore<'_> {
    /// Takes a snapshot of a resting guest (the caller checked and holds the busy claim).
    pub fn create(
        &self,
        bundle: &Bundle,
        config: &VmConfig,
        kind: &str,
        label: Option<&str>,
        task_id: Option<&str>,
        now_secs: u64,
    ) -> VmResult<SnapshotRecord> {
        if !KINDS.contains(&kind) {
            return Err(VmError::invalid_params("kind is base, manual or task", "kind"));
        }
        let existing = load(bundle);
        if kind == "manual" && existing.iter().filter(|r| r.kind == "manual").count() >= MAX_MANUAL {
            return Err(VmError::conflict(
                "snapshot_limit",
                format!("{} already has {MAX_MANUAL} snapshots; delete one first", config.name),
            ));
        }
        let (system, session) = (bundle.system_disk(), bundle.session_disk());
        if !system.is_file() || !session.is_file() {
            return Err(VmError::conflict("vm_not_installed", format!("{} has no disks to snapshot", config.name)));
        }
        let id = new_id(kind, now_secs);
        let dir = bundle.snapshot(&id);
        fsx::create_dir_all(&dir)?;
        let layer_sys = dir.join(SYSTEM);
        let layer_ses = dir.join(SESSION);
        let undo = |moved_sys: bool, moved_ses: bool| {
            if moved_sys {
                let _ = std::fs::remove_file(&system);
                let _ = std::fs::rename(&layer_sys, &system);
            }
            if moved_ses {
                let _ = std::fs::remove_file(&session);
                let _ = std::fs::rename(&layer_ses, &session);
            }
            let _ = fsx::remove(&dir);
        };
        // The leaves have no children, so moving them breaks nothing.
        if let Err(e) = std::fs::rename(&system, &layer_sys) {
            undo(false, false);
            return Err(VmError::io("system.vhdx", &e));
        }
        if let Err(e) = std::fs::rename(&session, &layer_ses) {
            undo(true, false);
            return Err(VmError::io("sessiondata.vhdx", &e));
        }
        let result = (|| -> VmResult<SnapshotRecord> {
            self.disks.create_differencing(&system, &layer_sys)?;
            self.disks.create_differencing(&session, &layer_ses)?;
            let state = fsx::read_json::<VmState>(&bundle.state()).unwrap_or_else(|| VmState::new(Phase::Stopped, ""));
            fsx::write_json(&dir.join("state.json"), &state)?;
            let saved = bundle.saved_state().is_file();
            if saved {
                std::fs::copy(bundle.saved_state(), dir.join(SAVED)).map_err(|e| VmError::io("saved state", &e))?;
            }
            let label =
                label.filter(|l| !l.is_empty()).map(|l| l.chars().take(120).collect()).unwrap_or_else(|| default_label(kind).to_owned());
            let record = SnapshotRecord {
                id: id.clone(),
                label,
                kind: kind.to_owned(),
                task_id: task_id.map(str::to_owned),
                created_at: crate::model::iso8601(now_secs),
                guest_os: config.guest_os.clone(),
                bytes: fsx::size(&dir),
                saved_state: saved,
                provisioned: state.provisioned,
                psyche_installed: state.psyche_installed,
                method: METHOD.into(),
            };
            fsx::write_json(&dir.join(RECORD), &record)?;
            Ok(record)
        })();
        let record = match result {
            Ok(r) => r,
            Err(e) => {
                let _ = std::fs::remove_file(&system);
                let _ = std::fs::remove_file(&session);
                undo(true, true);
                return Err(e);
            }
        };
        // One base per guest: the previous one becomes a manual snapshot.
        if kind == "base" {
            for mut old in existing.iter().filter(|r| r.kind == "base").cloned() {
                old.kind = "manual".into();
                let _ = fsx::write_json(&bundle.snapshot(&old.id).join(RECORD), &old);
            }
        }
        let mut all = vec![record.clone()];
        all.extend(existing);
        for prune in tasks_to_prune(&all) {
            let _ = self.retire(bundle, &prune);
        }
        self.collect_garbage(bundle);
        Ok(record)
    }

    /// Replaces the guest's leaves (and saved state) with fresh children of the snapshot's
    /// layers. New children are made beside the old leaves first, so a failure keeps the guest.
    pub fn restore(&self, bundle: &Bundle, id: &str, now: &str) -> VmResult<(SnapshotRecord, VmState)> {
        let record = find(bundle, id)?;
        let dir = bundle.snapshot(id);
        let new_sys = bundle.root.join(".restore-system.vhdx");
        let new_ses = bundle.root.join(".restore-sessiondata.vhdx");
        let _ = std::fs::remove_file(&new_sys);
        let _ = std::fs::remove_file(&new_ses);
        let made = (|| -> VmResult<()> {
            self.disks.create_differencing(&new_sys, &dir.join(SYSTEM))?;
            self.disks.create_differencing(&new_ses, &dir.join(SESSION))?;
            Ok(())
        })();
        if let Err(e) = made {
            let _ = std::fs::remove_file(&new_sys);
            let _ = std::fs::remove_file(&new_ses);
            return Err(e);
        }
        for (new, leaf) in [(&new_sys, bundle.system_disk()), (&new_ses, bundle.session_disk())] {
            let _ = std::fs::remove_file(&leaf);
            std::fs::rename(new, &leaf).map_err(|e| VmError::io("restore", &e))?;
        }
        let _ = std::fs::remove_file(bundle.saved_state());
        if record.saved_state {
            std::fs::copy(dir.join(SAVED), bundle.saved_state()).map_err(|e| VmError::io("saved state", &e))?;
        }
        let mut state = fsx::read_json::<VmState>(&dir.join("state.json")).unwrap_or_else(|| VmState::new(Phase::Stopped, now));
        state.phase = if record.saved_state {
            Phase::Saved
        } else if state.provisioned {
            Phase::Stopped
        } else {
            Phase::Installed
        };
        state.last_error = None;
        state.updated_at = now.to_owned();
        fsx::write_json(&bundle.state(), &state)?;
        self.collect_garbage(bundle);
        Ok((record, state))
    }

    pub fn delete(&self, bundle: &Bundle, id: &str) -> VmResult<()> {
        find(bundle, id)?;
        self.retire(bundle, id)?;
        self.collect_garbage(bundle);
        Ok(())
    }

    fn retire(&self, bundle: &Bundle, id: &str) -> VmResult<()> {
        let dir = bundle.snapshot(id);
        std::fs::rename(dir.join(RECORD), dir.join(RETIRED)).map_err(|e| VmError::io("snapshot", &e))
    }

    /// Removes retired (and half-made) snapshot folders no live disk is built on.
    pub fn collect_garbage(&self, bundle: &Bundle) {
        let Ok(rd) = std::fs::read_dir(bundle.snapshots()) else { return };
        let dirs: Vec<(PathBuf, bool)> = rd
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| {
                let p = e.path();
                let live = p.join(RECORD).is_file();
                (p, live)
            })
            .collect();
        // Every layer reachable from the leaves and from live snapshots stays.
        let mut keep: HashSet<String> = HashSet::new();
        let mut frontier: Vec<PathBuf> = vec![bundle.system_disk(), bundle.session_disk()];
        for (d, live) in &dirs {
            if *live {
                frontier.push(d.join(SYSTEM));
                frontier.push(d.join(SESSION));
            }
        }
        while let Some(p) = frontier.pop() {
            if !p.is_file() || !keep.insert(key(&p)) {
                continue;
            }
            if let Ok(Some(parent)) = self.disks.parent_of(&p) {
                frontier.push(parent);
            }
        }
        for (d, live) in dirs {
            if live {
                continue;
            }
            let used = [SYSTEM, SESSION].iter().any(|f| keep.contains(&key(&d.join(f))));
            let name = d.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !used && (is_valid_id(name) || name.starts_with(".tmp-")) {
                let _ = fsx::remove(&d);
            }
        }
    }
}

fn key(p: &Path) -> String {
    p.to_string_lossy().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vhd::FakeDisks;

    fn setup(tag: &str) -> (PathBuf, Bundle, VmConfig) {
        let home = std::env::temp_dir().join(format!("psyche-vm-snap-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let b = Bundle::new(&home, "sandbox");
        std::fs::create_dir_all(&b.root).unwrap();
        let image = home.join("rootfs.vhdx");
        FakeDisks.create_dynamic(&image, 1).unwrap();
        FakeDisks.create_differencing(&b.system_disk(), &image).unwrap();
        FakeDisks.create_dynamic(&b.session_disk(), 10).unwrap();
        let mut s = VmState::new(Phase::Stopped, "t");
        s.provisioned = true;
        fsx::write_json(&b.state(), &s).unwrap();
        let c = VmConfig::new("sandbox", "t");
        fsx::write_json(&b.config(), &c).unwrap();
        (home, b, c)
    }

    #[test]
    fn snapshot_restore_delete_cycle() {
        let (home, b, c) = setup("cycle");
        let store = SnapshotStore { disks: &FakeDisks };
        let s1 = store.create(&b, &c, "base", None, None, 1_000).unwrap();
        assert_eq!(s1.label, "Fresh PC");
        assert_eq!(s1.method, METHOD);
        assert!(s1.provisioned && !s1.saved_state);
        // The leaf is now a child of the snapshot layer.
        assert_eq!(FakeDisks.parent_of(&b.system_disk()).unwrap(), Some(b.snapshot(&s1.id).join(SYSTEM)));
        assert_eq!(FakeDisks.parent_of(&b.session_disk()).unwrap(), Some(b.snapshot(&s1.id).join(SESSION)));
        // A saved state travels with the snapshot.
        std::fs::write(b.saved_state(), "mem").unwrap();
        let s2 = store.create(&b, &c, "manual", Some("before upgrade"), None, 2_000).unwrap();
        assert!(s2.saved_state);
        assert_eq!(load(&b).iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec![s2.id.as_str(), s1.id.as_str()]);
        // Restore to the base: new leaves over the base's layers, saved state removed.
        let (r, state) = store.restore(&b, &s1.id, "t3").unwrap();
        assert_eq!(r.id, s1.id);
        assert_eq!(state.phase, Phase::Stopped);
        assert!(!b.saved_state().exists());
        assert_eq!(FakeDisks.parent_of(&b.system_disk()).unwrap(), Some(b.snapshot(&s1.id).join(SYSTEM)));
        // Restoring s2 brings its saved state back.
        let (_, state) = store.restore(&b, &s2.id, "t4").unwrap();
        assert_eq!(state.phase, Phase::Saved);
        assert!(b.saved_state().exists());
        // Deleting the base keeps its layers (s2 and the leaves are built on them) but hides it.
        store.delete(&b, &s1.id).unwrap();
        assert_eq!(load(&b).len(), 1);
        assert!(b.snapshot(&s1.id).join(SYSTEM).exists(), "layer still in use");
        // Once s2 is gone too and the leaves move to a fresh chain, both layers are collected.
        store.delete(&b, &s2.id).unwrap();
        assert!(b.snapshot(&s2.id).exists(), "leaves still use s2");
        assert_eq!(find(&b, &s2.id).unwrap_err().reason, "snapshot_not_found");
        let _ = std::fs::remove_file(b.system_disk());
        let _ = std::fs::remove_file(b.session_disk());
        FakeDisks.create_differencing(&b.system_disk(), &home.join("rootfs.vhdx")).unwrap();
        FakeDisks.create_dynamic(&b.session_disk(), 10).unwrap();
        store.collect_garbage(&b);
        assert!(!b.snapshot(&s1.id).exists() && !b.snapshot(&s2.id).exists());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn limits_and_pruning() {
        let (home, b, c) = setup("limits");
        let store = SnapshotStore { disks: &FakeDisks };
        for i in 0..5 {
            store.create(&b, &c, "task", None, Some("t"), 10 + i).unwrap();
        }
        let tasks: Vec<_> = load(&b).into_iter().filter(|r| r.kind == "task").collect();
        assert_eq!(tasks.len(), KEEP_TASKS);
        for i in 0..MAX_MANUAL as u64 {
            store.create(&b, &c, "manual", None, None, 100 + i).unwrap();
        }
        assert_eq!(store.create(&b, &c, "manual", None, None, 200).unwrap_err().reason, "snapshot_limit");
        assert_eq!(store.create(&b, &c, "weird", None, None, 200).unwrap_err().details["field"], "kind");
        // Two bases: the older one becomes manual.
        let b1 = store.create(&b, &c, "base", None, None, 300).unwrap();
        let b2 = store.create(&b, &c, "base", None, None, 301).unwrap();
        let all = load(&b);
        assert_eq!(all.iter().filter(|r| r.kind == "base").map(|r| &r.id).collect::<Vec<_>>(), vec![&b2.id]);
        assert_eq!(all.iter().find(|r| r.id == b1.id).unwrap().kind, "manual");
        assert_eq!(find(&b, "../x").unwrap_err().reason, "snapshot_not_found");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn snapshot_needs_disks_and_records_match_the_protocol() {
        let (home, b, c) = setup("nodisk");
        std::fs::remove_file(b.session_disk()).unwrap();
        let store = SnapshotStore { disks: &FakeDisks };
        assert_eq!(store.create(&b, &c, "manual", None, None, 1).unwrap_err().reason, "vm_not_installed");
        assert!(b.system_disk().exists(), "nothing moved on failure");
        let r = SnapshotRecord {
            id: "manual-1".into(),
            label: "x".into(),
            kind: "manual".into(),
            task_id: None,
            created_at: "t".into(),
            guest_os: None,
            bytes: 1,
            saved_state: false,
            provisioned: true,
            psyche_installed: false,
            method: METHOD.into(),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert!(v.get("guestOS").unwrap().is_null(), "guestOS is required and nullable");
        assert!(v.get("taskId").is_none());
        assert!(new_id("task", 1_793_836_800).starts_with("task-20261105-000000-"));
        assert!(is_valid_id(&new_id("base", 5)));
        let _ = std::fs::remove_dir_all(home);
    }
}
