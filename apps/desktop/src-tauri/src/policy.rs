use crate::common::{HostError, HostResult};
use regex::{Regex, RegexBuilder};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

static CATALOG: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("action-contracts.json")).expect("generated action catalog")
});
static PATTERNS: LazyLock<HashMap<String, Regex>> = LazyLock::new(|| {
    fn collect(value: &Value, patterns: &mut HashMap<String, Regex>) {
        if value["kind"] == "pattern" {
            let pattern = value["value"].as_str().expect("pattern string");
            patterns.entry(pattern.into()).or_insert_with(|| {
                RegexBuilder::new(pattern)
                    .unicode(false)
                    .build()
                    .expect("generated pattern")
            });
        }
        match value {
            Value::Object(map) => {
                for child in map.values() {
                    collect(child, patterns);
                }
            }
            Value::Array(items) => {
                for child in items {
                    collect(child, patterns);
                }
            }
            _ => {}
        }
    }
    let mut patterns = HashMap::new();
    collect(&CATALOG, &mut patterns);
    patterns
});

pub fn action_contract(action_id: &str) -> Option<&'static Value> {
    CATALOG.get(action_id)
}
fn invalid() -> HostError {
    HostError::new("INVALID_ACTION_PARAMETERS", "Action 参数不符合策略 Schema")
}
fn length(value: &str) -> usize {
    value.encode_utf16().count()
}
fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn number(value: &Value, key: &str) -> u64 {
    field(value, key).parse().unwrap_or(0)
}
fn matches(pattern: &str, value: &str) -> bool {
    Regex::new(pattern)
        .map(|regex| regex.is_match(value))
        .unwrap_or(false)
}
fn no_control(value: &str) -> bool {
    !value.chars().any(|ch| ch <= '\u{1f}' || ch == '\u{7f}')
}

pub fn authorize(
    connection: &Value,
    action_id: &str,
    parameters: &Value,
    maximum_risk: &str,
    version: &str,
) -> HostResult<Value> {
    if connection["state"] != "READY" {
        return Err(HostError::new(
            "TARGET_NOT_CONNECTED",
            "目标 JVM 尚未建立可用连接",
        ));
    }
    if version != "1.0" {
        return Err(HostError::new(
            "ACTION_CONTRACT_VERSION_UNSUPPORTED",
            "不支持的 Action Contract 版本",
        ));
    }
    let contract = action_contract(action_id).ok_or_else(|| {
        HostError::new(
            "ACTION_NOT_ALLOWED",
            format!("策略不允许 Action：{action_id}"),
        )
    })?;
    let capability = connection["capabilities"].as_array().and_then(|items| {
        items
            .iter()
            .find(|item| item["id"] == contract["requiredCapability"])
    });
    if !capability.is_some_and(|value| value["state"] == "AVAILABLE") {
        return Err(HostError::new(
            "CAPABILITY_UNAVAILABLE",
            capability
                .and_then(|value| value["reason"].as_str())
                .unwrap_or("目标不支持所需能力"),
        ));
    }
    if risk(contract["riskLevel"].as_str().unwrap_or(""))? > risk(maximum_risk)? {
        return Err(HostError::new(
            "ACTION_DISABLED_BY_POLICY",
            "本机策略禁止此风险等级操作",
        ));
    }
    validate_schema(&contract["parameters"], parameters)
}

pub fn validate_template_action(action_id: &str, parameters: &Value) -> HostResult<Value> {
    let contract = action_contract(action_id)
        .ok_or_else(|| HostError::new("ACTION_NOT_ALLOWED", "不支持的 Action"))?;
    if risk(field(contract, "riskLevel"))? > 1 {
        return Err(HostError::new(
            "TEMPLATE_RISK_NOT_ALLOWED",
            "诊断模板只允许 R0/R1 Action",
        ));
    }
    Ok(
        json!({"actionId":action_id,"parameters":validate_schema(&contract["parameters"],parameters)?,"riskLevel":contract["riskLevel"]}),
    )
}

