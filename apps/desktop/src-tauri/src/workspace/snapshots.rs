use super::*;
impl Workspace {
    pub(crate) fn query_snapshots(&self, input: &Value) -> HostResult<Value> {
        self.query_records(input, true)
    }
    pub(crate) async fn save_invocation_snapshot(&self, input: &Value) -> HostResult<Value> {
        let target = text(input, "targetId")?;
        let source = input["snapshotId"]
            .as_i64()
            .filter(|n| *n > 0 && *n <= 1_000_000_000)
            .ok_or_else(|| err("INVOCATION_SNAPSHOT_INVALID", "快照身份无效"))?;
        let request = json!({"targetId":target,"actionId":"snapshot.describe","parameters":{"snapshotId":source.to_string()}});
        let (result, snapshot) = tokio::try_join!(
            self.targets.execute_action(&request),
            self.targets.snapshot(target)
        )?;
        if result["status"] != "SUCCEEDED" {
            return Err(err(
                "INVOCATION_SNAPSHOT_SOURCE_UNAVAILABLE",
                result["message"].as_str().unwrap_or("无法读取调用快照"),
            ));
        }
        let values = &result["values"];
        let jvm = snapshot["jvmStartTimeEpochMillis"]
            .as_i64()
            .filter(|n| *n > 0)
            .ok_or_else(|| err("JVM_IDENTITY_INVALID", "目标 JVM 启动身份无效"))?;
        if integer(values, "snapshotId", 1, 1_000_000_000)? != source {
            return Err(err("INVOCATION_SNAPSHOT_INVALID", "Agent 快照身份不匹配"));
        }
        let captured = integer(
            values,
            "capturedAtEpochMillis",
            jvm,
            millis(&snapshot["capturedAt"])? + 5000,
        )?;
        let outcome = text(values, "outcome")?;
        if !["RETURNED", "THREW"].contains(&outcome) {
            return Err(err("INVOCATION_SNAPSHOT_INVALID", "调用结果类型无效"));
        }
        let mut value = json!({"id":uuid::Uuid::new_v4().to_string(),"targetId":target,"jvmStartTimeEpochMillis":jvm,"sourceSnapshotId":source,"capturedAtEpochMillis":captured,"outcome":outcome,"savedAt":now(),"replayEligible":values["replayEligible"]=="true"});
        let mut chars = target.encode_utf16().count();
        for (field, min, max, sensitive) in [
            ("taskId", 1, 4096, false),
            ("className", 1, 4096, false),
            ("classLoader", 0, 4096, true),
            ("rootMethodName", 0, 512, false),
            ("parameterTypes", 0, 4096, false),
            ("modifiers", 0, 512, false),
            ("method", 1, 4096, false),
            ("threadName", 0, 512, true),
            ("returnValue", 0, 512, true),
            ("exceptionType", 0, 512, false),
            ("exceptionMessage", 0, 512, true),
        ] {
            let raw = text(values, field)?;
            if raw.encode_utf16().count() < min
                || raw.encode_utf16().count() > max
                || raw.contains('\0')
            {
                return Err(err(
                    "INVOCATION_SNAPSHOT_INVALID",
                    format!("字段 {field} 超出边界"),
                ));
            }
            let stored = if sensitive {
                super::redact(raw).0
            } else {
                raw.into()
            };
            chars += stored.encode_utf16().count();
            value[field] = stored.into();
        }
        for (field, prefix, max) in [("arguments", "argument", 16), ("callStack", "stack", 12)] {
            let count = integer(values, &format!("{prefix}.count"), 0, max)?;
            let mut entries = Vec::new();
            for i in 0..count {
                let raw = text(values, &format!("{prefix}.{i:02}"))?;
                if raw.encode_utf16().count() > 512 || raw.contains('\0') {
                    return Err(err("INVOCATION_SNAPSHOT_INVALID", "调用参数或堆栈超过边界"));
                }
                let stored = super::redact(raw).0;
                chars += stored.encode_utf16().count();
                entries.push(stored);
            }
            value[field] = json!(entries);
        }
        for (field, min, max) in [
            ("sequence", 0, 9_007_199_254_740_991),
            ("parentSequence", -1, 9_007_199_254_740_991),
            ("depth", 0, 1024),
            ("durationNanos", 0, 9_007_199_254_740_991),
        ] {
            value[field] = integer(values, field, min, max)?.into();
        }
        let bytes = 512 + chars * 2;
        if bytes > 131072 {
            return Err(err(
                "INVOCATION_SNAPSHOT_INVALID",
                "调用快照超过单项128KiB上限",
            ));
        }
        value["estimatedBytes"] = bytes.into();
        let pairs = [
            ("id", "id"),
            ("target_id", "targetId"),
            ("jvm_start_time_epoch_millis", "jvmStartTimeEpochMillis"),
            ("source_snapshot_id", "sourceSnapshotId"),
            ("task_id", "taskId"),
            ("class_name", "className"),
            ("class_loader", "classLoader"),
            ("root_method_name", "rootMethodName"),
            ("parameter_types", "parameterTypes"),
            ("modifiers", "modifiers"),
            ("sequence", "sequence"),
            ("parent_sequence", "parentSequence"),
            ("depth", "depth"),
            ("method", "method"),
            ("captured_at_epoch_millis", "capturedAtEpochMillis"),
            ("duration_nanos", "durationNanos"),
            ("thread_name", "threadName"),
            ("outcome", "outcome"),
            ("return_value", "returnValue"),
            ("exception_type", "exceptionType"),
            ("exception_message", "exceptionMessage"),
            ("arguments_json", "arguments"),
            ("call_stack_json", "callStack"),
            ("replay_eligible", "replayEligible"),
            ("estimated_bytes", "estimatedBytes"),
            ("saved_at", "savedAt"),
        ];
        let columns = pairs.iter().map(|p| p.0).collect::<Vec<_>>().join(",");
        let placeholders = vec!["?"; pairs.len()].join(",");
        let updates = pairs
            .iter()
            .skip(4)
            .map(|(c, _)| format!("{c}=excluded.{c}"))
            .collect::<Vec<_>>()
            .join(",");
        let args = pairs
            .iter()
            .map(|(col, key)| {
                if col.ends_with("_json") {
                    json!(value[key].to_string())
                } else {
                    value[key].clone()
                }
            })
            .collect();
        self.store.transaction(&[(format!("INSERT INTO persisted_invocation_snapshots ({columns}) VALUES ({placeholders}) ON CONFLICT(target_id,jvm_start_time_epoch_millis,source_snapshot_id) DO UPDATE SET {updates}"),args),("DELETE FROM persisted_invocation_snapshots WHERE id IN (SELECT id FROM persisted_invocation_snapshots ORDER BY saved_at DESC,id DESC LIMIT -1 OFFSET 2000)".into(),vec![]),("DELETE FROM persisted_invocation_snapshots WHERE id IN (SELECT id FROM (SELECT id,SUM(estimated_bytes) OVER (ORDER BY saved_at DESC,id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_bytes FROM persisted_invocation_snapshots) WHERE cumulative_bytes>33554432)".into(),vec![])])?;
        self.store.one("SELECT * FROM persisted_invocation_snapshots WHERE target_id=? AND jvm_start_time_epoch_millis=? AND source_snapshot_id=?",&[target.into(),jvm.into(),source.into()]).and_then(|v|required(v,"INVOCATION_SNAPSHOT_NOT_FOUND"))
    }
}
fn integer(value: &Value, key: &str, min: i64, max: i64) -> HostResult<i64> {
    text(value, key)?
        .parse::<i64>()
        .ok()
        .filter(|n| *n >= min && *n <= max)
        .ok_or_else(|| err("INVOCATION_SNAPSHOT_INVALID", format!("字段 {key} 非法")))
}
