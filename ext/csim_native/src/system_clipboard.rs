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
    register(scope, ns, "clipboardWriteSelected", write_selected_op, context_id);
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

// What a paste event's `clipboardData.files` holds of a representation held under `key`: the one binary a page can write
// (§6.4) a File named by its kind and extension — none for text, markup (text/html, text/uri-list, image/svg+xml: Chrome),
// a web custom format, which no paste event sees, or a string a copy event's page set under a type of its own.
fn file_name(key: &str) -> Option<String> {
    (key == "image/png").then(|| "image.png".to_owned())
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
    write(partition, entries);
}

// __dom.clipboardWriteSelected(partition, text, html): the selected contents of a page copied (Clipboard API §8.1:
// "alternate text/html and text/plain clipboard formats") — a flavor that is empty not held, and nothing selected at
// all leaving the clipboard as it was, as Chrome and Firefox leave it.
fn write_selected_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let partition = partition(scope, &args);
    let (text, html) = (args.get(1).to_rust_string_lossy(scope), args.get(2).to_rust_string_lossy(scope));
    write_selected(partition, &text, &html);
}
pub(crate) fn write_selected(partition: u64, text: &str, html: &str) {
    let entries: Vec<(String, Vec<u8>)> = [("text/plain", text), ("text/html", html)]
        .into_iter()
        .filter(|(_, flavor)| !flavor.is_empty())
        .map(|(ty, flavor)| (ty.to_owned(), flavor.as_bytes().to_vec()))
        .collect();
    if !entries.is_empty() {
        write(partition, entries);
    }
}

// The session's clipboard holds `entries` from now on, its change count moved on.
pub(crate) fn write(partition: u64, entries: Vec<(String, Vec<u8>)>) {
    // (…its count taken under the lock, so a later write of one session's never holds a smaller one)
    let mut reg = lock();
    let count = LAST_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
    reg.insert(partition, Clipboard { entries, count });
}
// …less the representations of `types`, its change count moved on.
pub(crate) fn remove_types(partition: u64, types: &[String]) {
    let entries = lock().get(&partition).map_or_else(Vec::new, |c| c.entries.clone());
    write(partition, entries.into_iter().filter(|(ty, _)| !types.contains(ty)).collect());
}
// What the session's clipboard holds as text of a type, UTF-8 decoded: what a paste inserts.
pub(crate) fn text_of(partition: u64, ty: &str) -> Vec<u16> {
    let reg = lock();
    let held = reg.get(&partition).and_then(|c| c.entries.iter().find(|(key, _)| key == ty));
    held.map_or_else(Vec::new, |(_, bytes)| String::from_utf8_lossy(bytes).encode_utf16().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_selection_writes_the_flavors_it_has() {
        let partition = 0x5e1ec7;
        write_selected(partition, "", "");
        assert!(lock().get(&partition).is_none());
        write_selected(partition, "t", "");
        assert_eq!(lock().get(&partition).map(|c| c.entries.len()), Some(1));
        assert_eq!(text_of(partition, "text/plain"), "t".encode_utf16().collect::<Vec<u16>>());
        // (…nothing selected leaves the clipboard as it was)
        let count = lock().get(&partition).map(|c| c.count);
        write_selected(partition, "", "");
        assert_eq!(lock().get(&partition).map(|c| c.count), count);
        write_selected(partition, "t", "<b>t</b>");
        assert_eq!(lock().get(&partition).map(|c| c.entries.iter().map(|(ty, _)| ty.clone()).collect::<Vec<_>>()), Some(vec!["text/plain".to_owned(), "text/html".to_owned()]));
        remove_types(partition, &["text/plain".to_owned()]);
        assert_eq!(text_of(partition, "text/plain"), Vec::<u16>::new());
        assert_eq!(lock().get(&partition).map(|c| c.entries.len()), Some(1));
        clear(partition);
    }

    #[test]
    fn only_a_binary_is_a_file() {
        assert_eq!(file_name("image/png").as_deref(), Some("image.png"));
        for key in ["text/plain", "text/html", "image/svg+xml", "web text/custom", "application/x-trix-document"] {
            assert_eq!(file_name(key), None);
        }
    }
}