pub fn effective_risk(action: &str, local: &str, team: &Value) -> HostResult<String> {
    risk(local)?;
    if team.is_null() {
        return Ok(local.into());
    }
    if !crate::governance::verify_team_policy(team)
        || crate::governance::public_key_fingerprint(field(team, "publicKey"))?
            != field(team, "publicKeyFingerprint")
    {
        return Err(HostError::new(
            "TEAM_POLICY_INVALID",
            "已启用的团队策略签名无效",
        ));
    }
    if let Some(expires) = team["expiresAt"].as_str() {
        let expires = chrono::DateTime::parse_from_rfc3339(expires)
            .map_err(|_| HostError::new("TEAM_POLICY_INVALID", "团队策略有效期无效"))?;
        if expires.timestamp_millis() <= chrono::Utc::now().timestamp_millis() {
            return Err(HostError::new("TEAM_POLICY_EXPIRED", "团队策略已过期"));
        }
    }
    if team["deniedActions"]
        .as_array()
        .is_some_and(|items| items.iter().any(|value| value == action))
    {
        return Err(HostError::new(
            "ACTION_DISABLED_BY_TEAM_POLICY",
            "团队策略已禁用此 Action",
        ));
    }
    let maximum = field(team, "maximumRiskLevel");
    Ok(if risk(local)? <= risk(maximum)? {
        local
    } else {
        maximum
    }
    .into())
}

fn risk(value: &str) -> HostResult<u8> {
    match value {
        "R0" => Ok(0),
        "R1" => Ok(1),
        "R2" => Ok(2),
        "R3" => Ok(3),
        "R4" => Ok(4),
        _ => Err(HostError::new("INVALID_POLICY", "风险等级无效")),
    }
}

fn validate_schema(schema: &Value, input: &Value) -> HostResult<Value> {
    let mut value = input.clone();
    match field(schema, "type") {
        "union" => {
            return schema["options"]
                .as_array()
                .and_then(|items| {
                    items
                        .iter()
                        .find_map(|option| validate_schema(option, input).ok())
                })
                .ok_or_else(invalid)
        }
        "object" => {
            let map = value.as_object_mut().ok_or_else(invalid)?;
            let fields = schema["properties"].as_object().ok_or_else(invalid)?;
            if map.keys().any(|key| !fields.contains_key(key)) {
                return Err(invalid());
            }
            for (key, child) in fields {
                if let Some(input) = map.get(key) {
                    let result = validate_schema(child, input)?;
                    map.insert(key.clone(), result);
                } else if child["optional"] != true {
                    return Err(invalid());
                }
            }
        }
        "string" => {
            if !value.is_string() {
                return Err(invalid());
            }
        }
        _ => return Err(invalid()),
    }
    if let Some(values) = schema["values"].as_array() {
        if !values.contains(&value) {
            return Err(invalid());
        }
    }
    if let Some(checks) = schema["checks"].as_array() {
        for check in checks {
            if check["kind"] == "trim" {
                value = Value::String(value.as_str().ok_or_else(invalid)?.trim().into());
                continue;
            }
            if check["kind"] == "action" {
                if !action_refinement(field(check, "value"), &value) {
                    return Err(invalid());
                }
                continue;
            }
            let text = value.as_str().ok_or_else(invalid)?;
            let valid = match field(check, "kind") {
                "min" => length(text) >= check["value"].as_u64().unwrap_or(u64::MAX) as usize,
                "max" => length(text) <= check["value"].as_u64().unwrap_or(0) as usize,
                "pattern" => PATTERNS
                    .get(field(check, "value"))
                    .is_some_and(|regex| regex.is_match(text)),
                "integer" => text.parse::<u64>().ok().is_some_and(|n| {
                    n <= 9_007_199_254_740_991
                        && n >= check["minimum"].as_u64().unwrap_or(u64::MAX)
                        && n <= check["maximum"].as_u64().unwrap_or(0)
                }),
                "singleLine" => !text.contains(['\r', '\n']),
                "noControl" => no_control(text),
                "noNul" => !text.contains('\0'),
                "nonJdkScope" => !matches(r"^(?:java|javax|jdk|sun|com\.sun)(?:\.|$)", text),
                "resourceName" => {
                    !text.starts_with('/')
                        && !text.contains(['\\', '\r', '\n', '\0'])
                        && text
                            .split('/')
                            .all(|part| !part.is_empty() && part != "." && part != "..")
                }
                "phases" => {
                    let items: Vec<_> = text.split(',').collect();
                    items.len() <= 4
                        && !items.is_empty()
                        && items.iter().collect::<HashSet<_>>().len() == items.len()
                        && items
                            .iter()
                            .all(|phase| matches!(*phase, "BEFORE" | "RETURN" | "THROW" | "FINISH"))
                }
                "profilerRules" => {
                    let items: Vec<_> = text
                        .lines()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .collect();
                    items.len() <= 8
                        && items.iter().collect::<HashSet<_>>().len() == items.len()
                        && items.iter().all(|s| {
                            length(s) <= 128
                                && *s != "*"
                                && !s.chars().any(|ch| ch <= '\u{1f}' || ch == ',')
                                && matches(r"^\*?[^*]+\*?$", s)
                        })
                }
                "traceRules" => {
                    let items: Vec<_> = text.split('\n').filter(|s| !s.is_empty()).collect();
                    items.len()<=16&&items.iter().all(|s|*s==s.trim()&&length(s)<=512&&!s.contains(".*#")&&matches(r"^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+(?:\.\*)?(?:#[A-Za-z_$][A-Za-z0-9_$]*)?$",s))
                }
                "counterNames" => {
                    let items: Vec<_> = text.split('\n').collect();
                    items.len() <= 8
                        && !items.is_empty()
                        && items.iter().collect::<HashSet<_>>().len() == items.len()
                        && items.iter().all(|s| {
                            !s.is_empty() && *s == s.trim() && length(s) <= 256 && no_control(s)
                        })
                }
                "observationCondition" => observation_condition(text),
                _ => false,
            };
            if !valid {
                return Err(invalid());
            }
        }
    }
    Ok(value)
}

