// The system clipboard (Clipboard API and events): one for a driver session — every window's and frame's, kept across
// visits until the session's storage is cleared — holding one item, its representations each a type (an essence, or a
// web custom format's "web " and its essence) and its bytes, and a change count that moves with every write, which a
// ClipboardItem read from it compares at getType() and a realm's Blobs of it are kept against (clipboard.js). One
// registry for the process, by the session's partition (lib.rs `session_partition_new`). The counts are the process's:
// one a session's clipboard had is never another's, nor the same session's after a clear.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard};

use crate::dom::register;

#[derive(Default)]
struct Clipboard {
    entries: Vec<(String, Vec<u8>)>,
    count: u32,
}

static REGISTRY: LazyLock<Mutex<HashMap<u64, Clipboard>>> = LazyLock::new(Default::default);
static LAST_COUNT: AtomicU32 = AtomicU32::new(0);

fn lock() -> MutexGuard<'static, HashMap<u64, Clipboard>> {
    REGISTRY.lock().unwrap_or_else(|e| e.into_inner())
}

// A session's clipboard emptied (its storage cleared).
pub(crate) fn clear(partition: u64) {
    lock().remove(&partition);
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "clipboardCount", count_op, context_id);
    register(scope, ns, "clipboardRead", read_op, context_id);
    register(scope, ns, "clipboardWrite", write_op, context_id);
    register(scope, ns, "clipboardKey", key_op, context_id);
    register(scope, ns, "clipboardFiles", files_op, context_id);
}

// The data types a page may write and read (§6.4, §6.5): the mandatory ones, and the optional ones this clipboard
// recognises — text/uri-list, image/svg+xml, and a web custom format ("web " and a MIME type) — by a type's essence, as
// writeText's own "text/plain;charset=utf-8" Blob has it.
const KNOWN_TYPES: [&str; 5] = ["text/plain", "text/html", "image/png", "text/uri-list", "image/svg+xml"];
const WEB: &str = "web ";

// The key a representation of `ty` is held under: its essence, or "web " and its essence — none for one no page may
// write.
fn key(ty: &str) -> Option<String> {
    let custom = ty.strip_prefix(WEB);
    let mime = crate::mime::parse(custom.unwrap_or(ty))?;
    match custom {
        Some(_) => Some(format!("{WEB}{}", mime.essence)),
        None => KNOWN_TYPES.contains(&mime.essence.as_str()).then_some(mime.essence),
    }
}

// What a paste event's `clipboardData.files` holds of a representation held under `key`: a File named by its kind and
// extension ("image.png") — none for text, markup (text/html, text/uri-list, image/svg+xml: Chrome) or a web custom
// format, which no paste event sees.
fn file_name(key: &str) -> Option<String> {
    if key.starts_with(WEB) || matches!(key, "text/plain" | "text/html" | "text/uri-list" | "image/svg+xml") {
        return None;
    }
    let ext = match key {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "application/pdf" => "pdf",
        "application/zip" => "zip",
        "audio/mpeg" => "mp3",
        "audio/wav" => "wav",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        _ => "bin",
    };
    let kind = key.split('/').next().filter(|k| !k.is_empty()).unwrap_or("file");
    Some(format!("{kind}.{ext}"))
}

fn partition(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> u64 {
    args.get(0).integer_value(scope).unwrap_or(0) as u64
}

// __dom.clipboardCount(partition) -> the change count of the session's clipboard (0 for one never written).
fn count_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let partition = partition(scope, &args);
    rv.set_uint32(lock().get(&partition).map_or(0, |c| c.count));
}

// __dom.clipboardRead(partition) -> `[count, type, bytes, …]`: the change count and each representation, its bytes a
// Uint8Array.
fn read_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let partition = partition(scope, &args);
    let (count, entries) = lock().get(&partition).map_or((0, Vec::new()), |c| (c.count, c.entries.clone()));
    let mut items: Vec<v8::Local<v8::Value>> = vec![v8::Integer::new_from_unsigned(scope, count).into()];
    for (ty, bytes) in entries {
        let Some(ty) = v8::String::new(scope, &ty) else { continue };
        items.push(ty.into());
        items.push(crate::dom::u8_array(scope, bytes));
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.clipboardKey(type) -> the key a representation of `type` is held under, or null for a type no page may write.
fn key_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let ty = args.get(0).to_rust_string_lossy(scope);
    match key(&ty).and_then(|k| v8::String::new(scope, &k)) {
        Some(k) => rv.set(k.into()),
        None => rv.set_null(),
    }
}

// __dom.clipboardFiles(partition) -> `[type, name, …]`: the session's clipboard's representations a paste event hands
// over as Files, in order, each its type and the name its File takes.
fn files_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let partition = partition(scope, &args);
    let files: Vec<String> = lock()
        .get(&partition)
        .map(|c| c.entries.iter().filter_map(|(ty, _)| Some([ty.clone(), file_name(ty)?])).flatten().collect())
        .unwrap_or_default();
    let items: Vec<v8::Local<v8::Value>> = files.iter().filter_map(|s| v8::String::new(scope, s)).map(Into::into).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.clipboardWrite(partition, entries): the session's clipboard holds `entries` — `[type, bytes, …]`, each's bytes a
// blob's (blob_data.rs `bytes_arg`) — from now on, its change count moved on.
fn write_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let partition = partition(scope, &args);
    let mut entries = Vec::new();
    if let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(1)) {
        let mut k = 0;
        while k + 1 < list.length() {
            let ty = list.get_index(scope, k).map(|v| v.to_rust_string_lossy(scope)).unwrap_or_default();
            let bytes = list.get_index(scope, k + 1).map_or_else(Vec::new, |v| crate::blob_data::bytes_arg(scope, v));
            entries.push((ty, bytes));
            k += 2;
        }
    }
    // (…its count taken under the lock, so a later write of one session's never holds a smaller one)
    let mut reg = lock();
    let count = LAST_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
    reg.insert(partition, Clipboard { entries, count });
}
