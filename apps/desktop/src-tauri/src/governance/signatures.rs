use crate::common::{HostError, HostResult};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::DateTime;
use ed25519_dalek::{
    pkcs8::{DecodePublicKey, EncodePublicKey},
    Signature, Signer, SigningKey, Verifier, VerifyingKey,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{cmp::Ordering, collections::HashSet};

pub(super) fn invalid(message: impl Into<String>) -> HostError {
    HostError::new("INVALID_GOVERNANCE_PACKAGE", message)
}

/// Match JSON.stringify(canonicalValue(...)), including JavaScript integer-index ordering.
pub fn canonical_json(value: &Value) -> HostResult<String> {
    match value {
        Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<HostResult<Vec<_>>>()?
                .join(",")
        )),
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort_by(|a, b| js_key_order(a, b));
            let entries = keys
                .into_iter()
                .map(|key| {
                    Ok(format!(
                        "{}:{}",
                        serde_json::to_string(key).map_err(|e| invalid(e.to_string()))?,
                        canonical_json(&object[key])?
                    ))
                })
                .collect::<HostResult<Vec<_>>>()?;
            Ok(format!("{{{}}}", entries.join(",")))
        }
        _ => serde_json::to_string(value).map_err(|e| invalid(e.to_string())),
    }
}
fn js_key_order(a: &str, b: &str) -> Ordering {
    fn index(key: &str) -> Option<u32> {
        let n = key.parse::<u32>().ok()?;
        (n < u32::MAX && n.to_string() == key).then_some(n)
    }
    match (index(a), index(b)) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        _ => a.encode_utf16().cmp(b.encode_utf16()),
    }
}
pub fn sign_canonical(key: &SigningKey, value: &Value) -> HostResult<String> {
    Ok(STANDARD.encode(key.sign(canonical_json(value)?.as_bytes()).to_bytes()))
}
pub fn verify_canonical(public_key: &str, value: &Value, signature: &str) -> bool {
    let checked = || -> HostResult<()> {
        let key =
            VerifyingKey::from_public_key_pem(public_key).map_err(|e| invalid(e.to_string()))?;
        let bytes = STANDARD
            .decode(signature)
            .map_err(|e| invalid(e.to_string()))?;
        let signature = Signature::from_slice(&bytes).map_err(|e| invalid(e.to_string()))?;
        key.verify(canonical_json(value)?.as_bytes(), &signature)
            .map_err(|e| invalid(e.to_string()))
    };
    checked().is_ok()
}
pub fn public_key_fingerprint(public_key: &str) -> HostResult<String> {
    let key = VerifyingKey::from_public_key_pem(public_key)
        .map_err(|_| invalid("签名公钥必须使用 Ed25519"))?;
    let document = key
        .to_public_key_der()
        .map_err(|e| invalid(e.to_string()))?;
    Ok(hex::encode(Sha256::digest(document.as_bytes())))
}
pub fn payload(value: &Value, fields: &[&str]) -> Value {
    Value::Object(
        fields
            .iter()
            .map(|key| ((*key).into(), value[*key].clone()))
            .collect(),
    )
}
pub fn plugin_payload(value: &Value) -> Value {
    payload(
        value,
        &[
            "apiVersion",
            "id",
            "name",
            "version",
            "description",
            "publisher",
            "publicKey",
            "templates",
        ],
    )
}
pub fn template_payload(value: &Value) -> Value {
    payload(
        value,
        &[
            "id",
            "name",
            "description",
            "actionId",
            "parameters",
            "riskLevel",
            "source",
            "signer",
            "publicKey",
            "publicKeyFingerprint",
            "createdAt",
        ],
    )
}
pub fn team_payload(value: &Value) -> Value {
    let mut result = payload(
        value,
        &[
            "apiVersion",
            "id",
            "name",
            "version",
            "issuedAt",
            "expiresAt",
            "maximumRiskLevel",
            "deniedActions",
            "signer",
            "publicKey",
        ],
    );
    if let Some(actions) = result["deniedActions"].as_array_mut() {
        actions.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    }
    result
}
pub fn verify_plugin(value: &Value) -> bool {
    verify_signed(value, &plugin_payload(value))
}
pub fn verify_team_policy(value: &Value) -> bool {
    verify_signed(value, &team_payload(value))
}
pub fn verify_template(value: &Value) -> bool {
    value["publicKey"]
        .as_str()
        .and_then(|key| public_key_fingerprint(key).ok())
        .is_some_and(|hash| value["publicKeyFingerprint"] == hash)
        && verify_signed(value, &template_payload(value))
}
fn verify_signed(value: &Value, payload: &Value) -> bool {
    match (value["publicKey"].as_str(), value["signature"].as_str()) {
        (Some(key), Some(sig)) => verify_canonical(key, payload, sig),
        _ => false,
    }
}