fn action_refinement(action: &str, value: &Value) -> bool {
    match action {
        "mbean.operation.preview" | "mbean.operation.invoke" => {
            let count = number(value, "argumentCount") as usize;
            let mut total = 0;
            for i in 0..8 {
                let argument = field(value, &format!("argument{i}"));
                let format = field(value, &format!("argumentFormat{i}"));
                if i >= count {
                    if !argument.is_empty() || value.get(format!("argumentFormat{i}")).is_some() {
                        return false;
                    }
                } else {
                    total += length(argument);
                    if (format.is_empty() || format == "SCALAR")
                        && (length(argument) > 512 || argument.contains(['\r', '\n']))
                    {
                        return false;
                    }
                    if format == "OPEN_TYPE_JSON" && argument.is_empty() {
                        return false;
                    }
                }
            }
            total <= 32768
        }
        "mbean.attribute.write.preview" | "mbean.attribute.write" => {
            let text = field(value, "proposedValue");
            if field(value, "valueFormat") == "OPEN_TYPE_JSON" {
                !text.contains('\0')
            } else {
                length(text) <= 512 && !text.contains(['\r', '\n'])
            }
        }
        "logger.level.preview" | "logger.level.set" => {
            let allowed = match field(value, "framework") {
                "JUL" => "<inherited>,OFF,SEVERE,WARNING,INFO,CONFIG,FINE,FINER,FINEST,ALL",
                "LOGBACK" => "<inherited>,OFF,ERROR,WARN,INFO,DEBUG,TRACE,ALL",
                "LOG4J" => "<inherited>,OFF,FATAL,ERROR,WARN,INFO,DEBUG,TRACE,ALL",
                "LOG4J2" => "OFF,FATAL,ERROR,WARN,INFO,DEBUG,TRACE,ALL",
                _ => return false,
            };
            allowed
                .split(',')
                .any(|level| level == field(value, "newLevel"))
        }
        "classloader.metaspace" => number(value, "periodMillis") <= number(value, "durationMillis"),
        "trace.preview" | "trace.start" => {
            let scope = field(value, "scopePrefix");
            ["includeRules", "excludeRules"].iter().all(|key| {
                field(value, key)
                    .split('\n')
                    .filter(|rule| !rule.is_empty())
                    .all(|rule| {
                        let path = rule.split('#').next().unwrap_or("").trim_end_matches(".*");
                        path == scope || path.starts_with(&format!("{scope}."))
                    })
            })
        }
        "class.change-set.preview" | "class.change-set.apply" => {
            let count = number(value, "count") as usize;
            let mut loader = "";
            let mut total = 0;
            let mut names = HashSet::new();
            for i in 0..8 {
                let name = field(value, &format!("item{i}Name"));
                let current = field(value, &format!("item{i}ClassLoader"));
                let bytes = field(value, &format!("item{i}BytecodeBase64"));
                if i >= count {
                    if ["Name", "ClassLoader", "BytecodeBase64"]
                        .iter()
                        .any(|suffix| value.get(format!("item{i}{suffix}")).is_some())
                    {
                        return false;
                    }
                } else {
                    if name.is_empty()
                        || current.is_empty()
                        || bytes.is_empty()
                        || !names.insert(name)
                    {
                        return false;
                    }
                    if i == 0 {
                        loader = current;
                    } else if loader != current {
                        return false;
                    }
                    total += length(bytes);
                }
            }
            total <= 2_800_000
        }
        "snapshot.list" => {
            number(value, "maximumDurationMillis") == 0
                || number(value, "maximumDurationMillis") >= number(value, "minimumDurationMillis")
        }
        "invoke.replay.preview" | "invoke.replay" => {
            (field(value, "replayMode") != "INSTANCE" || value.get("snapshotId").is_some())
                && (number(value, "argumentCount") as usize..8)
                    .all(|i| field(value, &format!("argument{i}")).is_empty())
        }
        _ => false,
    }
}

