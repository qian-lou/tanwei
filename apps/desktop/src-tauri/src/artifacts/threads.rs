use super::*;
pub fn parse_thread_dump(content: &str, id: &str) -> HostResult<Value> {
    if id.trim().is_empty() || content.is_empty() || content.len() > 32 * 1024 * 1024 {
        return Err(fail("线程转储身份或大小无效"));
    }
    let header=regex::Regex::new(r#"^"([^"]*)" #([1-9]\d{0,18}) state=([A-Z_]+) cpuTimeNanos=(-1|0|[1-9]\d{0,18}) deadlocked=(true|false)$"#).map_err(fail)?;
    let waiting = regex::Regex::new(r#"^  waitingOn=(.+?) owner=#([1-9]\d{0,18}) "([^"]*)"$"#)
        .map_err(fail)?;
    let mut metadata = HashMap::<String, String>::new();
    let mut threads: Vec<Value> = Vec::new();
    let mut meta = true;
    let mut sync = false;
    for (index, line) in content.lines().enumerate() {
        if index >= 1_000_000 || line.encode_utf16().count() > 4096 {
            return Err(fail("线程转储文本超过行数或行长度边界"));
        }
        if index == 0 {
            if line != "Tanwei Thread Dump" {
                return Err(fail("线程转储签名无效"));
            }
            continue;
        }
        if meta {
            if line.is_empty() {
                meta = false;
                continue;
            }
            let (key, value) = line
                .split_once('=')
                .filter(|(k, _)| !k.is_empty())
                .ok_or_else(|| fail("线程转储元数据格式无效"))?;
            metadata.insert(key.into(), value.into());
            continue;
        }
        if let Some(c) = header.captures(line) {
            if threads.len() >= 10000 {
                return Err(fail("线程转储超过10000线程上限"));
            }
            threads.push(json!({"name":&c[1],"id":&c[2],"state":&c[3],"cpuTimeNanos":if &c[4]=="-1"{Value::Null}else{json!(&c[4])},"deadlocked":&c[5]=="true","waitingOn":null,"lockOwnerId":null,"lockOwnerName":null,"stack":[],"monitors":[],"synchronizers":[]}));
            sync = false;
            continue;
        }
        let Some(thread) = threads.last_mut() else {
            continue;
        };
        if let Some(c) = waiting.captures(line) {
            thread["waitingOn"] = json!(&c[1]);
            thread["lockOwnerId"] = json!(&c[2]);
            thread["lockOwnerName"] = json!(&c[3]);
            continue;
        }
        if let Some(lock) = line.strip_prefix("  waitingOn=") {
            thread["waitingOn"] = lock.into();
            continue;
        }
        if line == "    Locked ownable synchronizers:" {
            sync = true;
            continue;
        }
        let item = if let Some(frame) = line.strip_prefix("    at ") {
            Some(("stack", frame, 512))
        } else if let Some(lock) = line.strip_prefix("      - locked ") {
            Some(("monitors", lock, 256))
        } else if sync {
            line.strip_prefix("      - ")
                .map(|s| ("synchronizers", s, 256))
        } else {
            None
        };
        if let Some((key, value, max)) = item {
            if let Some(list) = thread[key].as_array_mut() {
                if list.len() < max {
                    list.push(value.into());
                }
            }
        }
    }
    if metadata.get("formatVersion").map(String::as_str) != Some("1") {
        return Err(fail("线程转储格式版本不受支持"));
    }
    let mut states = HashMap::<String, usize>::new();
    for thread in &threads {
        *states.entry(s(thread, "state").into()).or_default() += 1;
    }
    let integer = |key: &str| {
        metadata
            .get(key)
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|v| *v >= -SAFE && *v <= SAFE)
    };
    let get = |key: &str| metadata.get(key).map(String::as_str);
    let captured = get("capturedAt").filter(|v| chrono::DateTime::parse_from_rfc3339(v).is_ok());
    let jvm = get("jvmStartTimeMillis")
        .filter(|v| v.parse::<u64>().is_ok() && v.len() <= 19 && !v.starts_with('0') || *v == "0");
    Ok(
        json!({"artifactId":id,"capturedAt":captured,"processId":integer("processId"),"jvmStartTimeMillis":jvm,"javaVersion":get("javaVersion").unwrap_or("unknown"),"threadsSeen":integer("threadsSeen").filter(|v|*v>=0).unwrap_or(0),"threadsSelected":integer("threadsSelected").filter(|v|*v>=0).unwrap_or(threads.len() as i64),"maximumStackDepth":integer("maximumStackDepth").filter(|v|*v>=0).unwrap_or(0),"truncated":get("truncated")==Some("true"),"monitorsIncluded":get("monitorsIncluded")==Some("true"),"synchronizersIncluded":get("synchronizersIncluded")==Some("true"),"deadlockedThreads":integer("deadlockedThreads").filter(|v|*v>=0).unwrap_or(threads.iter().filter(|t|t["deadlocked"]==true).count() as i64),"stateCounts":states,"threads":threads}),
    )
}
pub fn compare_thread_dumps(baseline: &Value, current: &Value, target: &str) -> HostResult<Value> {
    for key in ["processId", "jvmStartTimeMillis"] {
        if baseline[key].is_null() || baseline[key] != current[key] {
            return Err(fail("线程转储进程身份或 JVM 周期不匹配"));
        }
    }
    let left = array(baseline, "threads", 0, 10000)?;
    let right = array(current, "threads", 0, 10000)?;
    let index = |values: &Vec<Value>| -> HostResult<HashMap<(String, String), Value>> {
        let mut map = HashMap::new();
        for v in values {
            if map
                .insert((s(v, "id").into(), s(v, "name").into()), v.clone())
                .is_some()
            {
                return Err(fail("线程转储包含重复身份"));
            }
        }
        Ok(map)
    };
    let l = index(left)?;
    let r = index(right)?;
    let mut changes = Vec::new();
    let null = Value::Null;
    for t in right {
        let key = (s(t, "id").to_string(), s(t, "name").to_string());
        changes.push(thread_delta(l.get(&key).unwrap_or(&null), t));
    }
    for t in left {
        if !r.contains_key(&(s(t, "id").to_string(), s(t, "name").to_string())) {
            changes.push(thread_delta(t, &null));
        }
    }
    let mut summary = json!({"baselineThreads":left.len(),"currentThreads":right.len(),"persistedThreads":0,"addedThreads":0,"removedThreads":0,"changedThreads":0,"unchangedThreads":0,"stateChanges":0,"waitChanges":0,"stackChanges":0,"lockChanges":0,"newlyDeadlocked":0,"recoveredDeadlocked":0});
    let add = |summary: &mut Value, key: &str| {
        summary[key] = json!(summary[key].as_u64().unwrap_or(0) + 1);
    };
    for c in &changes {
        let key = match s(c, "kind") {
            "ADDED" => "addedThreads",
            "REMOVED" => "removedThreads",
            "CHANGED" => "changedThreads",
            _ => "unchangedThreads",
        };
        add(&mut summary, key);
        if c["kind"] == "CHANGED" || c["kind"] == "UNCHANGED" {
            add(&mut summary, "persistedThreads");
        }
        for (source, out) in [
            ("stateChanged", "stateChanges"),
            ("waitChanged", "waitChanges"),
            ("stackChanged", "stackChanges"),
            ("locksChanged", "lockChanges"),
            ("newlyDeadlocked", "newlyDeadlocked"),
            ("recoveredDeadlocked", "recoveredDeadlocked"),
        ] {
            if c[source] == true {
                add(&mut summary, out);
            }
        }
    }
    let time = |v: &Value| {
        v["capturedAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis())
    };
    let interval = time(baseline)
        .zip(time(current))
        .map(|(l, r)| r - l)
        .filter(|n| *n >= 0);
    Ok(
        json!({"baselineArtifactId":baseline["artifactId"],"currentArtifactId":current["artifactId"],"targetId":target,"processId":baseline["processId"],"baselineCapturedAt":baseline["capturedAt"],"currentCapturedAt":current["capturedAt"],"intervalMillis":interval,"baselineTruncated":baseline["truncated"],"currentTruncated":current["truncated"],"summary":summary,"threads":changes}),
    )
}
fn thread_delta(left: &Value, right: &Value) -> Value {
    let persisted = !left.is_null() && !right.is_null();
    let state = persisted && left["state"] != right["state"];
    let wait = persisted
        && ["waitingOn", "lockOwnerId", "lockOwnerName"]
            .iter()
            .any(|k| left[k] != right[k]);
    let stack = persisted && left["stack"] != right["stack"];
    let locks = persisted
        && (left["monitors"] != right["monitors"]
            || left["synchronizers"] != right["synchronizers"]);
    let dead = left["deadlocked"] != true && right["deadlocked"] == true;
    let recovered = left["deadlocked"] == true && right["deadlocked"] != true;
    let kind = if left.is_null() {
        "ADDED"
    } else if right.is_null() {
        "REMOVED"
    } else if state || wait || stack || locks || dead || recovered {
        "CHANGED"
    } else {
        "UNCHANGED"
    };
    let id = if right.is_null() { left } else { right };
    let cpu = left["cpuTimeNanos"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .zip(
            right["cpuTimeNanos"]
                .as_str()
                .and_then(|s| s.parse::<u64>().ok()),
        )
        .and_then(|(l, r)| r.checked_sub(l))
        .map(|n| n.to_string());
    json!({"id":id["id"],"name":id["name"],"kind":kind,"baselineState":left["state"],"currentState":right["state"],"baselineWaitingOn":left["waitingOn"],"currentWaitingOn":right["waitingOn"],"baselineLockOwnerId":left["lockOwnerId"],"baselineLockOwnerName":left["lockOwnerName"],"currentLockOwnerId":right["lockOwnerId"],"currentLockOwnerName":right["lockOwnerName"],"baselineTopFrame":left["stack"].get(0),"currentTopFrame":right["stack"].get(0),"cpuDeltaNanos":cpu,"stateChanged":state,"waitChanged":wait,"stackChanged":stack,"locksChanged":locks,"newlyDeadlocked":dead,"recoveredDeadlocked":recovered})
}
