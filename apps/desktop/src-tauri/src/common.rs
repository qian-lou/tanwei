use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

include!(concat!(env!("OUT_DIR"), "/metadata.rs"));

pub type HostResult<T> = Result<T, HostError>;

#[derive(Clone, Debug, Serialize, Deserialize, thiserror::Error)]
#[error("{message}")]
pub struct HostError {
    pub code: String,
    pub message: String,
}

impl HostError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<std::io::Error> for HostError {
    fn from(error: std::io::Error) -> Self {
        Self::new("IO_ERROR", error.to_string())
    }
}
impl From<serde_json::Error> for HostError {
    fn from(error: serde_json::Error) -> Self {
        Self::new("INVALID_DATA", error.to_string())
    }
}
impl From<rusqlite::Error> for HostError {
    fn from(error: rusqlite::Error) -> Self {
        Self::new("WORKSPACE_ERROR", error.to_string())
    }
}
impl From<tonic::Status> for HostError {
    fn from(error: tonic::Status) -> Self {
        Self::new("AGENT_REQUEST_FAILED", error.message())
    }
}

pub fn operation(result: HostResult<Value>) -> Value {
    match result {
        Ok(value) => json!({"ok":true,"value":value,"errorCode":null,"errorMessage":null}),
        Err(error) => {
            json!({"ok":false,"value":null,"errorCode":error.code,"errorMessage":error.message})
        }
    }
}

pub fn string_arg(args: &[Value], index: usize) -> HostResult<&str> {
    args.get(index)
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::new("INVALID_INPUT", "缺少字符串参数"))
}

#[derive(Clone, Debug)]
pub struct RuntimePaths {
    pub resources: PathBuf,
    pub user_data: PathBuf,
    pub version: String,
    pub development: bool,
}

impl RuntimePaths {
    pub fn java(&self) -> PathBuf {
        self.java_tool("java")
    }
    pub fn javac(&self) -> PathBuf {
        self.java_tool("javac")
    }
    pub fn jfr(&self) -> PathBuf {
        self.java_tool("jfr")
    }