fn observation_condition(input: &str) -> bool {
    let text = input.trim();
    if text.is_empty() {
        return true;
    }
    if length(text) > 512 || !no_control(text) {
        return false;
    }
    let mut quoted = false;
    let mut start = 0;
    let mut parts = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            quoted = !quoted;
        } else if !quoted && bytes[i] == b'&' && bytes.get(i + 1) == Some(&b'&') {
            parts.push(text[start..i].trim());
            i += 1;
            start = i + 1;
        }
        i += 1;
    }
    if quoted {
        return false;
    }
    parts.push(text[start..].trim());
    if parts.len() > 4 {
        return false;
    }
    parts.into_iter().all(|part| {
        if let Some(c) = Regex::new(r"^durationMs\s*(>=|>|<=|<|==)\s*(\d+(?:\.\d{1,3})?)$")
            .unwrap()
            .captures(part)
        {
            return c[2]
                .parse::<f64>()
                .is_ok_and(|n| (0.0..=60000.0).contains(&n));
        }
        if matches(r#"^outcome\s*==\s*"(RETURNED|THREW)"$"#, part) || part == "exception" {
            return true;
        }
        let Some(c) =
            Regex::new(r#"^(thread|return|exception|arg\d{1,2})\s*(==|contains)\s*"([^"]*)"$"#)
                .unwrap()
                .captures(part)
        else {
            return false;
        };
        let subject = &c[1];
        let value = &c[3];
        if subject == "thread" {
            length(value) <= 128
        } else if subject == "exception" {
            !value.is_empty() && length(value) <= 256
        } else if let Some(index) = subject.strip_prefix("arg") {
            index.parse::<u8>().is_ok_and(|i| i <= 15) && length(value) <= 256
        } else {
            length(value) <= 256
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_contracts_are_available() {
        assert_eq!(CATALOG.as_object().unwrap().len(), 96);
        assert!(!PATTERNS.is_empty());
    }
    #[test]
    fn rejects_bounds_and_unknown_parameters() {
        let schema = &CATALOG["jfr.start"]["parameters"];
        assert!(validate_schema(schema,&json!({"configuration":"PROFILE","maxAgeMillis":"86400000","maxSizeBytes":"10737418240"})).is_ok());
        assert!(validate_schema(
            schema,
            &json!({"configuration":"PROFILE","maxAgeMillis":"86400001","maxSizeBytes":"0"})
        )
        .is_err());
        assert!(validate_schema(schema,&json!({"configuration":"PROFILE","maxAgeMillis":"0","maxSizeBytes":"0","command":"anything"})).is_err());
    }
    #[test]
    fn condition_does_not_split_quoted_and() {
        assert!(observation_condition(
            "thread contains \"a && b\" && durationMs >= 0.125"
        ));
        assert!(!observation_condition("arg16 == \"x\""));
        assert!(!observation_condition("durationMs >= 0.0001"));
        assert!(!observation_condition("durationMs >= 60001"));
    }
    #[test]
    fn refuses_high_risk_templates() {
        assert_eq!(
            validate_template_action("heap.dump", &json!({"confirmed":"true","live":"true"}))
                .unwrap_err()
                .code,
            "TEMPLATE_RISK_NOT_ALLOWED"
        );
    }
}
#[cfg(test)]
mod golden;
