//! `cargo gen` / `cargo gen-check`: generates `crates/protocol/src/generated.rs` from
//! `packages/protocol/generated/schema.json` with `typify`, the Rust counterpart of
//! `packages/protocol/generated/swift` (`pnpm protocol:check` covers the schema itself; this
//! covers the Rust types derived from it).
//!
//! Only the node protocol's closure is generated (frames, `connect`, `node.*`, errors), not the
//! whole 1,600-definition schema: the helper speaks the node protocol and nothing else. To widen
//! it, add a root to `ROOTS`.
//!
//! Regex `pattern` keywords are dropped from the generated types (they would pull in a regex
//! engine for runtime validation the Gateway already does; the `connect` fields the helper builds
//! are checked by its own tests instead), and `patternProperties` maps become plain string maps.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde_json::{Map, Value};
use typify::{TypeSpace, TypeSpaceSettings};

/// Definitions the helper needs. Their `$ref` closure comes along.
const ROOTS: &[&str] = &[
    "ReqFrame",
    "ResOkFrame",
    "ResErrFrame",
    "EventFrame",
    "ErrorPayload",
    "ErrorCode",
    "ConnectParams",
    "ConnectChallenge",
    "ConnectVerifyParams",
    "ConnectPaired",
    "ConnectPending",
    "ConnectDenied",
    "NodeCapability",
    "NodeInvokeParams",
    "NodeInvokeAccepted",
    "NodeEventParams",
    "NodeResultParams",
    "Receipt",
];

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask has a parent")
        .to_path_buf()
}

fn schema_path() -> PathBuf {
    workspace_root().join("../../packages/protocol/generated/schema.json")
}

fn output_path() -> PathBuf {
    workspace_root().join("crates/protocol/src/generated.rs")
}

fn collect_refs(value: &Value, out: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, v) in map {
                if key == "$ref" {
                    if let Some(name) = v.as_str().and_then(|s| s.strip_prefix("#/$defs/")) {
                        out.insert(name.to_string());
                    }
                } else {
                    collect_refs(v, out);
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|v| collect_refs(v, out)),
        _ => {}
    }
}

/// Rewrites `#/$defs/X` to `#/definitions/X` (what `schemars` 0.8's `RootSchema` resolves) and
/// removes `pattern` and turns `patternProperties` into `additionalProperties`.
fn rewrite(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.remove("pattern");
            // `{"patternProperties": {"^(.*)$": X}}` is how TypeBox spells `Record<string, X>`.
            if let Some(Value::Object(pp)) = map.remove("patternProperties") {
                if let Some(first) = pp.into_iter().next().map(|(_, v)| v) {
                    map.insert("additionalProperties".into(), first);
                }
            }
            for (key, v) in map.iter_mut() {
                if key == "$ref" {
                    if let Some(s) = v.as_str() {
                        *v = Value::String(s.replace("#/$defs/", "#/definitions/"));
                    }
                } else {
                    rewrite(v);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(rewrite),
        _ => {}
    }
}

fn trimmed_schema(full: &Value) -> Result<Value, String> {
    let defs = full
        .get("$defs")
        .and_then(Value::as_object)
        .ok_or("schema.json has no $defs")?;
    let mut wanted: BTreeSet<String> = ROOTS.iter().map(|s| s.to_string()).collect();
    let mut queue: Vec<String> = wanted.iter().cloned().collect();
    while let Some(name) = queue.pop() {
        let def = defs
            .get(&name)
            .ok_or_else(|| format!("schema.json has no definition {name}"))?;
        let mut refs = BTreeSet::new();
        collect_refs(def, &mut refs);
        for r in refs {
            if wanted.insert(r.clone()) {
                queue.push(r);
            }
        }
    }
    let mut definitions = Map::new();
    for name in &wanted {
        let mut def = defs[name].clone();
        rewrite(&mut def);
        definitions.insert(name.clone(), def);
    }
    let mut root = Map::new();
    root.insert(
        "$schema".into(),
        Value::String("http://json-schema.org/draft-07/schema#".into()),
    );
    root.insert("definitions".into(), Value::Object(definitions));
    Ok(Value::Object(root))
}

fn generate() -> Result<String, String> {
    let path = schema_path();
    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let full: Value = serde_json::from_str(&raw).map_err(|e| format!("parse schema.json: {e}"))?;
    let trimmed = trimmed_schema(&full)?;
    let root: schemars::schema::RootSchema =
        serde_json::from_value(trimmed).map_err(|e| format!("schema shape: {e}"))?;

    let mut space = TypeSpace::new(TypeSpaceSettings::default().with_struct_builder(false));
    space
        .add_root_schema(root)
        .map_err(|e| format!("typify: {e}"))?;
    let file: syn::File = syn::parse2(space.to_stream()).map_err(|e| format!("syn: {e}"))?;
    let body = prettyplease::unparse(&file);
    Ok(format!(
        "// @generated by `cargo gen` (apps/linux-helper/xtask) from packages/protocol/generated/schema.json.\n\
         // Do not edit; run `cargo gen` after `pnpm --filter @psyche/protocol gen`.\n\n{body}"
    ))
}

fn main() -> ExitCode {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let generated = match generate() {
        Ok(text) => text,
        Err(message) => {
            eprintln!("xtask: {message}");
            return ExitCode::FAILURE;
        }
    };
    let out = output_path();
    match mode.as_str() {
        "gen" => {
            std::fs::write(&out, generated).expect("write generated.rs");
            println!("wrote {}", out.display());
            ExitCode::SUCCESS
        }
        "gen-check" => {
            let current = std::fs::read_to_string(&out).unwrap_or_default();
            if current == generated {
                println!("generated.rs is up to date");
                ExitCode::SUCCESS
            } else {
                eprintln!(
                    "generated.rs is stale: run `cargo gen` in apps/linux-helper and commit it"
                );
                ExitCode::FAILURE
            }
        }
        _ => {
            eprintln!("usage: cargo xtask <gen|gen-check>");
            ExitCode::FAILURE
        }
    }
}
