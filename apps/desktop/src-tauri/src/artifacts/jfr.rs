use super::*;
fn string(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty() && s.len() <= 4096)
}
fn number(v: &Value) -> f64 {
    v.as_f64()
        .filter(|v| v.is_finite() && *v >= 0.0 && *v <= SAFE as f64)
        .unwrap_or(0.0)
}
fn method(v: &Value, descriptor: bool) -> Option<String> {
    let name = string(&v["name"])?;
    let owner = string(&v["type"]["name"])
        .unwrap_or("(unknown)")
        .replace('/', ".");
    Some(format!(
        "{owner}.{name}{}",
        if descriptor {
            string(&v["descriptor"]).unwrap_or("").replace('/', ".")
        } else {
            String::new()
        }
    ))
}
fn tier(v: &Value) -> &'static str {
    match string(v).unwrap_or("").to_ascii_lowercase().as_str() {
        "c1" => "C1",
        "c2" => "C2",
        _ => "OTHER",
    }
}
fn add(v: &mut Value, key: &str, amount: f64) {
    v[key] = json!(n(v, key) + amount)
}
fn top(mut rows: Vec<Value>, fields: &[&str], name: &str, limit: usize) -> Vec<Value> {
    rows.sort_by(|l, r| {
        let mut ordering = std::cmp::Ordering::Equal;
        for field in fields {
            ordering = ordering.then_with(|| n(r, field).total_cmp(&n(l, field)));
        }
        ordering.then_with(|| s(l, name).cmp(s(r, name)))
    });
    rows.truncate(limit);
    rows
}
pub fn parse_jfr(content: &str, id: &str) -> HostResult<Value> {
    if content.len() > 32 * 1024 * 1024 {
        return Err(fail("JFR JSON 超过32MiB"));
    }
    let root: Value = serde_json::from_str(content).map_err(fail)?;
    let events = array(&root["recording"], "events", 0, 200000)?;
    let duration_re =
        regex::Regex::new(r"^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$")
            .map_err(fail)?;
    let duration = |v: &Value| -> f64 {
        if v.is_number() {
            return number(v);
        }
        let Some(c) = string(v).and_then(|s| duration_re.captures(s)) else {
            return 0.0;
        };
        [3600000.0, 60000.0, 1000.0]
            .iter()
            .enumerate()
            .map(|(i, m)| {
                c.get(i + 1)
                    .and_then(|g| g.as_str().parse::<f64>().ok())
                    .unwrap_or(0.0)
                    * m
            })
            .sum()
    };
    let mut event_types = HashMap::<String, usize>::new();
    let mut hot = HashMap::<String, usize>::new();
    let mut allocations = HashMap::<String, Value>::new();
    let mut compilations = HashMap::<String, Value>::new();
    let mut tiers = HashMap::<String, Value>::new();
    let mut deopts = HashMap::<String, Value>::new();
    let mut cpu = Vec::new();
    let mut gc = Vec::new();
    let (mut compilation_count, mut deopt_count, mut compilation_duration, mut code_bytes) =
        (0, 0, 0.0, 0.0);
    let (mut compilation_truncated, mut deopt_truncated) = (false, false);
    let (mut minimum, mut maximum): (Option<(i64, String)>, Option<(i64, String)>) = (None, None);
    for event in events {
        let Some(kind) = string(&event["type"]) else {
            continue;
        };
        let values = &event["values"];
        if !values.is_object() {
            continue;
        }
        *event_types.entry(kind.into()).or_default() += 1;
        let captured = string(&values["startTime"]).and_then(|s| {
            chrono::DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|d| (d.timestamp_millis(), s.to_string()))
        });
        if let Some(time) = &captured {
            if minimum.as_ref().is_none_or(|v| time.0 < v.0) {
                minimum = Some(time.clone());
            }
            if maximum.as_ref().is_none_or(|v| time.0 > v.0) {
                maximum = Some(time.clone());
            }
        }
        match kind {
            "jdk.ExecutionSample" | "jdk.NativeMethodSample" => {
                if let Some(name) = method(
                    &values["stackTrace"]["frames"]
                        .get(0)
                        .unwrap_or(&Value::Null)["method"],
                    false,
                ) {
                    *hot.entry(name).or_default() += 1;
                }
            }
            "jdk.ObjectAllocationSample" => {
                let class = string(&values["objectClass"]["name"])
                    .unwrap_or("(unknown)")
                    .replace('/', ".");
                let group = allocations
                    .entry(class.clone())
                    .or_insert_with(|| json!({"className":class,"samples":0,"estimatedBytes":0}));
                add(group, "samples", 1.0);
                add(group, "estimatedBytes", number(&values["weight"]));
            }
            "jdk.CPULoad" if cpu.len() < 300 => {
                if let Some(time) = captured {
                    cpu.push(json!({"capturedAt":time.1,"jvmUser":number(&values["jvmUser"]),"jvmSystem":number(&values["jvmSystem"]),"machineTotal":number(&values["machineTotal"])}));
                }
            }
            "jdk.GarbageCollection" | "jdk.GCPhasePause" if gc.len() < 100 => {
                if let Some(time) = captured {
                    gc.push(json!({"capturedAt":time.1,"name":string(&values["name"]).unwrap_or(if kind=="jdk.GCPhasePause"{"GC Phase Pause"}else{"Garbage Collection"}),"cause":string(&values["cause"]).unwrap_or(""),"durationMillis":duration(&values["duration"])}));
                }
            }
            "jdk.Compilation" => {
                let d = duration(&values["duration"]);
                let bytes = number(&values["codeSize"]);
                let inlined = number(&values["inlinedBytes"]);
                let compiler = tier(&values["compiler"]);
                let level = values["compileLevel"]
                    .as_i64()
                    .filter(|n| (0..=255).contains(n));
                let osr = values["isOsr"] == true;
                let succeeded = values["succeded"]
                    .as_bool()
                    .or_else(|| values["succeeded"].as_bool());
                compilation_count += 1;
                compilation_duration += d;
                code_bytes += bytes;
                let group=tiers.entry(compiler.into()).or_insert_with(||json!({"compiler":compiler,"compilations":0,"osrCompilations":0,"failedCompilations":0,"totalDurationMillis":0,"codeBytes":0}));
                for (key, amount) in [
                    ("compilations", 1.0),
                    ("osrCompilations", f64::from(osr)),
                    ("failedCompilations", f64::from(succeeded == Some(false))),
                    ("totalDurationMillis", d),
                    ("codeBytes", bytes),
                ] {
                    add(group, key, amount);
                }
                let Some(name) = method(&values["method"], true) else {
                    continue;
                };
                let key = json!([name, compiler, level]).to_string();
                if !compilations.contains_key(&key) && compilations.len() >= 20000 {
                    compilation_truncated = true;
                    continue;
                }
                let group=compilations.entry(key).or_insert_with(||json!({"method":name,"compiler":compiler,"compileLevel":level,"compilations":0,"osrCompilations":0,"succeededCompilations":0,"failedCompilations":0,"unknownOutcomeCompilations":0,"totalDurationMillis":0,"maximumDurationMillis":0,"codeBytes":0,"inlinedBytes":0}));
                for (key, amount) in [
                    ("compilations", 1.0),
                    ("osrCompilations", f64::from(osr)),
                    ("succeededCompilations", f64::from(succeeded == Some(true))),
                    ("failedCompilations", f64::from(succeeded == Some(false))),
                    ("unknownOutcomeCompilations", f64::from(succeeded.is_none())),
                    ("totalDurationMillis", d),
                    ("codeBytes", bytes),
                    ("inlinedBytes", inlined),
                ] {
                    add(group, key, amount);
                }
                group["maximumDurationMillis"] = json!(n(group, "maximumDurationMillis").max(d));
            }
            "jdk.Deoptimization" => {
                deopt_count += 1;
                let Some(name) = method(&values["method"], true) else {
                    continue;
                };
                let compiler = tier(&values["compiler"]);
                let reason = string(&values["reason"]).unwrap_or("(unknown)");
                let action = string(&values["action"]).unwrap_or("(unknown)");
                let key = json!([name, compiler, reason, action]).to_string();
                if !deopts.contains_key(&key) && deopts.len() >= 20000 {
                    deopt_truncated = true;
                    continue;
                }
                let group=deopts.entry(key).or_insert_with(||json!({"method":name,"compiler":compiler,"reason":reason,"action":action,"count":0}));
                add(group, "count", 1.0);
            }
            _ => (),
        }
    }
    let total_samples: usize = hot.values().sum();
    let truncated = event_types.len() > 100
        || hot.len() > 50
        || allocations.len() > 50
        || compilations.len() > 50
        || deopts.len() > 50
        || compilation_truncated
        || deopt_truncated;
    let duration = minimum
        .as_ref()
        .zip(maximum.as_ref())
        .map(|(l, r)| (r.0 - l.0).max(0))
        .unwrap_or(0);
    Ok(
        json!({"artifactId":id,"eventCount":events.len(),"startedAt":minimum.map(|v|v.1),"endedAt":maximum.map(|v|v.1),"durationMillis":duration,"eventTypes":top(event_types.into_iter().map(|(kind,count)|json!({"type":kind,"count":count})).collect(),&["count"],"type",100),"hotMethods":top(hot.into_iter().map(|(name,count)|json!({"method":name,"samples":count,"sharePercent":if total_samples==0{0.0}else{count as f64*100.0/total_samples as f64}})).collect(),&["samples"],"method",50),"allocations":top(allocations.into_values().collect(),&["estimatedBytes","samples"],"className",50),"cpuSamples":cpu,"gcPauses":gc,"compilationCount":compilation_count,"deoptimizationCount":deopt_count,"compilationDurationMillis":compilation_duration,"compiledCodeBytes":code_bytes,"compilations":top(compilations.into_values().collect(),&["totalDurationMillis","codeBytes","compilations"],"method",50),"compilerTiers":(["C1","C2","OTHER"].iter().filter_map(|k|tiers.get(*k)).collect::<Vec<_>>()),"deoptimizations":top(deopts.into_values().collect(),&["count"],"method",50),"truncated":truncated}),
    )
}
