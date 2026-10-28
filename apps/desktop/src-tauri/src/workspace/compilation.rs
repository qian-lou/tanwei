use super::{err, read_bounded, string, Workspace};
use crate::common::{HostResult, DECOMPILER_VERSION};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{io::AsyncWriteExt, process::Command};
use tokio_util::sync::CancellationToken;

const SOURCE_LIMIT: usize = 1024 * 1024;
const BYTECODE_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceInput {
    target_id: String,
    class_name: String,
    class_loader: String,
    source: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChangeSetInput {
    target_id: String,
    items: Vec<SourceItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceItem {
    class_name: String,
    class_loader: String,
    source: String,
}

impl Workspace {
    pub(crate) async fn decompile_class(&self, argument: &Value) -> HostResult<Value> {
        let id = string(argument)?;
        let artifact = self.artifact(id).map_err(|_| {
            err(
                "CLASS_ARTIFACT_NOT_FOUND",
                "Class Dump 制品不存在或尚未就绪",
            )
        })?;
        if artifact["type"] != "CLASS_DUMP" || artifact["status"] != "READY" {
            return Err(err(
                "CLASS_ARTIFACT_NOT_FOUND",
                "Class Dump 制品不存在或尚未就绪",
            ));
        }
        let path = self.artifact_path(id)?;
        let mut command = Command::new(self.paths.java());
        command
            .arg("-jar")
            .arg(self.paths.component("decompiler")?)
            .arg("--input")
            .arg(path);
        let output = crate::targets::run_command(
            command,
            Duration::from_secs(30),
            8 * 1024 * 1024,
            &CancellationToken::new(),
            "DECOMPILATION_FAILED",
        )
        .await?;
        let output =
            String::from_utf8(output).map_err(|error| err("DECOMPILATION_FAILED", error))?;
        let source = output.trim();
        if source.is_empty() {
            return Err(err("DECOMPILER_EMPTY_RESULT", "反编译器未返回源码"));
        }
        Ok(
            json!({"artifactId":id,"source":source,"decompiler":format!("CFR {DECOMPILER_VERSION}")}),
        )
    }

    pub(crate) async fn compile_class(&self, argument: &Value) -> HostResult<Value> {
        let input: SourceInput = serde_json::from_value(argument.clone())
            .map_err(|error| err("INVALID_INPUT", error))?;
        validate_identity(&input.class_name, &input.class_loader)?;
        if input.source.is_empty() || input.source.len() > SOURCE_LIMIT {
            return Err(err(
                "CLASS_SOURCE_SIZE_INVALID",
                "类源码为空或超过 1 MiB 安全上限",
            ));
        }
        let release = self.compilation_release(&input.target_id).await?;
        let details = self
            .targets
            .class_details(&input.target_id, &input.class_name, &input.class_loader)
            .await
            .map_err(|error| err("CLASS_IDENTITY_UNAVAILABLE", error.message))?;
        let class_path =
            compiler_class_path(&input.target_id, details["codeSource"].as_str()).await?;
        let root = CompilationDirectory::create()?;
        let output = root.0.join("classes");
        tokio::fs::create_dir_all(&output).await?;
        let source = write_source(&root.0.join("source"), &input.class_name, &input.source).await?;
        self.run_compiler(
            release,
            &output,
            &[source],
            &class_path.into_iter().collect::<Vec<_>>(),
            "CLASS_COMPILATION_FAILED",
        )
        .await?;
        let bytecode =
            compiled_bytecode(&output, &input.class_name, "COMPILED_CLASS_INVALID").await?;
        Ok(compiled_result(&input.class_name, release, &bytecode))
    }

    pub(crate) async fn compile_change_set(&self, argument: &Value) -> HostResult<Value> {
        let input: ChangeSetInput = serde_json::from_value(argument.clone())
            .map_err(|error| err("INVALID_INPUT", error))?;
        if !(2..=8).contains(&input.items.len()) {
            return Err(err(
                "CLASS_CHANGE_SET_SIZE_INVALID",
                "多类变更集必须包含 2 到 8 个精确类",
            ));
        }
        let mut identities = HashSet::new();
        let mut total_source = 0;
        for item in &input.items {
            validate_identity(&item.class_name, &item.class_loader)?;
            total_source += item.source.len();
            if item.source.is_empty()
                || item.source.len() > SOURCE_LIMIT
                || total_source > 2 * SOURCE_LIMIT
            {
                return Err(err(
                    "CLASS_CHANGE_SET_SOURCE_SIZE_INVALID",
                    "单类源码不得超过 1 MiB，变更集源码总量不得超过 2 MiB",
                ));
            }
            if item.class_loader != input.items[0].class_loader {
                return Err(err(
                    "CLASS_CHANGE_SET_LOADER_MISMATCH",
                    "变更集中的类必须来自同一个精确 ClassLoader",
                ));
            }
            if !identities.insert(&item.class_name) {
                return Err(err("CLASS_CHANGE_SET_DUPLICATE", "变更集不能包含重复类"));
            }
        }
        let release = self.compilation_release(&input.target_id).await?;
        let details = futures::future::try_join_all(input.items.iter().map(|item| {
            self.targets
                .class_details(&input.target_id, &item.class_name, &item.class_loader)
        }))
        .await
        .map_err(|error| err("CLASS_CHANGE_SET_IDENTITY_UNAVAILABLE", error.message))?;
        let mut class_paths = Vec::new();
        let mut seen = HashSet::new();
        for details in &details {
            if let Some(path) =
                compiler_class_path(&input.target_id, details["codeSource"].as_str()).await?
            {
                if seen.insert(path.clone()) {
                    class_paths.push(path);
                }
            }
        }
        let root = CompilationDirectory::create()?;
        let output = root.0.join("classes");
        tokio::fs::create_dir_all(&output).await?;
        let mut sources = Vec::with_capacity(input.items.len());
        for item in &input.items {
            sources
                .push(write_source(&root.0.join("source"), &item.class_name, &item.source).await?);
        }
        self.run_compiler(
            release,
            &output,
            &sources,
            &class_paths,
            "CLASS_CHANGE_SET_COMPILATION_FAILED",
        )
        .await?;
        let expected: HashSet<_> = input
            .items
            .iter()
            .map(|item| class_relative_path(&item.class_name, "class"))
            .collect();
        let actual = generated_classes(&output).await?;
        if actual != expected {
            return Err(err(
                "CLASS_CHANGE_SET_UNDECLARED_OUTPUT",
                "编译产生了未声明的附加类；请把内部类或辅助类作为精确变更项单独加入",
            ));
        }
        let mut compiled = Vec::with_capacity(input.items.len());
        let mut total_size = 0;
        for item in &input.items {
            let bytes = compiled_bytecode(
                &output,
                &item.class_name,
                "COMPILED_CLASS_CHANGE_SET_ITEM_INVALID",
            )
            .await?;
            total_size += bytes.len();
            if total_size > BYTECODE_LIMIT {
                return Err(err(
                    "COMPILED_CLASS_CHANGE_SET_TOO_LARGE",
                    "多类变更集编译字节码总量超过 2 MiB 安全上限",
                ));
            }
            compiled.push(compiled_result(&item.class_name, release, &bytes));
        }
        Ok(json!({"targetRelease":release,"totalSize":total_size,"items":compiled}))
    }

    async fn compilation_release(&self, target_id: &str) -> HostResult<u8> {
        let connection = self
            .targets
            .connection(target_id)
            .await
            .filter(|connection| connection["state"] == "READY")
            .ok_or_else(|| err("TARGET_NOT_CONNECTED", "目标 JVM 尚未建立可用连接"))?;
        java_release(connection["javaVersion"].as_str().unwrap_or("")).ok_or_else(|| {
            err(
                "TARGET_JAVA_VERSION_UNKNOWN",
                "无法确定目标 JVM 的 Java 主版本",
            )
        })
    }

    async fn run_compiler(
        &self,
        release: u8,
        output: &Path,
        sources: &[PathBuf],
        class_paths: &[PathBuf],
        error_code: &str,
    ) -> HostResult<()> {
        let mut command = Command::new(self.paths.javac());
        command
            .args(["-J-Xmx256m", "-J-XX:MaxMetaspaceSize=128m", "--release"])
            .arg(release.to_string())
            .args(["-encoding", "UTF-8", "-proc:none", "-d"])
            .arg(output);
        if !class_paths.is_empty() {
            command.arg("-classpath").arg(
                std::env::join_paths(class_paths)
                    .map_err(|error| err("CLASS_COMPILE_CLASSPATH_INVALID", error))?,
            );
        }
        command.args(sources);
        crate::targets::run_command(
            command,
            Duration::from_secs(30),
            1024 * 1024,
            &CancellationToken::new(),
            error_code,
        )
        .await
        .map_err(|mut error| {
            error.message = error.message.chars().take(16_384).collect();
            error
        })?;
        Ok(())
    }
}

fn validate_identity(name: &str, loader: &str) -> HostResult<()> {
    let valid = !name.is_empty()
        && name.len() <= 1024
        && name.split('.').all(|component| {
            let mut chars = component.bytes();
            chars
                .next()
                .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_' || byte == b'$')
                && chars.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$')
        });
    if !valid || loader.is_empty() || loader.encode_utf16().count() > 4096 {
        return Err(err("INVALID_INPUT", "类名或 ClassLoader 标识格式无效"));
    }
    Ok(())
}

fn java_release(version: &str) -> Option<u8> {
    let version = version.trim();
    let tail = version.strip_prefix("1.").unwrap_or(version);
    let digits = tail.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0
        || tail
            .as_bytes()
            .get(digits)
            .is_some_and(|byte| !b"._-".contains(byte))
    {
        return None;
    }
    tail[..digits]
        .parse::<u8>()
        .ok()
        .filter(|release| (8..=99).contains(release))
}

async fn compiler_class_path(target_id: &str, source: Option<&str>) -> HostResult<Option<PathBuf>> {
    if !target_id.starts_with("local:") || source.is_none_or(str::is_empty) {
        return Ok(None);
    }
    let url = tauri::Url::parse(source.unwrap_or_default())
        .map_err(|error| err("CLASS_COMPILE_CLASSPATH_UNAVAILABLE", error))?;
    if url.scheme() != "file" {
        return Ok(None);
    }
    let path = url.to_file_path().map_err(|_| {
        err(
            "CLASS_COMPILE_CLASSPATH_INVALID",
            "目标类 Code Source 不是有效文件地址",
        )
    })?;
    if path.as_os_str().len() > 32_768 {
        return Err(err(
            "CLASS_COMPILE_CLASSPATH_INVALID",
            "目标类 Code Source 路径超过安全上限",
        ));
    }
    let path = tokio::fs::canonicalize(path)
        .await
        .map_err(|error| err("CLASS_COMPILE_CLASSPATH_UNAVAILABLE", error))?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| err("CLASS_COMPILE_CLASSPATH_UNAVAILABLE", error))?;
    if !metadata.is_dir()
        && !(metadata.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("jar") || extension.eq_ignore_ascii_case("zip")
                }))
    {
        return Err(err(
            "CLASS_COMPILE_CLASSPATH_INVALID",
            "目标类 Code Source 不是可读目录、JAR 或 ZIP",
        ));
    }
    Ok(Some(path))
}

