// The host side of the blob URL store (File API §8.3): what a window's contexts — its realms and its workers, each an
// isolate of its own or not — know of the blob URLs any of them made, so one resolves a URL another made and a revoke
// in any reaches them all. One registry for the process, by window (`window_new`): a URL's entry is the blob's bytes —
// none where no other context could resolve it yet, the entry then only the marker a revoke anywhere clears, its bytes
// filled in as one comes to (a worker made: `markers` / `fill`) — its type, and the context that made it (a worker's
// `w:<handle>`, a realm's `r:<id>`), which revokes it as it goes, and its storage partition — its maker's top-level
// site, from which alone another window resolves or revokes it (`partition`, `revoke_partitioned`); or a copy of a blob:
// document's, which the window's next page lets go of. The isolate's own store (blob_urls.rs) holds the blob.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use crate::blob_urls::entry_key;
use crate::dom::register;

struct Entry {
    bytes: Option<Arc<[u8]>>,
    ty: String,
    // (…none for a copy: a blob: document's, booted here)
    owner: Option<String>,
    // (…none for a copy too, which keeps the partition of the URL it copies — or until the host says it: `set_site`)
    site: Option<String>,
}

type Windows = HashMap<u64, HashMap<String, Entry>>;
static REGISTRY: LazyLock<Mutex<Windows>> = LazyLock::new(Default::default);

fn lock() -> MutexGuard<'static, Windows> {
    REGISTRY.lock().unwrap_or_else(|e| e.into_inner())
}

// A new window's registry, the process's, never one a window before had.
pub(crate) fn window_new() -> u64 {
    static LAST: AtomicU64 = AtomicU64::new(0);
    LAST.fetch_add(1, Ordering::Relaxed) + 1
}
// …its every entry gone (the window reset or disposed).
pub(crate) fn clear(window: u64) {
    lock().remove(&window);
}
// …the URL `url` named whole — its fragment and all (`revoked_key`'s, as the bindings key a revoke) — no more.
pub(crate) fn delete(window: u64, url: magnus::RString) {
    let url = url_text(url);
    if let Some(entries) = lock().get_mut(&window) {
        entries.remove(&url);
    }
}
// …every URL the context `owner` made revoked, as it goes (a worker terminated, a realm's document gone) — those URLs.
pub(crate) fn revoke_owner(window: u64, owner: magnus::RString) -> Vec<String> {
    let owner = url_text(owner);
    let mut reg = lock();
    let Some(entries) = reg.get_mut(&window) else { return Vec::new() };
    let urls: Vec<String> = entries.iter().filter(|(_, e)| e.owner.as_deref() == Some(&owner)).map(|(u, _)| u.clone()).collect();
    for url in &urls {
        entries.remove(url);
    }
    urls
}
// …a blob: document's bytes and type, booted as the window's document: resolvable from it as it loads — its own
// fetches of itself — a copy, which the window's next page lets go of (`forget_copies`), whose owner's revoke, where
// a context of the window had made the URL, is not this document's.
pub(crate) fn copy(window: u64, url: magnus::RString, bytes: magnus::RString, ty: magnus::RString) {
    // SAFETY: copied at once, before anything could run Ruby code that moves or frees it.
    let bytes: Arc<[u8]> = unsafe { bytes.as_slice() }.into();
    let (url, ty) = (entry_key(&url_text(url)), url_text(ty));
    lock().entry(window).or_default().insert(url, Entry { bytes: Some(bytes), ty, owner: None, site: None });
}
// …the copies let go of.
pub(crate) fn forget_copies(window: u64) {
    if let Some(entries) = lock().get_mut(&window) {
        entries.retain(|_, e| e.owner.is_some());
    }
}
// …what the URL resolves to, as the host reads it (a worker's script): its bytes — '' for an entry that holds none —
// or nil for none.
pub(crate) fn get_for_ruby(ruby: &magnus::Ruby, window: u64, url: magnus::RString) -> Option<magnus::RString> {
    let url = entry_key(&url_text(url));
    let found = lock().get(&window)?.get(&url).map(|e| e.bytes.clone())?;
    Some(ruby.str_from_slice(found.as_deref().unwrap_or_default()))
}