    pub fn java_tool(&self, name: &str) -> PathBuf {
        let executable = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.into()
        };
        if !self.development {
            return self.resources.join("runtime/bin").join(executable);
        }
        std::env::var("TANWEI_JAVA_HOME")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(|home| PathBuf::from(home.trim()).join("bin").join(&executable))
            .unwrap_or_else(|| PathBuf::from(executable))
    }

    pub fn component(&self, id: &str) -> HostResult<PathBuf> {
        let (file, environment) = match id {
            "attach-helper" => (
                format!("tanwei-attach-helper-{PRODUCT_VERSION}.jar"),
                "TANWEI_ATTACH_HELPER_JAR",
            ),
            "bootstrap" => (
                format!("tanwei-bootstrap-{PRODUCT_VERSION}.jar"),
                "TANWEI_BOOTSTRAP_JAR",
            ),
            "agent" => (
                format!("tanwei-agent-{PRODUCT_VERSION}.jar"),
                "TANWEI_AGENT_JAR",
            ),
            "relay" => (
                format!("tanwei-relay-{PRODUCT_VERSION}.jar"),
                "TANWEI_RELAY_JAR",
            ),
            "decompiler" => (
                format!("tanwei-decompiler-{PRODUCT_VERSION}.jar"),
                "TANWEI_DECOMPILER_JAR",
            ),
            "protocol" => ("tanwei.proto".into(), "TANWEI_PROTOCOL_PATH"),
            _ => {
                return Err(HostError::new(
                    "UNKNOWN_COMPONENT",
                    format!("未知组件 {id}"),
                ))
            }
        };
        let path = if !self.development {
            self.resources.join("jvm").join(file)
        } else if let Some(value) = std::env::var(environment)
            .ok()
            .filter(|s| !s.trim().is_empty())
        {
            PathBuf::from(value.trim())
        } else {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
            if id == "protocol" {
                root.join("jvm/protocol/src/main/proto").join(file)
            } else {
                root.join("jvm").join(id).join("target").join(file)
            }
        };
        if !path.is_file() {
            return Err(HostError::new(
                "COMPONENT_NOT_FOUND",
                format!("找不到 {id} 组件，请先执行 npm run build:jvm"),
            ));
        }
        Ok(path)
    }

    pub fn verify_installation(&self) -> HostResult<()> {
        if self.development {
            return Ok(());
        }
        let manifest_path = self.resources.join("jvm/component-manifest.json");
        if fs::metadata(&manifest_path)?.len() > 1024 * 1024 {
            return Err(HostError::new("INSTALLATION_INVALID", "组件清单过大"));
        }
        let manifest: Value = serde_json::from_slice(&fs::read(manifest_path)?)?;
        if manifest["schemaVersion"] != 1
            || manifest["product"] != "tanwei"
            || manifest["productVersion"] != PRODUCT_VERSION
            || manifest["protocolVersion"] != PROTOCOL_VERSION
            || manifest["platform"] != platform()
            || manifest["architecture"] != architecture()
        {
            return Err(HostError::new(
                "INSTALLATION_INVALID",
                "组件清单版本或平台不匹配",
            ));
        }
        let entries = manifest["components"]
            .as_array()
            .filter(|entries| entries.len() == 6)
            .ok_or_else(|| HostError::new("INSTALLATION_INVALID", "组件清单必须包含六个组件"))?;
        for id in [
            "attach-helper",
            "bootstrap",
            "agent",
            "protocol",
            "relay",
            "decompiler",
        ] {
            let path = self.component(id)?;
            let entry = entries
                .iter()
                .find(|entry| entry["id"] == id)
                .ok_or_else(|| HostError::new("INSTALLATION_INVALID", format!("缺少组件 {id}")))?;
            let expected_version = match id {
                "protocol" => PROTOCOL_VERSION,
                "decompiler" => DECOMPILER_VERSION,
                _ => PRODUCT_VERSION,
            };
            if entry["file"].as_str() != path.file_name().and_then(|name| name.to_str())
                || entry["version"] != expected_version
            {
                return Err(HostError::new(
                    "INSTALLATION_INVALID",
                    format!("组件 {id} 元数据不匹配"),
                ));
            }
            verify_file(&path, entry)?;
        }
        let runtime = manifest["runtimeFiles"]
            .as_array()
            .filter(|entries| entries.len() == 4)
            .ok_or_else(|| HostError::new("INSTALLATION_INVALID", "缺少运行时清单"))?;
        let expected_runtime: HashSet<&str> = if cfg!(windows) {
            [
                "bin/java.exe",
                "bin/javac.exe",
                "bin/jfr.exe",
                "lib/modules",
            ]
        } else {
            ["bin/java", "bin/javac", "bin/jfr", "lib/modules"]
        }
        .into_iter()
        .collect();
        let mut runtime_files = HashSet::new();
        for entry in runtime {
            let file = entry["file"]
                .as_str()
                .ok_or_else(|| HostError::new("INSTALLATION_INVALID", "非法运行时文件"))?;
            if !expected_runtime.contains(file) || !runtime_files.insert(file) {
                return Err(HostError::new("INSTALLATION_INVALID", "非法运行时文件"));
            }
            verify_file(&self.resources.join("runtime").join(file), entry)?;
        }
        let agent = entries.iter().find(|entry| entry["id"] == "agent").unwrap();
        let natives = manifest["nativeComponents"]
            .as_array()
            .filter(|entries| entries.len() == 2)
            .ok_or_else(|| HostError::new("INSTALLATION_INVALID", "缺少原生组件清单"))?;
        for id in ["async-profiler", "tanwei-heap-query"] {
            let native = natives
                .iter()
                .find(|entry| entry["id"] == id)
                .ok_or_else(|| HostError::new("INSTALLATION_INVALID", "缺少原生组件"))?;
            if native["containerSha256"] != agent["sha256"] || native["embeddedIn"] != agent["file"]
            {
                return Err(HostError::new(
                    "INSTALLATION_INVALID",
                    "原生组件与 Agent 容器不匹配",
                ));
            }
            let (version, license, source) = if id == "async-profiler" {
                (
                    ASYNC_PROFILER_VERSION,
                    "Apache-2.0",
                    "https://github.com/async-profiler/async-profiler",
                )
            } else {
                (
                    HEAP_QUERY_VERSION,
                    "PolyForm-Noncommercial-1.0.0",
                    "jvm/native/heap_query.c",
                )
            };
            if native["version"] != version
                || native["license"] != license
                || native["source"] != source
            {
                return Err(HostError::new(
                    "INSTALLATION_INVALID",
                    "原生组件版本或来源不匹配",
                ));
            }
            if id == "async-profiler"
                && native["platforms"]
                    != json!(["linux-x64", "linux-arm64", "macos-x64", "macos-arm64"])
            {
                return Err(HostError::new(
                    "INSTALLATION_INVALID",
                    "采样组件平台清单不匹配",
                ));
            }
            if id == "tanwei-heap-query" {
                let os = match platform() {
                    "darwin" => "macos",
                    "win32" => "windows",
                    value => value,
                };
                if native["platforms"] != json!([format!("{os}-{}", architecture())]) {
                    return Err(HostError::new(
                        "INSTALLATION_INVALID",
                        "堆查询组件平台不匹配",
                    ));
                }
            }
        }
        Ok(())
    }
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        std::env::consts::OS
    }
}
pub fn architecture() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        value => value,
    }
}

pub fn sha256_file(path: &Path) -> HostResult<String> {
    let mut input = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hex::encode(hash.finalize()))
}

fn verify_file(path: &Path, entry: &Value) -> HostResult<()> {
    let meta = fs::metadata(path)?;
    if !meta.is_file()
        || Some(meta.len()) != entry["size"].as_u64()
        || entry["sha256"].as_str() != Some(sha256_file(path)?.as_str())
    {
        return Err(HostError::new(
            "INSTALLATION_INVALID",
            format!("组件完整性校验失败：{}", path.display()),
        ));
    }
    Ok(())
}