struct CompilationDirectory(PathBuf);
impl CompilationDirectory {
    fn create() -> HostResult<Self> {
        let root = std::env::temp_dir().join(format!("tanwei-compile-{}", uuid::Uuid::new_v4()));
        let mut directory = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directory.mode(0o700);
        }
        directory.create(&root)?;
        Ok(Self(root))
    }
}
impl Drop for CompilationDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn class_relative_path(name: &str, extension: &str) -> PathBuf {
    let mut path = name.split('.').collect::<PathBuf>();
    path.set_extension(extension);
    path
}

async fn write_source(root: &Path, name: &str, source: &str) -> HostResult<PathBuf> {
    let path = root.join(class_relative_path(name, "java"));
    tokio::fs::create_dir_all(
        path.parent()
            .ok_or_else(|| err("INVALID_INPUT", "类路径无效"))?,
    )
    .await?;
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&path).await?;
    file.write_all(source.as_bytes()).await?;
    file.flush().await?;
    Ok(path)
}

async fn compiled_bytecode(root: &Path, name: &str, error_code: &str) -> HostResult<Vec<u8>> {
    let bytes = read_bounded(
        &root.join(class_relative_path(name, "class")),
        BYTECODE_LIMIT,
    )
    .map_err(|error| err(error_code, error.message))?;
    if bytes.len() < 8 || !bytes.starts_with(&[0xca, 0xfe, 0xba, 0xbe]) {
        return Err(err(error_code, "编译器未生成有效的精确目标类"));
    }
    Ok(bytes)
}

