use crate::common::{HostError, HostResult};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
mod jfr;
mod observation;
mod threads;
pub use jfr::parse_jfr;
pub use observation::observation_export;
pub use threads::{compare_thread_dumps, parse_thread_dump};
fn fail(message: impl std::fmt::Display) -> HostError {
    HostError::new("ARTIFACT_FORMAT_INVALID", message.to_string())
}
fn n(value: &Value, key: &str) -> f64 {
    value[key].as_f64().unwrap_or(0.0)
}
fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn round(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}
fn delta(left: &Value, right: &Value, key: &str) -> Value {
    match (left[key].as_f64(), right[key].as_f64()) {
        (Some(l), Some(r)) => json!(round(r - l)),
        _ => Value::Null,
    }
}
fn safe(value: &Value, key: &str, min: i64, max: i64) -> HostResult<i64> {
    value[key]
        .as_i64()
        .filter(|n| *n >= min && *n <= max)
        .ok_or_else(|| fail(format!("字段 {key} 超出整数边界")))
}
fn bounded<'a>(value: &'a Value, key: &str, min: usize, max: usize) -> HostResult<&'a str> {
    let text = value[key]
        .as_str()
        .ok_or_else(|| fail(format!("字段 {key} 必须为文本")))?;
    let len = text.encode_utf16().count();
    if len < min || len > max || text.trim() != text || text.contains('\0') {
        return Err(fail(format!("字段 {key} 超出文本边界")));
    }
    Ok(text)
}
fn array<'a>(value: &'a Value, key: &str, min: usize, max: usize) -> HostResult<&'a Vec<Value>> {
    value[key]
        .as_array()
        .filter(|a| a.len() >= min && a.len() <= max)
        .ok_or_else(|| fail(format!("字段 {key} 超出数组边界")))
}
const SAFE: i64 = 9_007_199_254_740_991;
fn boolean(value: &Value, key: &str) -> HostResult<bool> {
    value[key]
        .as_bool()
        .ok_or_else(|| fail(format!("字段 {key} 必须为布尔值")))
}
fn choice<'a>(value: &'a Value, key: &str, choices: &[&str]) -> HostResult<&'a str> {
    let v = value[key]
        .as_str()
        .filter(|v| choices.contains(v))
        .ok_or_else(|| fail(format!("字段 {key} 枚举无效")))?;
    Ok(v)
}
fn strict(value: &Value, fields: &[&str]) -> HostResult<()> {
    let obj = value.as_object().ok_or_else(|| fail("记录必须为对象"))?;
    if obj.keys().any(|k| !fields.contains(&k.as_str())) {
        return Err(fail("记录包含未声明字段"));
    }
    Ok(())
}
fn target(value: &Value) -> HostResult<()> {
    let target = bounded(value, "targetId", 1, 560)?;
    let regex =
        regex::Regex::new(r"^(?:local:\d+|remote:(?:ssh|kubernetes|persistent):[a-f0-9]{24})$")
            .map_err(fail)?;
    if !regex.is_match(target) {
        return Err(fail("目标身份无效"));
    }
    Ok(())
}
pub fn validate_heap(value: &Value) -> HostResult<()> {
    strict(
        value,
        &[
            "targetId",
            "targetStartTime",
            "capturedAt",
            "query",
            "limit",
            "scanLimit",
            "scanComplete",
            "rowsComplete",
            "accountedObjects",
            "accountedBytes",
            "rows",
        ],
    )?;
    bounded(value, "targetId", 1, 560)?;
    bounded(value, "targetStartTime", 1, 128)?;
    bounded(value, "query", 0, 256)?;
    safe(value, "capturedAt", 1, SAFE)?;
    let limit = safe(value, "limit", 1, 100)?;
    safe(value, "scanLimit", 10000, 5_000_000)?;
    boolean(value, "scanComplete")?;
    let complete = boolean(value, "rowsComplete")?;
    let objects = safe(value, "accountedObjects", 0, SAFE)?;
    let bytes = safe(value, "accountedBytes", 0, SAFE)?;
    let rows = array(value, "rows", 0, limit as usize)?;
    let mut seen = HashSet::new();
    let (mut count, mut total) = (0i64, 0i64);
    for row in rows {
        strict(
            row,
            &[
                "className",
                "classLoader",
                "instanceCount",
                "shallowBytes",
                "averageShallowBytes",
            ],
        )?;
        let name = bounded(row, "className", 1, 1024)?;
        let loader = bounded(row, "classLoader", 1, 4096)?;
        if !seen.insert((name, loader)) {
            return Err(fail("重复类与ClassLoader身份"));
        }
        let instances = safe(row, "instanceCount", 1, SAFE)?;
        let shallow = safe(row, "shallowBytes", 0, SAFE)?;
        if safe(row, "averageShallowBytes", 0, SAFE)? != shallow / instances {
            return Err(fail("平均浅堆大小与计数不一致"));
        }
        count = count
            .checked_add(instances)
            .filter(|v| *v <= SAFE)
            .ok_or_else(|| fail("对象计数溢出"))?;
        total = total
            .checked_add(shallow)
            .filter(|v| *v <= SAFE)
            .ok_or_else(|| fail("浅堆计数溢出"))?;
    }
    if count > objects || total > bytes || (complete && (count != objects || total != bytes)) {
        return Err(fail("行计数与声明总计不一致"));
    }
    Ok(())
}
pub fn validate_trend(value: &Value, jit: bool) -> HostResult<()> {
    strict(
        value,
        if jit {
            &[
                "targetId",
                "jvmStartTimeEpochMillis",
                "samplingIntervalMillis",
                "samples",
                "regressionIdentity",
            ]
        } else {
            &[
                "targetId",
                "jvmStartTimeEpochMillis",
                "poolIdentity",
                "poolClassName",
                "poolKind",
                "alias",
                "samplingIntervalMillis",
                "samples",
            ]
        },
    )?;
    target(value)?;
    let jvm = safe(value, "jvmStartTimeEpochMillis", 1, SAFE)?;
    let interval = safe(value, "samplingIntervalMillis", 1000, 30000)?;
    if !(if jit {
        vec![1000, 2000, 5000, 10000]
    } else {
        vec![2000, 5000, 10000, 30000]
    })
    .contains(&interval)
    {
        return Err(fail("采样间隔不受支持"));
    }
    if !jit {
        let class = choice(
            value,
            "poolClassName",
            &[
                "java.util.concurrent.ThreadPoolExecutor",
                "java.util.concurrent.ScheduledThreadPoolExecutor",
                "java.util.concurrent.ForkJoinPool",
            ],
        )?;
        let identity = bounded(value, "poolIdentity", 1, 128)?;
        let (prefix, kind) = match class {
            "java.util.concurrent.ThreadPoolExecutor" => ("ThreadPoolExecutor@", "THREAD_POOL"),
            "java.util.concurrent.ScheduledThreadPoolExecutor" => {
                ("ScheduledThreadPoolExecutor@", "SCHEDULED")
            }
            _ => ("ForkJoinPool@", "FORK_JOIN"),
        };
        let suffix = identity
            .strip_prefix(prefix)
            .ok_or_else(|| fail("线程池身份与类型不匹配"))?;
        if suffix.is_empty()
            || !suffix
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || value["poolKind"] != kind
        {
            return Err(fail("线程池身份无效"));
        }
        if !value["alias"].is_null() {
            let alias = bounded(value, "alias", 1, 64)?;
            if alias.chars().any(char::is_control) {
                return Err(fail("线程池别名含控制字符"));
            }
        }
    }
    if jit && !value["regressionIdentity"].is_null() {
        let id = &value["regressionIdentity"];
        strict(
            id,
            &[
                "workloadKey",
                "releaseLabel",
                "targetMainClass",
                "javaVersion",
                "compilerName",
            ],
        )?;
        for (key, max) in [
            ("workloadKey", 128),
            ("releaseLabel", 128),
            ("targetMainClass", 1024),
            ("javaVersion", 128),
            ("compilerName", 256),
        ] {
            if bounded(id, key, 1, max)?.chars().any(char::is_control) {
                return Err(fail("回归身份包含控制字符"));
            }
        }
    }
    let samples = array(value, "samples", 2, 120)?;
    let time = if jit {
        "sampledAtEpochMillis"
    } else {
        "capturedAt"
    };
    let monotonic = if jit {
        vec![
            "totalCompiles",
            "standardCompiles",
            "osrCompiles",
            "bailouts",
            "invalidations",
            "compilerTimeMillis",
        ]
    } else {
        vec!["completedTasks", "stealCount"]
    };
    let mut previous: Option<&Value> = None;
    for sample in samples {
        strict(
            sample,
            if jit {
                &[
                    "sampledAtEpochMillis",
                    "totalCompiles",
                    "standardCompiles",
                    "osrCompiles",
                    "bailouts",
                    "invalidations",
                    "compilerTimeMillis",
                    "codeCacheUsedBytes",
                    "codeCacheCapacityBytes",
                    "codeCacheCapacityKind",
                ]
            } else {
                &[
                    "capturedAt",
                    "state",
                    "configuredSize",
                    "poolSize",
                    "activeCount",
                    "maximumSize",
                    "queuedTasks",
                    "remainingQueueCapacity",
                    "completedTasks",
                    "queuedSubmissions",
                    "runningCount",
                    "stealCount",
                ]
            },
        )?;
        let at = safe(sample, time, jvm, SAFE)?;
        if previous.is_some_and(|p| n(p, time) >= at as f64) {
            return Err(fail("趋势样本必须严格按时间递增"));
        }
        let metrics = if jit {
            vec![
                "totalCompiles",
                "standardCompiles",
                "osrCompiles",
                "bailouts",
                "invalidations",
                "compilerTimeMillis",
            ]
        } else {
            vec![
                "configuredSize",
                "poolSize",
                "activeCount",
                "maximumSize",
                "queuedTasks",
                "remainingQueueCapacity",
                "completedTasks",
                "queuedSubmissions",
                "runningCount",
                "stealCount",
            ]
        };
        for key in metrics {
            if !sample[key].is_null() {
                safe(sample, key, 0, SAFE)?;
            } else if sample.get(key).is_none() {
                return Err(fail(format!("缺少字段 {key}")));
            }
        }
        for key in &monotonic {
            if let Some(p) = previous {
                if let (Some(l), Some(r)) = (p[key].as_i64(), sample[key].as_i64()) {
                    if r < l {
                        return Err(fail(format!("计数器 {key} 在同一 JVM 周期内回退")));
                    }
                }
            }
        }
        if jit {
            let used = safe(sample, "codeCacheUsedBytes", 0, SAFE)?;
            let capacity = safe(sample, "codeCacheCapacityBytes", 1, SAFE)?;
            choice(sample, "codeCacheCapacityKind", &["MAX", "COMMITTED"])?;
            if used > capacity
                || sample["codeCacheCapacityKind"] != samples[0]["codeCacheCapacityKind"]
                || (sample["codeCacheCapacityKind"] == "MAX"
                    && sample["codeCacheCapacityBytes"] != samples[0]["codeCacheCapacityBytes"])
            {
                return Err(fail("Code Cache 容量边界变化或超限"));
            }
        } else {
            choice(
                sample,
                "state",
                &[
                    "RUNNING",
                    "QUIESCENT",
                    "SHUTDOWN",
                    "TERMINATING",
                    "TERMINATED",
                ],
            )?;
            if sample["queuedTasks"].is_null() && sample["queuedSubmissions"].is_null() {
                return Err(fail("线程池样本缺少队列指标"));
            }
            if n(sample, "queuedTasks") + n(sample, "queuedSubmissions") > SAFE as f64 {
                return Err(fail("队列指标总计溢出"));
            }
            for (left, right) in [("activeCount", "poolSize"), ("poolSize", "maximumSize")] {
                if let (Some(l), Some(r)) = (sample[left].as_i64(), sample[right].as_i64()) {
                    if l > r {
                        return Err(fail("线程池活跃数或容量关系无效"));
                    }
                }
            }
        }
        previous = Some(sample);
    }
    if n(samples.last().ok_or_else(|| fail("缺少样本"))?, time) - n(&samples[0], time)
        > 86_400_000.0
    {
        return Err(fail("趋势持续时间超过24小时"));
    }
    Ok(())
}
pub fn parse_json_report(content: &[u8], id: &str, kind: &str) -> HostResult<Value> {
    if id.trim().is_empty() || id.len() > 128 {
        return Err(fail("制品ID无效"));
    }
    let limit = if matches!(
        kind,
        "HEAP_HISTOGRAM" | "TRACE_HOTSPOTS" | "MONITOR_WINDOWS"
    ) {
        512 * 1024
    } else {
        256 * 1024
    };
    if content.is_empty() || content.len() > limit {
        return Err(fail("制品超过解析大小边界"));
    }
    let parsed: Value = serde_json::from_slice(content).map_err(fail)?;
    strict(
        &parsed,
        if kind == "HEAP_HISTOGRAM" {
            &["schemaVersion", "product", "kind", "snapshot"]
        } else {
            &["schemaVersion", "product", "kind", "recording"]
        },
    )?;
    if parsed["product"] != "tanwei" || s(&parsed, "kind") != kind.to_lowercase().replace('_', "-")
    {
        return Err(fail("制品签名不匹配"));
    }
    if kind == "HEAP_HISTOGRAM" {
        if parsed["schemaVersion"] != 1 {
            return Err(fail("制品格式版本不受支持"));
        }
        validate_heap(&parsed["snapshot"])?;
        return Ok(json!({"artifactId":id,"schemaVersion":1,"snapshot":parsed["snapshot"]}));
    }
    let recording = &parsed["recording"];
    if kind == "JIT_TREND" || kind == "THREAD_POOL_TREND" {
        let jit = kind == "JIT_TREND";
        let version = if jit && !recording["regressionIdentity"].is_null() {
            2
        } else {
            1
        };
        if parsed["schemaVersion"] != version {
            return Err(fail("趋势格式版本与身份信息不匹配"));
        }
        validate_trend(recording, jit)?;
        return Ok(
            json!({"artifactId":id,"schemaVersion":version,"recording":recording,"summary":if jit{summarize_jit(recording)?}else{summarize_pool(recording)?}}),
        );
    }
    if parsed["schemaVersion"] != 1 {
        return Err(fail("观测制品格式版本不受支持"));
    }
    observation::validate_recording(recording, kind)?;
    Ok(json!({"kind":kind,"artifactId":id,"schemaVersion":1,"recording":recording}))
}
pub fn summarize_pool(recording: &Value) -> HostResult<Value> {
    validate_trend(recording, false)?;
    let samples = array(recording, "samples", 2, 120)?;
    let first = &samples[0];
    let last = &samples[samples.len() - 1];
    let duration = n(last, "capturedAt") - n(first, "capturedAt");
    let queue = |v: &Value| n(v, "queuedTasks") + n(v, "queuedSubmissions");
    let (
        mut peak,
        mut growth,
        mut previous,
        mut total,
        mut count,
        mut peak_util,
        mut saturated,
        mut terminal,
    ) = (0.0f64, 0, None, 0.0, 0, 0.0f64, 0, false);
    for sample in samples {
        let q = queue(sample);
        peak = peak.max(q);
        if previous.is_some_and(|p| q > p) {
            growth += 1;
        }
        previous = Some(q);
        let cap = if recording["poolKind"] == "THREAD_POOL" {
            sample["maximumSize"]
                .as_f64()
                .or_else(|| sample["configuredSize"].as_f64())
        } else {
            sample["configuredSize"]
                .as_f64()
                .or_else(|| sample["maximumSize"].as_f64())
        };
        if let (Some(active), Some(capacity)) =
            (sample["activeCount"].as_f64(), cap.filter(|c| *c > 0.0))
        {
            let util = active / capacity * 100.0;
            total += util;
            count += 1;
            peak_util = peak_util.max(util);
            if util >= 100.0 {
                saturated += 1;
            }
        }
        terminal |= ["SHUTDOWN", "TERMINATING", "TERMINATED"].contains(&s(sample, "state"));
    }
    let completed = delta(first, last, "completedTasks");
    Ok(
        json!({"sampleCount":samples.len(),"durationMillis":duration,"initialQueue":queue(first),"currentQueue":queue(last),"queueDelta":queue(last)-queue(first),"peakQueue":peak,"queueGrowthIntervals":growth,"averageUtilizationPercent":if count==0{Value::Null}else{json!(round(total/count as f64))},"peakUtilizationPercent":if count==0{Value::Null}else{json!(round(peak_util))},"saturatedSamples":saturated,"completedTaskDelta":completed,"throughputPerSecond":completed.as_f64().filter(|_|duration>0.0).map(|v|round(v/(duration/1000.0))),"stealDelta":delta(first,last,"stealCount"),"terminalStateSeen":terminal,"starvationLikely":queue(last)>0.0&&queue(last)>queue(first)&&saturated*2>=samples.len()}),
    )
}
fn pressure(percent: f64) -> &'static str {
    if percent >= 100.0 {
        "EXHAUSTED"
    } else if percent >= 90.0 {
        "HIGH"
    } else if percent >= 80.0 {
        "ELEVATED"
    } else {
        "NORMAL"
    }
}
pub fn summarize_jit(recording: &Value) -> HostResult<Value> {
    validate_trend(recording, true)?;
    let samples = array(recording, "samples", 2, 120)?;
    let first = &samples[0];
    let last = &samples[samples.len() - 1];
    let duration = n(last, "sampledAtEpochMillis") - n(first, "sampledAtEpochMillis");
    let compiles = delta(first, last, "totalCompiles");
    let failures = match (
        delta(first, last, "bailouts").as_f64(),
        delta(first, last, "invalidations").as_f64(),
    ) {
        (Some(l), Some(r)) => json!(l + r),
        _ => Value::Null,
    };
    let time = delta(first, last, "compilerTimeMillis");
    let mut peak = 0.0f64;
    let mut percent = 0.0f64;
    for sample in samples {
        peak = peak.max(n(sample, "codeCacheUsedBytes"));
        percent = percent
            .max(n(sample, "codeCacheUsedBytes") / n(sample, "codeCacheCapacityBytes") * 100.0);
    }
    let rate = |value: &Value| {
        value
            .as_f64()
            .filter(|_| duration > 0.0)
            .map(|v| round(v / (duration / 1000.0)))
    };
    Ok(
        json!({"sampleCount":samples.len(),"durationMillis":duration,"compileDelta":compiles,"standardCompileDelta":delta(first,last,"standardCompiles"),"osrCompileDelta":delta(first,last,"osrCompiles"),"failureDelta":failures,"compilesPerSecond":rate(&compiles),"failuresPerSecond":rate(&failures),"compilationTimePercent":time.as_f64().filter(|_|duration>0.0).map(|v|round(v/duration*100.0)),"initialCodeCacheUsedBytes":first["codeCacheUsedBytes"],"endingCodeCacheUsedBytes":last["codeCacheUsedBytes"],"peakCodeCacheUsedBytes":peak,"codeCacheGrowthBytes":n(last,"codeCacheUsedBytes")-n(first,"codeCacheUsedBytes"),"endingCodeCachePercent":round(n(last,"codeCacheUsedBytes")/n(last,"codeCacheCapacityBytes")*100.0),"peakCodeCachePercent":round(percent),"codeCachePressure":pressure(round(percent)),"codeCacheCapacityKind":last["codeCacheCapacityKind"]}),
    )
}
pub fn compare_heap(baseline: &Value, current: &Value, target: &str) -> HostResult<Value> {
    let left = &baseline["snapshot"];
    let right = &current["snapshot"];
    validate_heap(left)?;
    validate_heap(right)?;
    for key in ["targetId", "targetStartTime", "query", "limit", "scanLimit"] {
        if left[key] != right[key] {
            return Err(fail(format!("直方图比较边界不一致: {key}")));
        }
    }
    if s(left, "targetId") != target || n(left, "capturedAt") > n(right, "capturedAt") {
        return Err(fail("直方图身份或基线时间无效"));
    }
    let left_rows = array(left, "rows", 0, 100)?;
    let right_rows = array(right, "rows", 0, 100)?;
    let index = left_rows
        .iter()
        .map(|v| ((s(v, "className"), s(v, "classLoader")), v))
        .collect::<HashMap<_, _>>();
    let mut seen = HashSet::new();
    let exact = left["rowsComplete"] == true && right["rowsComplete"] == true;
    let totals = left["scanComplete"] == true && right["scanComplete"] == true;
    let (mut unmatched_left, mut unmatched_right) = (0, 0);
    let mut rows = Vec::new();
    let null = Value::Null;
    for row in right_rows {
        let key = (s(row, "className"), s(row, "classLoader"));
        seen.insert(key);
        let previous = index.get(&key).copied();
        if previous.is_some() || exact {
            rows.push(heap_delta(previous.unwrap_or(&null), row));
        } else {
            unmatched_right += 1;
        }
    }
    for row in left_rows {
        if !seen.contains(&(s(row, "className"), s(row, "classLoader"))) {
            if exact {
                rows.push(heap_delta(row, &null));
            } else {
                unmatched_left += 1;
            }
        }
    }
    rows.sort_by(|l, r| {
        n(r, "shallowBytesDelta")
            .abs()
            .total_cmp(&n(l, "shallowBytesDelta").abs())
            .then_with(|| {
                n(r, "instanceDelta")
                    .abs()
                    .total_cmp(&n(l, "instanceDelta").abs())
            })
            .then_with(|| s(l, "className").cmp(s(r, "className")))
            .then_with(|| s(l, "classLoader").cmp(s(r, "classLoader")))
    });
    Ok(
        json!({"baselineArtifactId":baseline["artifactId"],"currentArtifactId":current["artifactId"],"targetId":target,"targetStartTime":left["targetStartTime"],"baselineCapturedAt":left["capturedAt"],"currentCapturedAt":right["capturedAt"],"intervalMillis":n(right,"capturedAt")-n(left,"capturedAt"),"query":left["query"],"limit":left["limit"],"scanLimit":left["scanLimit"],"exactRowCoverage":exact,"totalsComparable":totals,"instanceDelta":if totals{delta(left,right,"accountedObjects")}else{Value::Null},"shallowBytesDelta":if totals{delta(left,right,"accountedBytes")}else{Value::Null},"growingClasses":rows.iter().filter(|v|v["kind"]=="GROWTH").count(),"releasedClasses":rows.iter().filter(|v|v["kind"]=="RELEASE").count(),"stableClasses":rows.iter().filter(|v|v["kind"]=="STABLE").count(),"unmatchedBaselineRows":unmatched_left,"unmatchedCurrentRows":unmatched_right,"rows":rows}),
    )
}
fn heap_delta(left: &Value, right: &Value) -> Value {
    let instances = n(right, "instanceCount") - n(left, "instanceCount");
    let bytes = n(right, "shallowBytes") - n(left, "shallowBytes");
    let id = if right.is_null() { left } else { right };
    json!({"className":id["className"],"classLoader":id["classLoader"],"baselineInstances":n(left,"instanceCount"),"currentInstances":n(right,"instanceCount"),"instanceDelta":instances,"baselineShallowBytes":n(left,"shallowBytes"),"currentShallowBytes":n(right,"shallowBytes"),"shallowBytesDelta":bytes,"kind":if instances>0.0||bytes>0.0{"GROWTH"}else if instances<0.0||bytes<0.0{"RELEASE"}else{"STABLE"}})
}
pub fn compare_trend(
    baseline: &Value,
    current: &Value,
    input: &Value,
    jit: bool,
) -> HostResult<Value> {
    let left = &baseline["recording"];
    let right = &current["recording"];
    validate_trend(left, jit)?;
    validate_trend(right, jit)?;
    let mode = input["mode"].as_str().unwrap_or("SAME_JVM");
    let cross = jit && mode == "CROSS_RELEASE";
    let l = array(left, "samples", 2, 120)?;
    let r = array(right, "samples", 2, 120)?;
    let time = if jit {
        "sampledAtEpochMillis"
    } else {
        "capturedAt"
    };
    let ls = n(&l[0], time);
    let le = n(&l[l.len() - 1], time);
    let rs = n(&r[0], time);
    let re = n(&r[r.len() - 1], time);
    if le > rs {
        return Err(fail("基线必须在当前记录之前结束"));
    }
    if cross {
        let li = &left["regressionIdentity"];
        let ri = &right["regressionIdentity"];
        if li.is_null() || ri.is_null() {
            return Err(fail("REGRESSION_IDENTITY_MISSING"));
        }
        if left["targetId"] == right["targetId"]
            && left["jvmStartTimeEpochMillis"] == right["jvmStartTimeEpochMillis"]
        {
            return Err(fail("SAME_JVM_CYCLE"));
        }
        if li["workloadKey"] != ri["workloadKey"] || li["targetMainClass"] != ri["targetMainClass"]
        {
            return Err(fail("WORKLOAD_MISMATCH"));
        }
        if li["releaseLabel"] == ri["releaseLabel"] {
            return Err(fail("RELEASE_LABEL_UNCHANGED"));
        }
        if left["samplingIntervalMillis"] != right["samplingIntervalMillis"] {
            return Err(fail("SAMPLING_INTERVAL_CHANGED"));
        }
        if l[0]["codeCacheCapacityKind"] != "MAX" || r[0]["codeCacheCapacityKind"] != "MAX" {
            return Err(fail("MAX_CAPACITY_REQUIRED"));
        }
        let ratio = (re - rs) / (le - ls);
        if !(0.8..=1.25).contains(&ratio) {
            return Err(fail("DURATION_MISMATCH"));
        }
    } else {
        for key in ["targetId", "jvmStartTimeEpochMillis"] {
            if left[key] != right[key] {
                return Err(fail(format!("趋势身份不一致: {key}")));
            }
        }
    }
    if jit
        && !cross
        && (l[0]["codeCacheCapacityKind"] != r[0]["codeCacheCapacityKind"]
            || (l[0]["codeCacheCapacityKind"] == "MAX"
                && l[0]["codeCacheCapacityBytes"] != r[0]["codeCacheCapacityBytes"]))
    {
        return Err(fail("CODE_CACHE_CAPACITY_CHANGED"));
    }
    if !jit {
        for key in ["poolIdentity", "poolClassName", "poolKind"] {
            if left[key] != right[key] {
                return Err(fail("POOL_IDENTITY_CHANGED"));
            }
        }
    }
    let bs = if jit {
        summarize_jit(left)?
    } else {
        summarize_pool(left)?
    };
    let cs = if jit {
        summarize_jit(right)?
    } else {
        summarize_pool(right)?
    };
    let mut result = json!({"baselineArtifactId":baseline["artifactId"],"currentArtifactId":current["artifactId"],"baselineStartedAt":ls,"baselineEndedAt":le,"currentStartedAt":rs,"currentEndedAt":re,"intervalMillis":rs-le,"baseline":bs,"current":cs});
    if jit {
        result["mode"] = mode.into();
        result["baselineTargetId"] = left["targetId"].clone();
        result["currentTargetId"] = right["targetId"].clone();
        result["baselineJvmStartTimeEpochMillis"] = left["jvmStartTimeEpochMillis"].clone();
        result["currentJvmStartTimeEpochMillis"] = right["jvmStartTimeEpochMillis"].clone();
        result["baselineIdentity"] = left["regressionIdentity"].clone();
        result["currentIdentity"] = right["regressionIdentity"].clone();
        for (out, key) in [
            ("compileRateDelta", "compilesPerSecond"),
            ("failureRateDelta", "failuresPerSecond"),
            ("compilationTimePercentDelta", "compilationTimePercent"),
            ("endingCodeCachePercentDelta", "endingCodeCachePercent"),
            ("peakCodeCachePercentDelta", "peakCodeCachePercent"),
            ("codeCacheGrowthDeltaBytes", "codeCacheGrowthBytes"),
        ] {
            result[out] = delta(&bs, &cs, key);
        }
        result["pressureChanged"] = json!(bs["codeCachePressure"] != cs["codeCachePressure"]);
    } else {
        for key in [
            "targetId",
            "jvmStartTimeEpochMillis",
            "poolIdentity",
            "poolClassName",
            "poolKind",
        ] {
            result[key] = left[key].clone();
        }
        for (out, key) in [
            ("peakQueueDelta", "peakQueue"),
            ("endingQueueDelta", "currentQueue"),
            ("averageUtilizationDelta", "averageUtilizationPercent"),
            ("throughputDelta", "throughputPerSecond"),
        ] {
            result[out] = delta(&bs, &cs, key);
        }
        result["starvationChanged"] = json!(bs["starvationLikely"] != cs["starvationLikely"]);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn heap(count: i64, at: i64) -> Value {
        json!({"targetId":"local:42","targetStartTime":"2026-07-31T00:00:00Z","capturedAt":at,"query":"dev.example","limit":100,"scanLimit":1000000,"scanComplete":true,"rowsComplete":true,"accountedObjects":count,"accountedBytes":count*24,"rows":[{"className":"dev.example.Probe","classLoader":"AppClassLoader@1","instanceCount":count,"shallowBytes":count*24,"averageShallowBytes":24}]})
    }
    fn jit() -> Value {
        json!({"targetId":"local:42","jvmStartTimeEpochMillis":500,"samplingIntervalMillis":10000,"samples":[{"sampledAtEpochMillis":1000,"totalCompiles":100,"standardCompiles":90,"osrCompiles":10,"bailouts":1,"invalidations":2,"compilerTimeMillis":200,"codeCacheUsedBytes":70,"codeCacheCapacityBytes":100,"codeCacheCapacityKind":"MAX"},{"sampledAtEpochMillis":11000,"totalCompiles":120,"standardCompiles":108,"osrCompiles":12,"bailouts":2,"invalidations":3,"compilerTimeMillis":700,"codeCacheUsedBytes":85,"codeCacheCapacityBytes":100,"codeCacheCapacityKind":"MAX"}]})
    }
    #[test]
    fn heap_round_trip_and_complete_diff() {
        let snapshot = heap(3, 1000);
        let payload = json!({"schemaVersion":1,"product":"tanwei","kind":"heap-histogram","snapshot":snapshot});
        let parsed =
            parse_json_report(payload.to_string().as_bytes(), "baseline", "HEAP_HISTOGRAM")
                .unwrap();
        assert_eq!(parsed["snapshot"], snapshot);
        let current = json!({"artifactId":"current","snapshot":heap(15,3500)});
        let diff = compare_heap(&parsed, &current, "local:42").unwrap();
        assert_eq!(diff["intervalMillis"].as_f64(), Some(2500.0));
        assert_eq!(diff["shallowBytesDelta"].as_f64(), Some(288.0));
        assert_eq!(diff["growingClasses"], 1);
    }
    #[test]
    fn heap_rejects_duplicates_and_incomplete_totals() {
        let mut duplicate = heap(3, 1000);
        let row = duplicate["rows"][0].clone();
        duplicate["rows"].as_array_mut().unwrap().push(row);
        assert!(validate_heap(&duplicate).is_err());
        let mut bad = heap(3, 1000);
        bad["accountedObjects"] = 4.into();
        assert!(validate_heap(&bad).is_err());
    }
    #[test]
    fn partial_histograms_do_not_invent_releases() {
        let mut baseline = heap(3, 1000);
        baseline["rowsComplete"] = false.into();
        let mut current = heap(5, 2000);
        current["rowsComplete"] = false.into();
        current["rows"][0]["className"] = "dev.Other".into();
        let diff = compare_heap(
            &json!({"snapshot":baseline}),
            &json!({"snapshot":current}),
            "local:42",
        )
        .unwrap();
        assert_eq!(diff["rows"], json!([]));
        assert_eq!(diff["unmatchedBaselineRows"], 1);
        assert_eq!(diff["unmatchedCurrentRows"], 1);
    }
    #[test]
    fn jit_summary_matches_existing_contract() {
        let summary = summarize_jit(&jit()).unwrap();
        for (key, expected) in [
            ("compileDelta", 20.0),
            ("failureDelta", 2.0),
            ("compilesPerSecond", 2.0),
            ("failuresPerSecond", 0.2),
            ("compilationTimePercent", 5.0),
            ("endingCodeCachePercent", 85.0),
        ] {
            assert_eq!(summary[key].as_f64(), Some(expected), "{key}");
        }
        assert_eq!(summary["codeCachePressure"], "ELEVATED");
        assert_eq!(pressure(100.0), "EXHAUSTED");
        assert_eq!(pressure(99.0), "HIGH");
    }
    #[test]
    fn jit_rejects_counter_regression_restart_and_schema_confusion() {
        let mut bad = jit();
        bad["samples"][1]["totalCompiles"] = 99.into();
        assert!(summarize_jit(&bad).is_err());
        let mut wrong = jit();
        wrong["samples"][1]["codeCacheCapacityKind"] = "COMMITTED".into();
        assert!(validate_trend(&wrong, true).is_err());
        let payload =
            json!({"schemaVersion":2,"product":"tanwei","kind":"jit-trend","recording":jit()});
        assert!(parse_json_report(payload.to_string().as_bytes(), "id", "JIT_TREND").is_err());
    }
    #[test]
    fn pool_summary_preserves_starvation_evidence() {
        let samples=[0,3,8].iter().enumerate().map(|(index,q)|json!({"capturedAt":1000+index*2000,"state":"RUNNING","configuredSize":2,"poolSize":4,"activeCount":4,"maximumSize":4,"queuedTasks":q,"remainingQueueCapacity":100-q,"completedTasks":10+index*2,"queuedSubmissions":null,"runningCount":null,"stealCount":null})).collect::<Vec<_>>();
        let recording = json!({"targetId":"local:42","jvmStartTimeEpochMillis":500,"poolIdentity":"ThreadPoolExecutor@1a2b3c","poolClassName":"java.util.concurrent.ThreadPoolExecutor","poolKind":"THREAD_POOL","alias":"订单异步池","samplingIntervalMillis":2000,"samples":samples});
        let summary = summarize_pool(&recording).unwrap();
        assert_eq!(summary["starvationLikely"], true);
        assert_eq!(summary["saturatedSamples"], 3);
        assert_eq!(summary["throughputPerSecond"].as_f64(), Some(1.0));
    }
    #[test]
    fn thread_dump_preserves_long_ids_locks_and_cpu_delta() {
        let dump="Tanwei Thread Dump\nformatVersion=1\ncapturedAt=2026-07-30T22:00:00Z\nprocessId=42\njvmStartTimeMillis=1785450000000\n\n\"blocked-worker\" #7 state=BLOCKED cpuTimeNanos=12000 deadlocked=true\n  waitingOn=java.lang.Object@123 owner=#8 \"lock-owner\"\n    at example.Work.run(Work.java:42)\n      - locked java.lang.Object@456\n";
        let report = parse_thread_dump(dump, "baseline").unwrap();
        assert_eq!(report["threads"][0]["lockOwnerId"], "8");
        assert_eq!(
            report["threads"][0]["stack"][0],
            "example.Work.run(Work.java:42)"
        );
        let next = parse_thread_dump(&dump.replace("12000", "15000"), "current").unwrap();
        let diff = compare_thread_dumps(&report, &next, "local:42").unwrap();
        assert_eq!(diff["threads"][0]["cpuDeltaNanos"], "3000");
        assert_eq!(diff["summary"]["unchangedThreads"], 1);
        assert!(parse_thread_dump("wrong\n", "id").is_err());
    }
    #[test]
    fn jfr_aggregates_compilation_outcomes_and_duration() {
        let report=parse_jfr(&json!({"recording":{"events":[{"type":"jdk.Compilation","values":{"startTime":"2026-07-30T10:00:00Z","duration":"PT0.002S","compiler":"c1","method":{"type":{"name":"dev/example/Worker"},"name":"run","descriptor":"()V"},"compileLevel":3,"succeded":true,"isOsr":true,"codeSize":1024,"inlinedBytes":128}},{"type":"jdk.GarbageCollection","values":{"startTime":"2026-07-30T10:00:01Z","duration":"PT0.0125S"}}]}}).to_string(),"jfr").unwrap();
        assert_eq!(report["compilationCount"], 1);
        assert_eq!(
            report["compilations"][0]["method"],
            "dev.example.Worker.run()V"
        );
        assert_eq!(report["compilationDurationMillis"].as_f64(), Some(2.0));
        assert_eq!(report["gcPauses"][0]["durationMillis"].as_f64(), Some(12.5));
    }
    #[test]
    fn trace_export_preserves_integer_metrics_and_direct_child_self_time() {
        let input = json!({"targetId":"local:42","taskId":"b133dede-c1f1-4789-9956-41a122c5e541","taskState":"SUCCEEDED","target":{"className":"dev.Work","classLoader":"loader","methodName":"run","parameterTypes":[]},"rootMethod":"dev.Work.run()","scopePrefix":"dev","includeRules":[],"excludeRules":[],"dropped":0,"traces":[{"traceId":1,"capturedAtEpochMillis":1000,"durationNanos":100,"truncatedSpans":0,"spans":[{"sequence":0,"parentSequence":null,"method":"dev.Work.run","durationNanos":100,"exceptionType":null},{"sequence":1,"parentSequence":0,"method":"dev.Work.child","durationNanos":40,"exceptionType":null}]}]});
        let output = observation_export(&input, 500, 3000, true).unwrap();
        assert_eq!(output["recording"]["hotspots"][0]["selfDurationNanos"], 60);
        assert_eq!(
            output["recording"]["hotspots"][0]["maximumDurationNanos"],
            100
        );
        let report =
            parse_json_report(output.to_string().as_bytes(), "trace", "TRACE_HOTSPOTS").unwrap();
        assert_eq!(report["recording"]["spanCount"], 2);
    }
    #[test]
    fn monitor_rejects_forged_summary() {
        let input = json!({"targetId":"local:42","taskId":"b133dede-c1f1-4789-9956-41a122c5e541","taskState":"SUCCEEDED","target":{"className":"dev.Work","classLoader":"loader","methodName":"run","parameterTypes":[]},"method":"dev.Work.run()","intervalMillis":1000,"windows":[{"sequence":1,"startedAtEpochMillis":1000,"endedAtEpochMillis":2000,"calls":2,"failures":1,"durationNanos":50,"maximumDurationNanos":30,"p95DurationNanos":20,"p99DurationNanos":30}]});
        let output = observation_export(&input, 500, 3000, false).unwrap();
        assert_eq!(output["recording"]["summary"]["totalCalls"], 2);
        let mut forged = output.clone();
        forged["recording"]["summary"]["totalCalls"] = 2000.into();
        assert!(parse_json_report(forged.to_string().as_bytes(), "id", "MONITOR_WINDOWS").is_err());
    }
}
