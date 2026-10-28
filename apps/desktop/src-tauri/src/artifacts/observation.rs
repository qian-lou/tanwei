use super::*;
fn validate_context(value: &Value) -> HostResult<()> {
    target(value)?;
    safe(value, "jvmStartTimeEpochMillis", 1, SAFE)?;
    safe(value, "exportedAtEpochMillis", 1, SAFE)?;
    let task = bounded(value, "taskId", 36, 36)?;
    uuid::Uuid::parse_str(task).map_err(fail)?;
    choice(
        value,
        "taskState",
        &[
            "RUNNING",
            "SUCCEEDED",
            "FAILED",
            "CANCELLED",
            "TIMED_OUT",
            "UNKNOWN",
        ],
    )?;
    let target = &value["target"];
    strict(
        target,
        &["className", "classLoader", "methodName", "parameterTypes"],
    )?;
    let class = bounded(target, "className", 1, 1024)?;
    if !regex::Regex::new(r"^(?:[A-Za-z_$][A-Za-z0-9_$]*\.)*[A-Za-z_$][A-Za-z0-9_$]*$")
        .map_err(fail)?
        .is_match(class)
    {
        return Err(fail("观测目标类名无效"));
    }
    bounded(target, "classLoader", 1, 4096)?;
    bounded(target, "methodName", 1, 512)?;
    for value in array(target, "parameterTypes", 0, 256)? {
        if value
            .as_str()
            .is_none_or(|s| s.is_empty() || s.len() > 1024)
        {
            return Err(fail("方法参数类型无效"));
        }
    }
    Ok(())
}
fn monitor_summary(value: &Value) -> HostResult<Value> {
    let windows = array(value, "windows", 1, 300)?;
    let (mut calls, mut failures, mut duration, mut maximum, mut p95, mut p99) =
        (0i64, 0i64, 0i64, 0i64, 0i64, 0i64);
    let mut previous: Option<&Value> = None;
    let lower = safe(value, "jvmStartTimeEpochMillis", 1, SAFE)?;
    let upper = safe(value, "exportedAtEpochMillis", lower, SAFE)? + 5000;
    for window in windows {
        strict(
            window,
            &[
                "sequence",
                "startedAtEpochMillis",
                "endedAtEpochMillis",
                "minimumDurationMillis",
                "calls",
                "failures",
                "durationNanos",
                "maximumDurationNanos",
                "p95DurationNanos",
                "p99DurationNanos",
            ],
        )?;
        let start = safe(window, "startedAtEpochMillis", lower, upper)?;
        let end = safe(window, "endedAtEpochMillis", start, upper)?;
        let sequence = safe(window, "sequence", 1, SAFE)?;
        let c = safe(window, "calls", 0, SAFE)?;
        let f = safe(window, "failures", 0, c)?;
        let d = safe(window, "durationNanos", 0, SAFE)?;
        let m = safe(window, "maximumDurationNanos", 0, SAFE)?;
        let p = safe(window, "p95DurationNanos", 0, SAFE)?;
        let q = safe(window, "p99DurationNanos", p, SAFE)?;
        if window.get("minimumDurationMillis").is_some() {
            safe(window, "minimumDurationMillis", 0, 60000)?;
        }
        if previous.is_some_and(|v| {
            n(v, "sequence") >= sequence as f64
                || n(v, "startedAtEpochMillis") > start as f64
                || n(v, "endedAtEpochMillis") >= end as f64
        }) {
            return Err(fail("监控窗口必须按时间递增"));
        }
        previous = Some(window);
        calls = calls
            .checked_add(c)
            .filter(|v| *v <= SAFE)
            .ok_or_else(|| fail("调用总数溢出"))?;
        failures = failures
            .checked_add(f)
            .filter(|v| *v <= SAFE)
            .ok_or_else(|| fail("失败总数溢出"))?;
        duration = duration
            .checked_add(d)
            .filter(|v| *v <= SAFE)
            .ok_or_else(|| fail("调用时长溢出"))?;
        maximum = maximum.max(m);
        p95 = p95.max(p);
        p99 = p99.max(q);
    }
    Ok(
        json!({"windowCount":windows.len(),"totalCalls":calls,"totalFailures":failures,"totalDurationNanos":duration,"averageDurationNanos":if calls>0{duration as f64/calls as f64}else{0.0},"maximumDurationNanos":maximum,"maximumP95DurationNanos":p95,"maximumP99DurationNanos":p99}),
    )
}
pub fn validate_recording(value: &Value, kind: &str) -> HostResult<()> {
    strict(
        value,
        if kind == "MONITOR_WINDOWS" {
            &[
                "targetId",
                "jvmStartTimeEpochMillis",
                "exportedAtEpochMillis",
                "taskId",
                "taskState",
                "target",
                "method",
                "intervalMillis",
                "windows",
                "summary",
            ]
        } else {
            &[
                "targetId",
                "jvmStartTimeEpochMillis",
                "exportedAtEpochMillis",
                "taskId",
                "taskState",
                "target",
                "rootMethod",
                "scopePrefix",
                "includeRules",
                "excludeRules",
                "firstCapturedAtEpochMillis",
                "lastCapturedAtEpochMillis",
                "traceCount",
                "spanCount",
                "dropped",
                "truncatedSpans",
                "hotspots",
            ]
        },
    )?;
    validate_context(value)?;
    if kind == "MONITOR_WINDOWS" {
        bounded(value, "method", 1, 2048)?;
        safe(value, "intervalMillis", 1000, 60000)?;
        strict(
            &value["summary"],
            &[
                "windowCount",
                "totalCalls",
                "totalFailures",
                "totalDurationNanos",
                "averageDurationNanos",
                "maximumDurationNanos",
                "maximumP95DurationNanos",
                "maximumP99DurationNanos",
            ],
        )?;
        let summary = monitor_summary(value)?;
        for (key, v) in summary.as_object().ok_or_else(|| fail("监控摘要无效"))? {
            if value["summary"][key].as_f64() != v.as_f64() {
                return Err(fail("监控摘要与窗口数据不一致"));
            }
        }
    } else {
        bounded(value, "rootMethod", 1, 2048)?;
        bounded(value, "scopePrefix", 1, 1024)?;
        safe(value, "traceCount", 1, 20)?;
        safe(value, "spanCount", 1, 10240)?;
        safe(value, "dropped", 0, SAFE)?;
        safe(value, "truncatedSpans", 0, SAFE)?;
        for key in ["includeRules", "excludeRules"] {
            for rule in array(value, key, 0, 16)? {
                if rule.as_str().is_none_or(|s| s.is_empty() || s.len() > 512) {
                    return Err(fail("Trace 匹配规则无效"));
                }
            }
        }
        let lower = safe(value, "jvmStartTimeEpochMillis", 1, SAFE)?;
        let upper = safe(value, "exportedAtEpochMillis", lower, SAFE)? + 5000;
        let first = safe(value, "firstCapturedAtEpochMillis", lower, upper)?;
        safe(value, "lastCapturedAtEpochMillis", first, upper)?;
        for row in array(value, "hotspots", 1, 100)? {
            strict(
                row,
                &[
                    "method",
                    "calls",
                    "errors",
                    "totalDurationNanos",
                    "selfDurationNanos",
                    "averageDurationNanos",
                    "maximumDurationNanos",
                    "selfSharePercent",
                ],
            )?;
            if row["averageDurationNanos"].as_f64().is_none_or(|n| n < 0.0) {
                return Err(fail("热点平均时长无效"));
            }
            bounded(row, "method", 1, 1024)?;
            let calls = safe(row, "calls", 1, SAFE)?;
            safe(row, "errors", 0, calls)?;
            for key in [
                "totalDurationNanos",
                "selfDurationNanos",
                "maximumDurationNanos",
            ] {
                safe(row, key, 0, SAFE)?;
            }
            let share = row["selfSharePercent"]
                .as_f64()
                .ok_or_else(|| fail("热点占比无效"))?;
            if !(0.0..=100.0).contains(&share) {
                return Err(fail("热点占比超过边界"));
            }
        }
    }
    Ok(())
}
pub fn observation_export(input: &Value, jvm: i64, at: i64, trace: bool) -> HostResult<Value> {
    strict(
        input,
        if trace {
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
    if input.to_string().len() > 8 * 1024 * 1024 {
        return Err(fail("观测导出输入超过8MiB"));
    }
    let mut recording = input.clone();
    recording["jvmStartTimeEpochMillis"] = jvm.into();
    recording["exportedAtEpochMillis"] = at.into();
    validate_context(&recording)?;
    if !trace {
        recording["summary"] = monitor_summary(&recording)?;
        if let Some(windows) = recording["windows"].as_array_mut() {
            for w in windows {
                if w.get("minimumDurationMillis").is_none() {
                    w["minimumDurationMillis"] = 0.into();
                }
            }
        }
    } else {
        let traces = array(input, "traces", 1, 20)?;
        let mut groups = HashMap::<String, Value>::new();
        let mut roots = 0i64;
        let mut spans_count = 0usize;
        let mut truncated = 0i64;
        let mut ids = HashSet::new();
        let mut previous = jvm;
        for trace in traces {
            strict(
                trace,
                &[
                    "traceId",
                    "capturedAtEpochMillis",
                    "durationNanos",
                    "truncatedSpans",
                    "spans",
                ],
            )?;
            let id = safe(trace, "traceId", 1, SAFE)?;
            if !ids.insert(id) {
                return Err(fail("Trace ID 重复"));
            }
            let captured = safe(trace, "capturedAtEpochMillis", previous, at + 5000)?;
            previous = captured;
            roots = roots
                .checked_add(safe(trace, "durationNanos", 0, SAFE)?)
                .filter(|v| *v <= SAFE)
                .ok_or_else(|| fail("Trace 时长总计溢出"))?;
            truncated += safe(trace, "truncatedSpans", 0, 100000)?;
            let spans = array(trace, "spans", 1, 512)?;
            spans_count += spans.len();
            let mut sequences = HashSet::new();
            for span in spans {
                strict(
                    span,
                    &[
                        "sequence",
                        "parentSequence",
                        "method",
                        "durationNanos",
                        "exceptionType",
                    ],
                )?;
                if !span["parentSequence"].is_null() {
                    safe(span, "parentSequence", 0, SAFE)?;
                }
                if !span["exceptionType"].is_null() {
                    bounded(span, "exceptionType", 1, 1024)?;
                }
                if !sequences.insert(safe(span, "sequence", 0, SAFE)?) {
                    return Err(fail("Trace Span 序号重复"));
                }
            }
            let mut children = HashMap::<i64, i64>::new();
            for span in spans {
                let duration = safe(span, "durationNanos", 0, SAFE)?;
                if let Some(parent) = span["parentSequence"].as_i64() {
                    if parent < 0 {
                        return Err(fail("父 Span 序号无效"));
                    }
                    if sequences.contains(&parent) {
                        let entry = children.entry(parent).or_default();
                        *entry = entry
                            .checked_add(duration)
                            .filter(|v| *v <= SAFE)
                            .ok_or_else(|| fail("子调用时长溢出"))?;
                    }
                }
            }
            for span in spans {
                let method = bounded(span, "method", 1, 1024)?;
                let duration = safe(span, "durationNanos", 0, SAFE)?;
                let own = duration
                    .saturating_sub(
                        *children
                            .get(&safe(span, "sequence", 0, SAFE)?)
                            .unwrap_or(&0),
                    )
                    .max(0);
                let group=groups.entry(method.into()).or_insert_with(||json!({"method":method,"calls":0,"errors":0,"totalDurationNanos":0,"selfDurationNanos":0,"maximumDurationNanos":0}));
                for (key, amount) in [
                    ("calls", 1),
                    ("errors", i64::from(!span["exceptionType"].is_null())),
                    ("totalDurationNanos", duration),
                    ("selfDurationNanos", own),
                ] {
                    group[key] = group[key]
                        .as_i64()
                        .unwrap_or(0)
                        .checked_add(amount)
                        .filter(|v| *v <= SAFE)
                        .ok_or_else(|| fail("热点总计溢出"))?
                        .into();
                }
                group["maximumDurationNanos"] = json!(group["maximumDurationNanos"]
                    .as_i64()
                    .unwrap_or(0)
                    .max(duration));
            }
        }
        let mut hotspots = groups.into_values().collect::<Vec<_>>();
        for row in &mut hotspots {
            row["averageDurationNanos"] = json!(n(row, "totalDurationNanos") / n(row, "calls"));
            row["selfSharePercent"] = json!(if roots > 0 {
                (n(row, "selfDurationNanos") / roots as f64 * 100.0).min(100.0)
            } else {
                0.0
            });
        }
        hotspots.sort_by(|l, r| {
            n(r, "selfDurationNanos")
                .total_cmp(&n(l, "selfDurationNanos"))
                .then_with(|| n(r, "totalDurationNanos").total_cmp(&n(l, "totalDurationNanos")))
                .then_with(|| n(r, "calls").total_cmp(&n(l, "calls")))
                .then_with(|| s(l, "method").cmp(s(r, "method")))
        });
        hotspots.truncate(100);
        recording
            .as_object_mut()
            .ok_or_else(|| fail("Trace 导出无效"))?
            .remove("traces");
        recording["traceCount"] = traces.len().into();
        recording["spanCount"] = spans_count.into();
        recording["truncatedSpans"] = truncated.into();
        recording["firstCapturedAtEpochMillis"] = traces[0]["capturedAtEpochMillis"].clone();
        recording["lastCapturedAtEpochMillis"] =
            traces[traces.len() - 1]["capturedAtEpochMillis"].clone();
        recording["hotspots"] = json!(hotspots);
    }
    let kind = if trace {
        "TRACE_HOTSPOTS"
    } else {
        "MONITOR_WINDOWS"
    };
    validate_recording(&recording, kind)?;
    let result = json!({"schemaVersion":1,"product":"tanwei","kind":kind.to_lowercase().replace('_',"-"),"recording":recording});
    if serde_json::to_vec_pretty(&result).map_err(fail)?.len() + 1 > 512 * 1024 {
        return Err(fail("观测导出超过512KiB"));
    }
    Ok(result)
}