fn compiled_result(name: &str, release: u8, bytes: &[u8]) -> Value {
    json!({"className":name,"targetRelease":release,"size":bytes.len(),"sha256":hex::encode(Sha256::digest(bytes)),"bytecodeBase64":base64::engine::general_purpose::STANDARD.encode(bytes)})
}

async fn generated_classes(root: &Path) -> HostResult<HashSet<PathBuf>> {
    let mut pending = vec![root.to_owned()];
    let mut classes = HashSet::new();
    while let Some(directory) = pending.pop() {
        let mut entries = tokio::fs::read_dir(directory).await?;
        while let Some(entry) = entries.next_entry().await? {
            let kind = entry.file_type().await?;
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file()
                && entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "class")
            {
                classes.insert(
                    entry
                        .path()
                        .strip_prefix(root)
                        .map_err(|error| err("CLASS_CHANGE_SET_UNDECLARED_OUTPUT", error))?
                        .to_owned(),
                );
            } else if kind.is_symlink() {
                return Err(err(
                    "CLASS_CHANGE_SET_UNDECLARED_OUTPUT",
                    "编译输出包含符号链接",
                ));
            }
        }
    }
    Ok(classes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn java_release_handles_legacy_and_current_versions() {
        for (version, expected) in [
            ("1.8.0_412", Some(8)),
            ("17.0.12", Some(17)),
            ("25-ea", Some(25)),
            ("25+3", None),
            ("1.7.0", None),
            ("100", None),
            ("garbage", None),
        ] {
            assert_eq!(java_release(version), expected);
        }
    }
    #[test]
    fn class_identity_rejects_path_traversal_and_source_injection() {
        for name in ["../Escape", "a/b.C", "a..C", "a.C;evil", "a.1C", ""] {
            assert!(validate_identity(name, "loader").is_err());
        }
        assert!(validate_identity("pkg.Outer$Nested", "loader").is_ok());
        assert_eq!(
            class_relative_path("pkg.Example", "class"),
            PathBuf::from("pkg/Example.class")
        );
    }
    #[tokio::test]
    async fn temporary_sources_are_private_and_always_cleaned() {
        let root = CompilationDirectory::create().unwrap();
        let path = root.0.clone();
        let source = write_source(
            &path,
            "pkg.Example",
            "package pkg; public class Example {} ",
        )
        .await
        .unwrap();
        assert!(source.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&source).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(root);
        assert!(!path.exists());
    }
}
