use super::*;
fn shape(value: &Value, keys: &[&str]) -> HostResult<()> {
    let object = value
        .as_object()
        .ok_or_else(|| err("INVALID_INPUT", "参数必须为对象"))?;
    if object.keys().any(|key| !keys.contains(&key.as_str())) {
        return Err(err("INVALID_INPUT", "参数包含未声明字段"));
    }
    Ok(())
}
fn count(value: &Value, key: &str, min: i64, max: i64) -> HostResult<()> {
    if value[key].as_i64().is_none_or(|n| n < min || n > max) {
        return Err(err("INVALID_INPUT", format!("{key} 超出整数边界")));
    }
    Ok(())
}
fn label(value: &Value, key: &str, max: usize) -> HostResult<()> {
    let value = text(value, key)?.trim();
    if value.is_empty()
        || value.encode_utf16().count() > max
        || value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
    {
        return Err(err("INVALID_INPUT", format!("{key} 文本无效")));
    }
    Ok(())
}
fn enumeration(value: &Value, key: &str, choices: &[&str]) -> HostResult<()> {
    if value[key].as_str().is_none_or(|s| !choices.contains(&s)) {
        return Err(err("INVALID_INPUT", format!("{key} 取值无效")));
    }
    Ok(())
}
fn uuid(value: &Value) -> HostResult<()> {
    uuid::Uuid::parse_str(string(value)?).map_err(|_| err("INVALID_INPUT", "记录ID必须为UUID"))?;
    Ok(())
}
fn target(value: &Value) -> HostResult<()> {
    let id = string(value)?;
    let pattern =
        regex::Regex::new(r"^(?:local:\d+|remote:(?:ssh|kubernetes|persistent):[a-f0-9]{24})$")
            .map_err(|e| err("INVALID_INPUT", e))?;
    if id.len() > 560 || !pattern.is_match(id) {
        return Err(err("INVALID_INPUT", "目标ID无效"));
    }
    Ok(())
}
pub(super) fn validate(method: &str, args: &[Value]) -> HostResult<()> {
    let a = args.first().unwrap_or(&Value::Null);
    match method {
        "updateSettings" => {
            shape(
                a,
                &[
                    "locale",
                    "fontFamily",
                    "defaultSamplingIntervalMillis",
                    "artifactQuotaBytes",
                    "retentionDays",
                    "updatePolicy",
                    "maximumRiskLevel",
                    "systemNotificationPolicy",
                ],
            )?;
            enumeration(a, "locale", &["zh-CN", "en-US"])?;
            enumeration(
                a,
                "fontFamily",
                &[
                    "SYSTEM",
                    "INTER",
                    "SOURCE_HAN_SANS",
                    "MODERN_CHINESE_SANS",
                    "LXGW_WENKAI",
                    "JETBRAINS_MONO",
                    "SOURCE_HAN_SERIF",
                ],
            )?;
            let interval = a["defaultSamplingIntervalMillis"]
                .as_i64()
                .ok_or_else(|| err("INVALID_INPUT", "采样间隔无效"))?;
            if ![1000, 2000, 5000, 10000].contains(&interval) {
                return Err(err("INVALID_INPUT", "采样间隔无效"));
            }
            count(a, "artifactQuotaBytes", 104857600, 1099511627776)?;
            count(a, "retentionDays", 0, 3650)?;
            enumeration(a, "updatePolicy", &["NOTIFY", "MANUAL"])?;
            enumeration(a, "maximumRiskLevel", &["R2", "R3", "R4"])?;
            enumeration(
                a,
                "systemNotificationPolicy",
                &["OFF", "CRITICAL_ONLY", "WARNING_AND_CRITICAL"],
            )?;
        }
        "createCase" => shape(a, &["title", "notes", "tags"])?,
        "archiveCase"
        | "deleteCase"
        | "getCaseEvidence"
        | "previewCaseExport"
        | "exportCase"
        | "getPersistedInvocationSnapshot"
        | "deletePersistedInvocationSnapshot"
        | "acknowledgeDiagnosticAlert"
        | "deleteArtifact"
        | "verifyArtifact"
        | "decompileClassArtifact"
        | "inspectHeapHistogramArtifact"
        | "inspectThreadPoolTrendArtifact"
        | "inspectJitTrendArtifact"
        | "inspectObservationExportArtifact"
        | "inspectThreadDumpArtifact"
        | "inspectJfrArtifact" => uuid(a)?,
        "updateCaseEvidence" => {
            shape(a, &["caseId", "artifactIds", "actionTaskIds"])?;
            uuid(&a["caseId"])?;
            for key in ["artifactIds", "actionTaskIds"] {
                let list = a[key]
                    .as_array()
                    .filter(|v| v.len() <= 500)
                    .ok_or_else(|| err("INVALID_INPUT", "案例证据最多500项"))?;
                for id in list {
                    uuid(id)?;
                }
            }
        }
        "createSnapshotArtifact" | "listThreadPoolAliases" | "listClassChangeSetDrafts" => {
            target(a)?
        }
        "upsertThreadPoolAlias" | "deleteThreadPoolAlias" => {
            shape(
                a,
                if method == "upsertThreadPoolAlias" {
                    &["targetId", "poolIdentity", "poolClassName", "alias"]
                } else {
                    &["targetId", "poolIdentity", "poolClassName"]
                },
            )?;
            target(&a["targetId"])?;
            let class = text(a, "poolClassName")?;
            let prefix = match class {
                "java.util.concurrent.ThreadPoolExecutor" => "ThreadPoolExecutor@",
                "java.util.concurrent.ScheduledThreadPoolExecutor" => {
                    "ScheduledThreadPoolExecutor@"
                }
                "java.util.concurrent.ForkJoinPool" => "ForkJoinPool@",
                _ => return Err(err("INVALID_INPUT", "线程池类不受支持")),
            };
            let identity = text(a, "poolIdentity")?;
            if identity.len() > 128 {
                return Err(err("INVALID_INPUT", "线程池身份超过128字符"));
            }
            let suffix = identity
                .strip_prefix(prefix)
                .filter(|s| !s.is_empty() && s.len() <= 128)
                .ok_or_else(|| err("INVALID_INPUT", "线程池身份与精确类不匹配"))?;
            if !suffix
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(err("INVALID_INPUT", "线程池身份无效"));
            }
            if method == "upsertThreadPoolAlias" {
                label(a, "alias", 64)?;
            }
        }
        "compileClassSource" | "compileClassChangeSet" => target(&a["targetId"])?,
        "replaceClassChangeSetDrafts" => {
            shape(a, &["targetId", "items"])?;
            target(&a["targetId"])?;
            let items = a["items"]
                .as_array()
                .filter(|s| s.len() <= 8)
                .ok_or_else(|| err("INVALID_INPUT", "草稿最多8个类"))?;
            let pattern =
                regex::Regex::new(r"^(?:[A-Za-z_$][A-Za-z0-9_$]*\.)*[A-Za-z_$][A-Za-z0-9_$]*$")
                    .map_err(|e| err("INVALID_INPUT", e))?;
            let mut seen = HashSet::new();
            let mut loader = None;
            let mut total = 0usize;
            for item in items {
                shape(item, &["className", "classLoader", "source"])?;
                let name = text(item, "className")?;
                let cl = text(item, "classLoader")?;
                let source = text(item, "source")?;
                total += source.len();
                if name.len() > 1024
                    || !pattern.is_match(name)
                    || cl.is_empty()
                    || cl.encode_utf16().count() > 4096
                    || source.is_empty()
                    || source.len() > 1024 * 1024
                    || total > 2 * 1024 * 1024
                    || !seen.insert(name)
                    || loader.is_some_and(|previous| previous != cl)
                {
                    return Err(err("INVALID_INPUT", "类变更集草稿身份或源码边界无效"));
                }
                loader = Some(cl);
            }
        }
        "collectAgentArtifact" => {
            shape(a, &["targetId", "token", "type", "expectedSize"])?;
            target(&a["targetId"])?;
            uuid(&a["token"])?;
            count(a, "expectedSize", 1, 2147483648)?;
            enumeration(
                a,
                "type",
                &["JFR", "HEAP_DUMP", "PROFILE", "CLASS_DUMP", "THREAD_DUMP"],
            )?;
        }
        "saveInvocationSnapshot" => {
            shape(a, &["targetId", "snapshotId"])?;
            target(&a["targetId"])?;
            count(a, "snapshotId", 1, 1_000_000_000)?;
        }
        "queryActionAudits" | "queryPersistedInvocationSnapshots" => {
            let snapshots = method == "queryPersistedInvocationSnapshots";
            shape(
                a,
                if snapshots {
                    &["offset", "limit", "query", "targetId", "outcome", "scope"]
                } else {
                    &[
                        "offset",
                        "limit",
                        "query",
                        "targetId",
                        "status",
                        "riskLevel",
                    ]
                },
            )?;
            count(a, "limit", 1, if snapshots { 50 } else { 100 })?;
            count(a, "offset", 0, 1_000_000)?;
            let query = text(a, "query")?.trim();
            if query.encode_utf16().count() > 256
                || query.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
            {
                return Err(err("INVALID_INPUT", "查询文本包含控制字符或过长"));
            }
            let id = text(a, "targetId")?;
            if !id.is_empty() {
                target(&a["targetId"])?;
            }
            if snapshots {
                enumeration(a, "outcome", &["ALL", "RETURNED", "THREW"])?;
                enumeration(a, "scope", &["ROOT", "ALL"])?;
            } else {
                enumeration(a, "status", &["ALL", "SUCCEEDED", "FAILED"])?;
                enumeration(a, "riskLevel", &["ALL", "R0", "R1", "R2", "R3", "R4"])?;
            }
        }
        "createHeapHistogramArtifact" => shape(a, &["snapshot"])?,
        "createThreadPoolTrendArtifact" => shape(a, &["recording"])?,
        "createTraceHotspotArtifact" | "createMonitorWindowsArtifact" => {
            shape(
                a,
                if method == "createTraceHotspotArtifact" {
                    &[
                        "targetId",
                        "taskId",
                        "taskState",
                        "target",
                        "rootMethod",
                        "scopePrefix",
                        "includeRules",
                        "excludeRules",
                        "dropped",
                        "traces",
                    ]
                } else {
                    &[
                        "targetId",
                        "taskId",
                        "taskState",
                        "target",
                        "method",
                        "intervalMillis",
                        "windows",
                    ]
                },
            )?;
            target(&a["targetId"])?;
            uuid(&a["taskId"])?;
            shape(
                &a["target"],
                &["className", "classLoader", "methodName", "parameterTypes"],
            )?;
            // Complete recording validation follows after resolving the current
            // JVM identity; reject malformed RPC identities before that lookup.
            for key in ["className", "classLoader", "methodName"] {
                string(&a["target"][key])?;
            }
        }
        "createJitTrendArtifact" => {
            shape(a, &["recording", "regressionLabel"])?;
            if a.get("regressionLabel").is_none() {
                return Err(err("INVALID_INPUT", "缺少 regressionLabel 字段"));
            }
            if !a["regressionLabel"].is_null() {
                shape(&a["regressionLabel"], &["workloadKey", "releaseLabel"])?;
                label(&a["regressionLabel"], "workloadKey", 128)?;
                label(&a["regressionLabel"], "releaseLabel", 128)?;
            }
        }
        "compareHeapHistogramArtifacts"
        | "compareThreadPoolTrendArtifacts"
        | "compareJitTrendArtifacts"
        | "compareThreadDumpArtifacts" => {
            shape(
                a,
                if method == "compareJitTrendArtifacts" {
                    &["baselineArtifactId", "currentArtifactId", "mode"]
                } else {
                    &["baselineArtifactId", "currentArtifactId"]
                },
            )?;
            uuid(&a["baselineArtifactId"])?;
            uuid(&a["currentArtifactId"])?;
            if a.get("mode").is_some() {
                enumeration(a, "mode", &["SAME_JVM", "CROSS_RELEASE"])?;
            }
        }
        _ => (),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn query_bounds_follow_utf16_and_trim_before_control_checks() {
        let mut input = json!({"offset":0,"limit":100,"query":"  hello\n", "targetId":"", "status":"ALL", "riskLevel":"ALL"});
        assert!(validate("queryActionAudits", &[input.clone()]).is_ok());
        input["query"] = "😀".repeat(129).into();
        assert!(validate("queryActionAudits", &[input.clone()]).is_err());
        input["query"] = "a\0b".into();
        assert!(validate("queryActionAudits", &[input.clone()]).is_err());
        input["query"] = "".into();
        input["limit"] = 101.into();
        assert!(validate("queryActionAudits", &[input]).is_err());
        let input = json!({"offset":0,"limit":51,"query":"", "targetId":"", "outcome":"ALL", "scope":"ALL"});
        assert!(validate("queryPersistedInvocationSnapshots", &[input]).is_err());
    }
    #[test]
    fn identities_and_drafts_reject_invalid_input_before_target_lookup() {
        assert!(validate(
            "compileClassSource",
            &[json!({"targetId":"local:1/../../"})]
        )
        .is_err());
        let item =
            json!({"className":"dev.Probe", "classLoader":"Loader@1", "source":"class Probe {}"});
        assert!(validate(
            "replaceClassChangeSetDrafts",
            &[json!({"targetId":"local:1", "items":[item.clone(),item]})]
        )
        .is_err());
        let input = json!({"targetId":"local:1", "poolIdentity":format!("ThreadPoolExecutor@{}", "a".repeat(128)), "poolClassName":"java.util.concurrent.ThreadPoolExecutor", "alias":"workers"});
        assert!(validate("upsertThreadPoolAlias", &[input]).is_err());
        assert!(validate("createJitTrendArtifact", &[json!({"recording":{}})]).is_err());
        assert!(validate(
            "saveInvocationSnapshot",
            &[json!({"targetId":"local:1", "snapshotId":1_000_000_001})]
        )
        .is_err());
    }
}
