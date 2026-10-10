// The native extension's one piece of C++: `src/v8_shim.cc`, over V8 inline APIs rusty_v8 does not bind — a DROPPABLE
// TracedReference, and the EmbedderRootsHandler that clears one when V8 drops the object it held (node_handle.rs). It
// compiles against the headers of the v8 crate the build resolved (its source carries them), found through
// `cargo metadata` — the registry, a vendored or git or patched source alike — or where `CSIM_V8_INCLUDE` says. The
// shim's inline code is V8's as the crate builds it: without pointer compression or the sandbox, which change what
// `Object::Unwrap` and a handle's layout are — a v8 feature turning either on refuses to build rather than miscompile.

use std::path::PathBuf;
use std::process::Command;

// The v8 crate's include directory, and the features it is built with.
fn resolved_v8() -> (PathBuf, Vec<String>) {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let out = Command::new(cargo)
        .args(["metadata", "--format-version", "1", "--manifest-path"])
        .arg(&manifest)
        .output()
        .expect("cargo metadata");
    assert!(out.status.success(), "cargo metadata: {}", String::from_utf8_lossy(&out.stderr));
    let meta: serde_json::Value = serde_json::from_slice(&out.stdout).expect("cargo metadata's JSON");
    let packages = meta["packages"].as_array().expect("packages");
    let v8 = packages.iter().find(|p| p["name"] == "v8").expect("the v8 crate among the build's packages");
    let id = &v8["id"];
    let manifest_path = PathBuf::from(v8["manifest_path"].as_str().expect("v8's manifest path"));
    let features = meta["resolve"]["nodes"]
        .as_array()
        .and_then(|nodes| nodes.iter().find(|n| &n["id"] == id))
        .and_then(|n| n["features"].as_array())
        .map(|f| f.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    (manifest_path.parent().expect("v8's crate directory").join("v8/include"), features)
}

fn main() {
    println!("cargo:rerun-if-changed=src/v8_shim.cc");
    println!("cargo:rerun-if-env-changed=CSIM_V8_INCLUDE");
    let include = match std::env::var("CSIM_V8_INCLUDE") {
        Ok(dir) => PathBuf::from(dir),
        Err(_) => {
            let (include, features) = resolved_v8();
            for refused in ["v8_enable_pointer_compression", "v8_enable_sandbox"] {
                assert!(!features.iter().any(|f| f == refused), "src/v8_shim.cc is not built for the v8 crate's `{refused}`");
            }
            include
        }
    };
    assert!(include.join("v8-traced-handle.h").exists(), "V8's headers are not in {}: set CSIM_V8_INCLUDE", include.display());
    cc::Build::new()
        .cpp(true)
        .std("c++20")
        .include(include)
        .file("src/v8_shim.cc")
        .flag_if_supported("-Wno-unused-parameter")
        .compile("csim_v8_shim");
}
