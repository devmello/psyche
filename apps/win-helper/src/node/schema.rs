//! Tiny JSON Schema builder for capability `inputSchema`s (the draft 2020-12 subset the Gateway's
//! validator understands), output-identical to the Swift helper's `Schema`.

use serde_json::{Map, Value, json};

pub fn object(properties: Vec<(&str, Value)>, required: &[&str]) -> Value {
    object_with(properties, required, None, false)
}

pub fn object_with(properties: Vec<(&str, Value)>, required: &[&str], description: Option<&str>, additional: bool) -> Value {
    let mut props = Map::new();
    for (k, v) in properties {
        props.insert(k.to_owned(), v);
    }
    let mut o = Map::new();
    o.insert("type".into(), "object".into());
    o.insert("properties".into(), Value::Object(props));
    o.insert("additionalProperties".into(), additional.into());
    if !required.is_empty() {
        let mut r: Vec<&str> = required.to_vec();
        r.sort_unstable();
        o.insert("required".into(), json!(r));
    }
    if let Some(d) = description {
        o.insert("description".into(), d.into());
    }
    Value::Object(o)
}

pub fn empty() -> Value {
    object(vec![], &[])
}

pub fn string(description: Option<&str>) -> Value {
    string_with(description, None, None)
}

pub fn string_with(description: Option<&str>, enum_values: Option<&[&str]>, max_length: Option<u64>) -> Value {
    let mut o = Map::new();
    o.insert("type".into(), "string".into());
    if let Some(d) = description {
        o.insert("description".into(), d.into());
    }
    if let Some(e) = enum_values {
        o.insert("enum".into(), json!(e));
    }
    if let Some(m) = max_length {
        o.insert("maxLength".into(), json!(m as f64));
    }
    Value::Object(o)
}

pub fn string_enum(description: Option<&str>, values: &[&str]) -> Value {
    string_with(description, Some(values), None)
}

pub fn string_max(description: Option<&str>, max_length: u64) -> Value {
    string_with(description, None, Some(max_length))
}

/// A string with a `pattern` (notification ids).
pub fn string_pattern(description: &str, pattern: &str, max_length: u64) -> Value {
    let mut v = string_max(Some(description), max_length);
    v["pattern"] = pattern.into();
    v
}

pub fn integer(description: Option<&str>, min: Option<i64>, max: Option<i64>) -> Value {
    let mut o = Map::new();
    o.insert("type".into(), "integer".into());
    if let Some(d) = description {
        o.insert("description".into(), d.into());
    }
    if let Some(m) = min {
        o.insert("minimum".into(), json!(m as f64));
    }
    if let Some(m) = max {
        o.insert("maximum".into(), json!(m as f64));
    }
    Value::Object(o)
}

pub fn number(description: Option<&str>, min: Option<f64>, max: Option<f64>) -> Value {
    let mut o = Map::new();
    o.insert("type".into(), "number".into());
    if let Some(d) = description {
        o.insert("description".into(), d.into());
    }
    if let Some(m) = min {
        o.insert("minimum".into(), json!(m));
    }
    if let Some(m) = max {
        o.insert("maximum".into(), json!(m));
    }
    Value::Object(o)
}

pub fn boolean(description: Option<&str>) -> Value {
    let mut o = Map::new();
    o.insert("type".into(), "boolean".into());
    if let Some(d) = description {
        o.insert("description".into(), d.into());
    }
    Value::Object(o)
}

pub fn array(items: Value, description: Option<&str>, max_items: Option<u64>) -> Value {
    let mut o = Map::new();
    o.insert("type".into(), "array".into());
    o.insert("items".into(), items);
    if let Some(d) = description {
        o.insert("description".into(), d.into());
    }
    if let Some(m) = max_items {
        o.insert("maxItems".into(), json!(m as f64));
    }
    Value::Object(o)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_sorts_required_and_closes_properties() {
        let s = object(vec![("b", boolean(None)), ("a", string(Some("x")))], &["b", "a"]);
        assert_eq!(s["type"], "object");
        assert_eq!(s["additionalProperties"], false);
        assert_eq!(s["required"], json!(["a", "b"]));
        assert_eq!(s["properties"]["a"], json!({"type": "string", "description": "x"}));
        assert!(empty().get("required").is_none());
    }

    #[test]
    fn numeric_bounds_are_numbers() {
        assert_eq!(integer(None, Some(1), Some(500)), json!({"type": "integer", "minimum": 1.0, "maximum": 500.0}));
        assert_eq!(array(string(None), None, Some(20))["maxItems"], json!(20.0));
    }
}
