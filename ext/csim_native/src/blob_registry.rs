// The host side of the blob URL store (File API §8.3): what a window's contexts — its realms and its workers, each an
// isolate of its own or not — know of the blob URLs any of them made, so one resolves a URL another made and a revoke
// in any reaches them all. One registry for the process, by window (`window_new`): a URL's entry is the blob's bytes —
// none where no other context could resolve it, the entry then only the marker a revoke anywhere clears — its type, and
// the context that made it (a worker's `w:<handle>`, a realm's `r:<id>`), which revokes it as it goes; or a copy of a
// blob: document's, which the window's next page lets go of. The isolate's own store (blob_urls.rs) holds the blob.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard};

use crate::blob_urls::entry_key;
use crate::dom::register;

#[derive(Clone)]
struct Entry {
    bytes: Option<Vec<u8>>,
    ty: String,
    // (…none for a copy: a blob: document's, booted here)
    owner: Option<String>,
}

static REGISTRY: LazyLock<Mutex<HashMap<(u64, String), Entry>>> = LazyLock::new(Default::default);

fn lock() -> MutexGuard<'static, HashMap<(u64, String), Entry>> {
    REGISTRY.lock().unwrap_or_else(|e| e.into_inner())
}

// A new window's registry, the process's, never one a window before had.
pub(crate) fn window_new() -> u64 {
    static LAST: AtomicU64 = AtomicU64::new(0);
    LAST.fetch_add(1, Ordering::Relaxed) + 1
}
// …its every entry gone (the window reset or closed).
pub(crate) fn clear(window: u64) {
    lock().retain(|(w, _), _| *w != window);
}
// …the URL `url` named whole — its fragment and all (`revoked_key`'s, as the bindings key a revoke) — no more.
pub(crate) fn delete(window: u64, url: magnus::RString) {
    lock().remove(&(window, url_text(url)));
}
// …every URL the context `owner` made revoked, as it goes (a worker terminated, a realm's document gone) — those URLs.
pub(crate) fn revoke_owner(window: u64, owner: magnus::RString) -> Vec<String> {
    let owner = url_text(owner);
    let mut reg = lock();
    let urls: Vec<String> = reg.iter().filter(|((w, _), e)| *w == window && e.owner.as_deref() == Some(&owner)).map(|((_, u), _)| u.clone()).collect();
    for url in &urls {
        reg.remove(&(window, url.clone()));
    }
    urls
}
// …a blob: document's bytes and type, booted as the window's document: resolvable from it as it loads — its own
// fetches of itself — a copy, which the window's next page lets go of (`forget_copies`), whose owner's revoke, where
// a context of the window had made the URL, is not this document's.
pub(crate) fn copy(window: u64, url: magnus::RString, bytes: magnus::RString, ty: magnus::RString) {
    // SAFETY: copied at once, before anything could run Ruby code that moves or frees it.
    let bytes = unsafe { bytes.as_slice() }.to_vec();
    lock().insert((window, entry_key(&url_text(url))), Entry { bytes: Some(bytes), ty: url_text(ty), owner: None });
}
// …the copies let go of.
pub(crate) fn forget_copies(window: u64) {
    lock().retain(|(w, _), e| *w != window || e.owner.is_some());
}
// …what the URL resolves to, as the host reads it (a worker's script): its bytes — '' for an entry that holds none —
// or nil for none.
pub(crate) fn get_for_ruby(ruby: &magnus::Ruby, window: u64, url: magnus::RString) -> Option<magnus::RString> {
    let found = lock().get(&(window, entry_key(&url_text(url)))).map(|e| e.bytes.clone().unwrap_or_default())?;
    Some(ruby.str_from_slice(&found))
}

fn url_text(s: magnus::RString) -> String {
    // SAFETY: copied at once, before anything could run Ruby code that moves or frees it.
    String::from_utf8_lossy(unsafe { s.as_slice() }).into_owned()
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "blobRegistrySet", set_op, context_id);
    register(scope, ns, "blobRegistryGet", get_op, context_id);
}

// __dom.blobRegistrySet(window, url, bytes, type, owner): the blob URL `url` a context of window `window` made — its
// blob's bytes (null: none, the entry only its marker), its type, the context (`w:<handle>` / `r:<id>`) — entered,
// taking it over from any entry it had.
fn set_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(window) = args.get(0).integer_value(scope).and_then(|w| u64::try_from(w).ok()) else { return };
    let url = args.get(1).to_rust_string_lossy(scope);
    let bytes = (!args.get(2).is_null_or_undefined()).then(|| crate::blob_data::bytes_arg(scope, args.get(2)));
    let ty = args.get(3).to_rust_string_lossy(scope);
    let owner = Some(args.get(4).to_rust_string_lossy(scope));
    lock().insert((window, url), Entry { bytes, ty, owner });
}

// __dom.blobRegistryGet(window, url) -> what `url` resolves to (`entry_key`: its fragment excluded) in window
// `window`'s registry: `[bytes, type]` — bytes null where the entry holds none — or null for none (revoked, here or in
// another context, or never made).
fn get_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(window) = args.get(0).integer_value(scope).and_then(|w| u64::try_from(w).ok()) else { return rv.set_null() };
    let url = entry_key(&args.get(1).to_rust_string_lossy(scope));
    let Some(entry) = lock().get(&(window, url)).cloned() else { return rv.set_null() };
    let bytes = match entry.bytes {
        Some(bytes) => crate::blob_data::byte_array(scope, bytes),
        None => v8::null(scope).into(),
    };
    let ty = v8::String::new(scope, &entry.ty).map_or_else(|| v8::undefined(scope).into(), Into::into);
    rv.set(v8::Array::new_with_elements(scope, &[bytes, ty]).into());
}
