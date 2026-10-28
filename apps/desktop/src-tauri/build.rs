use std::{env, fs, path::PathBuf};

fn main() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // 将 Windows 默认的 1 MiB 主线程栈提高到 8 MiB，承载桌面 Host 初始化。
        println!("cargo:rustc-link-arg-bin=tanwei-desktop=/STACK:8388608");
    }
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../..");
    let package_path = root.join("package.json");
    let package: serde_json::Value =
        serde_json::from_slice(&fs::read(&package_path).unwrap()).unwrap();
    let output = PathBuf::from(env::var("OUT_DIR").unwrap());
    let mut constants = String::new();
    for (name, value) in [
        ("PRODUCT_VERSION", &package["version"]),
        (
            "PROTOCOL_VERSION",
            &package["tanweiBuild"]["protocolVersion"],
        ),
        (
            "DECOMPILER_VERSION",
            &package["tanweiBuild"]["decompilerVersion"],
        ),
        (
            "ASYNC_PROFILER_VERSION",
            &package["tanweiBuild"]["asyncProfilerVersion"],
        ),
        (
            "HEAP_QUERY_VERSION",
            &package["tanweiBuild"]["heapQueryVersion"],
        ),
        (
            "BOUNDED_PROFILER_VERSION",
            &package["tanweiBuild"]["boundedProfilerVersion"],
        ),
    ] {
        constants.push_str(&format!(
            "pub const {name}: &str = {:?};\n",
            value.as_str().expect("build metadata must be a string")
        ));
    }
    fs::write(output.join("metadata.rs"), constants).unwrap();
    println!("cargo:rerun-if-changed={}", package_path.display());
    let proto = root.join("jvm/protocol/src/main/proto/tanwei.proto");
    tonic_prost_build::configure()
        .build_server(true)
        .type_attribute(".", "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".", "#[serde(rename_all = \"camelCase\", default)]")
        .compile_protos(&[proto.as_path()], &[proto.parent().unwrap()])
        .expect("compile Tanwei gRPC protocol");
    println!("cargo:rerun-if-changed={}", proto.display());
    // Debug Host uses source JVM components. Unit tests and `cargo check` must
    // also work on a clean checkout before jlink resources have been staged.
    if env::var("PROFILE").as_deref() == Ok("debug") {
        let mut configuration: serde_json::Value = env::var("TAURI_CONFIG")
            .ok()
            .map(|value| serde_json::from_str(&value).expect("TAURI_CONFIG must be valid JSON"))
            .unwrap_or_else(|| serde_json::json!({}));
        configuration["bundle"]["resources"] = serde_json::json!([]);
        env::set_var("TAURI_CONFIG", configuration.to_string());
    }
    tauri_build::build();
}
