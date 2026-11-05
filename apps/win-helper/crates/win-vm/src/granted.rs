//! Granted folders (Settings → Permissions → Folders): `permissions.folders[].path` in
//! `$PSYCHE_HOME\config.json`, the mac helper's `FinderRoots`. `copy_out` only writes inside them.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::error::{VmError, VmResult};
use crate::shares::{canonical_host_path, is_within, resolve_existing};

pub struct GrantedFolders {
    pub roots: Vec<String>,
}

impl GrantedFolders {
    /// Reads the Gateway's config (as the owner).
    pub fn load(home: &Path) -> GrantedFolders {
        let paths: Vec<String> = std::fs::read(home.join("config.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v.get("permissions")?.get("folders")?.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|f| f.get("path")?.as_str().map(str::to_owned))
            .collect();
        GrantedFolders::new(&paths)
    }

    pub fn new(paths: &[String]) -> GrantedFolders {
        let roots = paths.iter().filter_map(|p| canonical_host_path(p).ok()).map(|c| resolve_existing(&c).unwrap_or(c)).collect();
        GrantedFolders { roots }
    }

    /// The resolved folder when it is an existing directory inside a granted root.
    pub fn resolve_dir(&self, path: &str) -> VmResult<PathBuf> {
        let canonical = canonical_host_path(path).map_err(|_| VmError::invalid_params("hostDir must be an absolute folder", "hostDir"))?;
        if self.roots.is_empty() {
            return Err(VmError::policy_denied(
                "no_granted_folders",
                "No folders are granted. Add one in Settings → Permissions → Folders.",
            ));
        }
        let resolved = resolve_existing(&canonical)
            .ok_or_else(|| VmError::not_found("not_a_directory", format!("{path} is not an existing folder")))?;
        if !self.roots.iter().any(|r| is_within(&resolved, r)) || !self.roots.iter().any(|r| is_within(&canonical, r)) {
            return Err(
                VmError::policy_denied("outside_granted_folders", format!("{path} is outside the granted folders")).detail("path", path)
            );
        }
        if !Path::new(&resolved).is_dir() {
            return Err(VmError::not_found("not_a_directory", format!("{path} is not an existing folder")));
        }
        Ok(PathBuf::from(resolved))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_inside_granted_roots_only() {
        let base = std::env::temp_dir().join(format!("psyche-vm-granted-{}", std::process::id()));
        let granted = base.join("granted");
        std::fs::create_dir_all(granted.join("sub")).unwrap();
        std::fs::create_dir_all(base.join("other")).unwrap();
        std::fs::write(
            base.join("config.json"),
            serde_json::json!({"permissions": {"folders": [{"path": granted.to_string_lossy()}]}}).to_string(),
        )
        .unwrap();
        let g = GrantedFolders::load(&base);
        assert_eq!(g.roots.len(), 1);
        g.resolve_dir(&granted.join("sub").to_string_lossy()).unwrap();
        let escape = format!(r"{}\..\other", granted.to_string_lossy());
        assert_eq!(g.resolve_dir(&escape).unwrap_err().reason, "outside_granted_folders");
        assert_eq!(g.resolve_dir(&granted.join("missing").to_string_lossy()).unwrap_err().reason, "not_a_directory");
        assert_eq!(GrantedFolders::new(&[]).resolve_dir(r"C:\x").unwrap_err().reason, "no_granted_folders");
        assert_eq!(g.resolve_dir("relative").unwrap_err().details["field"], "hostDir");
        let _ = std::fs::remove_dir_all(base);
    }
}
