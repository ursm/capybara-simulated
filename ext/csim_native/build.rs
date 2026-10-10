// The native extension's one piece of C++: `src/v8_shim.cc`, over V8 inline APIs rusty_v8 does not bind — a DROPPABLE
// TracedReference, and the EmbedderRootsHandler that clears one when V8 drops the object it held (node_handle.rs). It
// compiles against the headers of the v8 crate's own V8 (the crate's source carries them): its version is the one
// Cargo.toml pins, found in Cargo's registry — or wherever `CSIM_V8_INCLUDE` says (a vendored or offline build).
const V8_VERSION: &str = "150.4.0";

fn v8_include() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("CSIM_V8_INCLUDE") {
        return dir.into();
    }
    let home = std::env::var("CARGO_HOME").map(std::path::PathBuf::from).unwrap_or_else(|_| {
        std::path::Path::new(&std::env::var("HOME").expect("HOME or CARGO_HOME")).join(".cargo")
    });
    let registry = home.join("registry/src");
    std::fs::read_dir(&registry)
        .into_iter()
        .flatten()
        .flatten()
        .map(|index| index.path().join(format!("v8-{V8_VERSION}/v8/include")))
        .find(|dir| dir.join("v8-traced-handle.h").exists())
        .unwrap_or_else(|| panic!("the v8 {V8_VERSION} crate's headers are not under {}: set CSIM_V8_INCLUDE", registry.display()))
}

fn main() {
    println!("cargo:rerun-if-changed=src/v8_shim.cc");
    println!("cargo:rerun-if-env-changed=CSIM_V8_INCLUDE");
    cc::Build::new()
        .cpp(true)
        .std("c++20")
        .include(v8_include())
        .file("src/v8_shim.cc")
        .flag_if_supported("-Wno-unused-parameter")
        .compile("csim_v8_shim");
}