pub(super) fn strict(value: &Value, keys: &[&str]) -> HostResult<()> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("签名包必须是 JSON 对象"))?;
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Err(invalid("签名包包含缺失或未知字段"));
    }
    Ok(())
}
pub(super) fn string<'a>(
    value: &'a Value,
    key: &str,
    min: usize,
    max: usize,
) -> HostResult<&'a str> {
    let text = value[key]
        .as_str()
        .ok_or_else(|| invalid(format!("{key} 必须是字符串")))?;
    let length = text.encode_utf16().count();
    if length < min || length > max {
        return Err(invalid(format!("{key} 长度超出范围")));
    }
    Ok(text)
}
pub(super) fn trim_string(value: &mut Value, key: &str, min: usize, max: usize) -> HostResult<()> {
    let text = value[key]
        .as_str()
        .ok_or_else(|| invalid(format!("{key} 必须是字符串")))?
        .trim()
        .to_owned();
    value[key] = Value::String(text);
    string(value, key, min, max).map(|_| ())
}
pub(super) fn identifier(value: &str) -> bool {
    (2..=64).contains(&value.len())
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn action_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".-".contains(&b))
}
pub(super) fn parameters(value: &Value) -> HostResult<()> {
    let values = value
        .as_object()
        .ok_or_else(|| invalid("parameters 必须是对象"))?;
    for (key, value) in values {
        if !(1..=128).contains(&key.encode_utf16().count())
            || value
                .as_str()
                .is_none_or(|s| s.encode_utf16().count() > 4096)
        {
            return Err(invalid("诊断模板参数长度或类型无效"));
        }
    }
    Ok(())
}
fn common(value: &mut Value) -> HostResult<()> {
    if !identifier(string(value, "id", 2, 64)?) {
        return Err(invalid("包标识无效"));
    }
    trim_string(value, "name", 1, 120)?;
    if !regex::Regex::new(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$")
        .map_err(|e| invalid(e.to_string()))?
        .is_match(string(value, "version", 1, 1024)?)
    {
        return Err(invalid("版本号无效"));
    }
    let key = string(value, "publicKey", 80, 4096)?;
    if !key.contains("BEGIN PUBLIC KEY") {
        return Err(invalid("必须提供 PEM 公钥"));
    }
    let signature = string(value, "signature", 80, 512)?;
    if !regex::Regex::new(r"^[A-Za-z0-9+/]+={0,2}$")
        .map_err(|e| invalid(e.to_string()))?
        .is_match(signature)
    {
        return Err(invalid("签名 Base64 无效"));
    }
    Ok(())
}
pub(super) fn validate_plugin(mut value: Value) -> HostResult<Value> {
    strict(
        &value,
        &[
            "apiVersion",
            "id",
            "name",
            "version",
            "description",
            "publisher",
            "publicKey",
            "templates",
            "signature",
        ],
    )?;
    if value["apiVersion"] != "tanwei.dev/plugin/v1" {
        return Err(invalid("插件 API 版本不受支持"));
    }
    common(&mut value)?;
    trim_string(&mut value, "description", 0, 1000)?;
    trim_string(&mut value, "publisher", 1, 200)?;
    let templates = value["templates"]
        .as_array_mut()
        .ok_or_else(|| invalid("templates 必须是数组"))?;
    if templates.len() > 100 {
        return Err(invalid("插件最多包含 100 个模板"));
    }
    for template in templates {
        strict(
            template,
            &["id", "name", "description", "actionId", "parameters"],
        )?;
        if !identifier(string(template, "id", 2, 64)?) {
            return Err(invalid("插件模板标识无效"));
        }
        trim_string(template, "name", 1, 120)?;
        trim_string(template, "description", 0, 1000)?;
        if !action_id(string(template, "actionId", 1, 128)?) {
            return Err(invalid("Action 标识无效"));
        }
        parameters(&template["parameters"])?;
    }
    Ok(value)
}
pub(super) fn validate_team_policy(mut value: Value) -> HostResult<Value> {
    strict(
        &value,
        &[
            "apiVersion",
            "id",
            "name",
            "version",
            "issuedAt",
            "expiresAt",
            "maximumRiskLevel",
            "deniedActions",
            "signer",
            "publicKey",
            "signature",
        ],
    )?;
    if value["apiVersion"] != "tanwei.dev/team-policy/v1" {
        return Err(invalid("团队策略 API 版本不受支持"));
    }
    common(&mut value)?;
    trim_string(&mut value, "signer", 1, 200)?;
    DateTime::parse_from_rfc3339(string(&value, "issuedAt", 1, 128)?)
        .map_err(|_| invalid("团队策略签发时间无效"))?;
    if !value["expiresAt"].is_null() {
        DateTime::parse_from_rfc3339(string(&value, "expiresAt", 1, 128)?)
            .map_err(|_| invalid("团队策略到期时间无效"))?;
    }
    if !["R0", "R1", "R2", "R3", "R4"].contains(&string(&value, "maximumRiskLevel", 2, 2)?) {
        return Err(invalid("团队策略风险等级无效"));
    }
    let actions = value["deniedActions"]
        .as_array()
        .ok_or_else(|| invalid("deniedActions 必须为数组"))?;
    if actions.len() > 500
        || actions
            .iter()
            .any(|a| a.as_str().is_none_or(|s| !action_id(s)))
    {
        return Err(invalid("团队策略禁止 Action 列表无效"));
    }
    let mut actions = actions
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    actions.sort();
    value["deniedActions"] = Value::Array(actions.into_iter().map(Value::String).collect());
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn canonical_matches_js_index_and_utf16_order() {
        assert_eq!(
            canonical_json(&json!({"10":"a","2":"b","\u{e000}":1,"\u{10000}":2,"a":{"z":1,"b":2}}))
                .unwrap(),
            "{\"2\":\"b\",\"10\":\"a\",\"a\":{\"b\":2,\"z\":1},\"\u{10000}\":2,\"\u{e000}\":1}"
        );
    }
    #[test]
    fn ed25519_detects_tampering() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let public = key
            .verifying_key()
            .to_public_key_pem(Default::default())
            .unwrap();
        let data = json!({"a":"原始"});
        let sig = sign_canonical(&key, &data).unwrap();
        assert!(verify_canonical(&public, &data, &sig));
        assert!(!verify_canonical(&public, &json!({"a":"修改"}), &sig));
        assert!(!verify_canonical(&public, &data, "AAAA"));
    }
    #[test]
    fn verifies_real_plugin_sdk_signatures() {
        let fixture: Value =
            serde_json::from_str(include_str!("sdk-signatures.fixture.json")).unwrap();
        let mut plugin = validate_plugin(fixture["plugin"].clone()).unwrap();
        let mut policy = validate_team_policy(fixture["policy"].clone()).unwrap();
        assert!(verify_plugin(&plugin));
        assert!(verify_team_policy(&policy));
        plugin["templates"][0]["parameters"]["2"] = "篡改".into();
        policy["maximumRiskLevel"] = "R4".into();
        assert!(!verify_plugin(&plugin));
        assert!(!verify_team_policy(&policy));
    }
}
