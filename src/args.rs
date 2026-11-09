//! Tool-argument validation: the JSON schemas advertise the rules, this enforces them and
//! fills in defaults. Null counts as absent; unknown keys are ignored.

use serde_json::{Map, Value};

use crate::time::is_date_shaped;

static EMPTY: std::sync::LazyLock<Map<String, Value>> = std::sync::LazyLock::new(Map::new);

pub struct Args<'a> {
    map: &'a Map<String, Value>,
    errors: Vec<String>,
}

/// A topic reference as given: an id or a URL / slug fragment.
#[derive(Debug, Clone)]
pub enum TopicRef {
    Id(i64),
    Text(String),
}

impl std::fmt::Display for TopicRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TopicRef::Id(n) => write!(f, "{n}"),
            TopicRef::Text(s) => f.write_str(s),
        }
    }
}

fn as_int(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 9.0e15).map(|f| f as i64))
}

impl<'a> Args<'a> {
    pub fn new(v: Option<&'a Value>) -> Self {
        Args { map: v.and_then(Value::as_object).unwrap_or(&EMPTY), errors: Vec::new() }
    }

    fn get(&self, key: &str) -> Option<&'a Value> {
        self.map.get(key).filter(|v| !v.is_null())
    }

    fn fail(&mut self, key: &str, msg: impl std::fmt::Display) {
        self.errors.push(format!("{key}: {msg}"));
    }

    /// Record an error when `key` is absent.
    pub fn require(&mut self, key: &str) {
        if self.get(key).is_none() {
            self.fail(key, "required");
        }
    }

    pub fn string(&mut self, key: &str, min: usize) -> Option<String> {
        match self.get(key)? {
            Value::String(s) if s.chars().count() >= min => Some(s.clone()),
            Value::String(_) => {
                self.fail(key, format_args!("must be at least {min} characters"));
                None
            }
            _ => {
                self.fail(key, "expected a string");
                None
            }
        }
    }

    pub fn int_opt(&mut self, key: &str, min: i64, max: Option<i64>) -> Option<i64> {
        let v = self.get(key)?;
        match as_int(v) {
            Some(n) if n < min => self.fail(key, format_args!("must be at least {min}")),
            Some(n) if max.is_some_and(|m| n > m) => self.fail(key, format_args!("must be at most {}", max.unwrap())),
            Some(n) => return Some(n),
            None => self.fail(key, "expected an integer"),
        }
        None
    }

    pub fn int(&mut self, key: &str, default: i64, min: i64, max: Option<i64>) -> i64 {
        if self.get(key).is_none() {
            return default;
        }
        self.int_opt(key, min, max).unwrap_or(default)
    }

    pub fn boolean(&mut self, key: &str, default: bool) -> bool {
        match self.get(key) {
            None => default,
            Some(Value::Bool(b)) => *b,
            Some(_) => {
                self.fail(key, "expected a boolean");
                default
            }
        }
    }

    pub fn choice(&mut self, key: &str, allowed: &[&'static str], default: &'static str) -> &'static str {
        match self.get(key) {
            None => default,
            Some(Value::String(s)) => match allowed.iter().find(|a| **a == s) {
                Some(a) => a,
                None => {
                    self.fail(key, format_args!("expected one of {}", allowed.join(", ")));
                    default
                }
            },
            Some(_) => {
                self.fail(key, "expected a string");
                default
            }
        }
    }

    pub fn choices(&mut self, key: &str, allowed: &[&'static str]) -> Option<Vec<&'static str>> {
        let list = self.strings(key, 0, 0, None)?;
        let mut out = Vec::new();
        for item in list {
            match allowed.iter().find(|a| **a == item) {
                Some(a) => out.push(*a),
                None => self.fail(key, format_args!("\"{item}\" is not one of {}", allowed.join(", "))),
            }
        }
        Some(out)
    }

    pub fn strings(&mut self, key: &str, min_len: usize, min_items: usize, max_items: Option<usize>) -> Option<Vec<String>> {
        let v = self.get(key)?;
        let Some(items) = v.as_array() else {
            self.fail(key, "expected an array of strings");
            return None;
        };
        if items.len() < min_items {
            self.fail(key, format_args!("needs at least {min_items} item(s)"));
            return None;
        }
        if max_items.is_some_and(|m| items.len() > m) {
            self.fail(key, format_args!("takes at most {} items", max_items.unwrap()));
            return None;
        }
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            match item.as_str() {
                Some(s) if s.chars().count() >= min_len => out.push(s.to_string()),
                Some(_) => {
                    self.fail(key, format_args!("each entry must be at least {min_len} characters"));
                    return None;
                }
                None => {
                    self.fail(key, "expected an array of strings");
                    return None;
                }
            }
        }
        Some(out)
    }

    /// A string, or an array of up to `max` strings.
    pub fn string_or_list(&mut self, key: &str, min_len: usize, max: usize) -> Option<Vec<String>> {
        match self.get(key) {
            None => {
                self.fail(key, "required");
                None
            }
            Some(Value::String(_)) => self.string(key, min_len).map(|s| vec![s]),
            Some(Value::Array(_)) => self.strings(key, min_len, 1, Some(max)),
            Some(_) => {
                self.fail(key, "expected a string or an array of strings");
                None
            }
        }
    }

    pub fn date(&mut self, key: &str) -> Option<String> {
        let s = self.string(key, 0)?;
        if is_date_shaped(&s) {
            Some(s)
        } else {
            self.fail(key, "expected YYYY-MM-DD");
            None
        }
    }

    pub fn topic(&mut self, key: &str) -> Option<TopicRef> {
        match self.get(key)? {
            Value::String(s) => Some(TopicRef::Text(s.clone())),
            v => match as_int(v) {
                Some(n) => Some(TopicRef::Id(n)),
                None => {
                    self.fail(key, "expected a topic id or a DevForum URL");
                    None
                }
            },
        }
    }

    /// `Err` with a readable message when any argument was invalid.
    pub fn finish(self, tool: &str) -> Result<(), String> {
        if self.errors.is_empty() { Ok(()) } else { Err(format!("Invalid arguments for tool {tool}: {}", self.errors.join("; "))) }
    }
}