// …the storage partition of the URL `url` a context of window `window` made: `site`, its top-level site as it was made.
pub(crate) fn set_site(window: u64, url: magnus::RString, site: magnus::RString) {
    let (url, site) = (url_text(url), url_text(site));
    if let Some(entry) = lock().get_mut(&window).and_then(|e| e.get_mut(&url)) {
        entry.site = Some(site);
    }
}
// …the window whose context made the URL `url` resolves to (`entry_key`: its fragment aside) and its storage partition,
// whichever window that is — or nil for none (revoked, never made, or a copy alone).
pub(crate) fn partition(url: magnus::RString) -> Option<(u64, String)> {
    let url = entry_key(&url_text(url));
    lock().iter().find_map(|(&window, entries)| entries.get(&url).and_then(|e| e.site.clone()).map(|site| (window, site)))
}
// …`url` (named whole, as a revoke names it) revoked from a context whose top-level site is `site`: refused where
// another partition's context made it — nil (cross-partition.https: "shouldn't be revocable from a cross-partition
// iframe/worker") — else its entry gone from the window whose context made it, which it answers, its own isolate's copy
// that window's to drop; 0 where no window's context made it.
pub(crate) fn revoke_partitioned(url: magnus::RString, site: magnus::RString) -> Option<u64> {
    let (url, site) = (url_text(url), url_text(site));
    let mut reg = lock();
    let Some((&window, entries)) = reg.iter_mut().find(|(_, e)| e.get(&url).is_some_and(|e| e.site.is_some())) else { return Some(0) };
    if entries.get(&url).and_then(|e| e.site.as_deref()) != Some(site.as_str()) {
        return None;
    }
    entries.remove(&url);
    Some(window)
}

fn url_text(s: magnus::RString) -> String {
    // SAFETY: copied at once, before anything could run Ruby code that moves or frees it.
    String::from_utf8_lossy(unsafe { s.as_slice() }).into_owned()
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "blobRegistrySet", set_op, context_id);
    register(scope, ns, "blobRegistryHas", has_op, context_id);
    register(scope, ns, "blobRegistryGet", get_op, context_id);
    register(scope, ns, "blobRegistryMarkers", markers_op, context_id);
    register(scope, ns, "blobRegistryFill", fill_op, context_id);
}

fn window_arg(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> Option<u64> {
    args.get(0).integer_value(scope).and_then(|w| u64::try_from(w).ok())
}

// __dom.blobRegistrySet(window, url, bytes, type, owner): the blob URL `url` a context of window `window` made — its
// blob's bytes (null: none, the entry only its marker), its type, the context (`w:<handle>` / `r:<id>`) — entered,
// taking it over from any entry it had.
fn set_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(window) = window_arg(scope, &args) else { return };
    let url = args.get(1).to_rust_string_lossy(scope);
    let bytes = (!args.get(2).is_null_or_undefined()).then(|| crate::blob_data::bytes_arg(scope, args.get(2)).into());
    let ty = args.get(3).to_rust_string_lossy(scope);
    let owner = Some(args.get(4).to_rust_string_lossy(scope));
    lock().entry(window).or_default().insert(url, Entry { bytes, ty, owner, site: None });
}

// __dom.blobRegistryHas(window, url) -> whether `url` (`entry_key`: its fragment excluded) resolves in window
// `window`'s registry — not revoked, here or in another context.
fn has_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(window) = window_arg(scope, &args) else { return rv.set_bool(false) };
    let url = entry_key(&args.get(1).to_rust_string_lossy(scope));
    rv.set_bool(lock().get(&window).is_some_and(|e| e.contains_key(&url)));
}

// __dom.blobRegistryGet(window, url) -> what `url` resolves to there: `[bytes, type]` — bytes null where the entry holds
// none — or null for none (revoked, here or in another context, or never made).
fn get_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(window) = window_arg(scope, &args) else { return rv.set_null() };
    let url = entry_key(&args.get(1).to_rust_string_lossy(scope));
    let Some((bytes, ty)) = lock().get(&window).and_then(|e| e.get(&url)).map(|e| (e.bytes.clone(), e.ty.clone())) else {
        return rv.set_null();
    };
    let bytes = match bytes {
        Some(bytes) => crate::blob_data::byte_array(scope, bytes.to_vec()),
        None => v8::null(scope).into(),
    };
    let ty = v8::String::new(scope, &ty).map_or_else(|| v8::undefined(scope).into(), Into::into);
    rv.set(v8::Array::new_with_elements(scope, &[bytes, ty]).into());
}

// __dom.blobRegistryMarkers(window) -> the URLs of window `window`'s registry whose entries hold no bytes: made before
// any other context could resolve them, which one now may (a worker made).
fn markers_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(window) = window_arg(scope, &args) else { return };
    let urls: Vec<String> = lock().get(&window).map(|e| e.iter().filter(|(_, e)| e.bytes.is_none()).map(|(u, _)| u.clone()).collect()).unwrap_or_default();
    let items: Vec<v8::Local<v8::Value>> = urls.iter().filter_map(|u| v8::String::new(scope, u)).map(Into::into).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.blobRegistryFill(window, url, bytes): the marker `url` names in window `window`'s registry given its blob's
// bytes — its type and its owner as they are; nothing where it is no marker any more.
fn fill_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(window) = window_arg(scope, &args) else { return };
    let url = args.get(1).to_rust_string_lossy(scope);
    let bytes: Arc<[u8]> = crate::blob_data::bytes_arg(scope, args.get(2)).into();
    if let Some(entry) = lock().get_mut(&window).and_then(|e| e.get_mut(&url)).filter(|e| e.bytes.is_none()) {
        entry.bytes = Some(bytes);
    }
}
