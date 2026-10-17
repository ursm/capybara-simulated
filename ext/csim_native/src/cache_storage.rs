// Cache Storage (Service Workers §5.4-5.5): per storage key — a driver session's partition, and the origin key the
// bindings name (cache-storage.js `originKey`) — a name-to-cache map in creation order, each cache a list of
// request-response entries in stored order. One registry for the process, so every window and worker of a session reads
// the same caches, and a page reloaded finds what the last one stored. A cache outlives its name: a Cache object stays
// bound to the cache it opened after `delete()` unmaps the name, and the name opened again is a new cache — so a cache
// unmapped stays until its session's storage is cleared (no Cache object's lifetime is tracked here: a bounded leak, of
// one session), and cache numbers are the process's, never one a cache of a session before had.
//
// The requests' matching is cache_matching.rs's, over the entries as they are stored. What the bindings keep is the
// objects: the requests (each stored as the metadata they rebuild one from) and the responses (as their wire form),
// both opaque here.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard};

use crate::cache_matching::{has_duplicate, query, Entry};
use crate::dom::{register, utf16_arg, utf16_value};

// A stored entry: its number, the request as the matcher reads it, the request's metadata and the response's wire form
// as the bindings gave them.
struct Stored {
    id: u32,
    request: Entry,
    meta: String,
    response: String,
}
impl AsRef<Entry> for Stored {
    fn as_ref(&self) -> &Entry {
        &self.request
    }
}

#[derive(Default)]
struct Cache {
    last_entry: u32,
    entries: Vec<Stored>,
}

// A storage key's caches: the names mapped (DOMStrings, a lone surrogate kept), in the order each was created, and
// every cache by its number, mapped or not.
#[derive(Default)]
struct StorageKeyCaches {
    names: Vec<(Vec<u16>, u32)>,
    caches: HashMap<u32, Cache>,
}

static REGISTRY: LazyLock<Mutex<HashMap<(u64, String), StorageKeyCaches>>> = LazyLock::new(Default::default);
static LAST_CACHE: AtomicU32 = AtomicU32::new(0);

fn lock() -> MutexGuard<'static, HashMap<(u64, String), StorageKeyCaches>> {
    REGISTRY.lock().unwrap_or_else(|e| e.into_inner())
}

// A session's caches deleted (its storage cleared).
pub(crate) fn clear(partition: u64) {
    lock().retain(|(p, _), _| *p != partition);
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "cacheOpen", open_op, context_id);
    register(scope, ns, "cacheHas", has_op, context_id);
    register(scope, ns, "cacheDelete", delete_op, context_id);
    register(scope, ns, "cacheNames", names_op, context_id);
    register(scope, ns, "cacheSelect", select_op, context_id);
    register(scope, ns, "cacheResponse", response_op, context_id);
    register(scope, ns, "cachePutAll", put_all_op, context_id);
    register(scope, ns, "cacheRemove", remove_op, context_id);
}

// The storage key the first two arguments name: the session's partition and the origin key.
fn key(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> (u64, String) {
    (args.get(0).integer_value(scope).unwrap_or(0) as u64, args.get(1).to_rust_string_lossy(scope))
}
fn u32_arg(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, i: i32) -> u32 {
    args.get(i).uint32_value(scope).unwrap_or(0)
}

// __dom.cacheOpen(partition, origin, name) -> the number of the cache `name` maps to — a new one where it maps none.
fn open_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = key(scope, &args);
    let name = utf16_arg(scope, args.get(2));
    let mut reg = lock();
    let caches = reg.entry(key).or_default();
    let id = match caches.names.iter().find(|(n, _)| *n == name) {
        Some(&(_, id)) => id,
        None => {
            let id = LAST_CACHE.fetch_add(1, Ordering::Relaxed) + 1;
            caches.names.push((name, id));
            caches.caches.insert(id, Cache::default());
            id
        }
    };
    rv.set_uint32(id);
}

// __dom.cacheHas(partition, origin, name) -> whether `name` maps a cache.
fn has_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = key(scope, &args);
    let name = utf16_arg(scope, args.get(2));
    rv.set_bool(lock().get(&key).is_some_and(|s| s.names.iter().any(|(n, _)| *n == name)));
}

// __dom.cacheDelete(partition, origin, name) -> whether `name` mapped a cache, which it maps no more (the cache stays
// for the Cache objects bound to it).
fn delete_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = key(scope, &args);
    let name = utf16_arg(scope, args.get(2));
    let mut reg = lock();
    let Some(caches) = reg.get_mut(&key) else { return rv.set_bool(false) };
    let before = caches.names.len();
    caches.names.retain(|(n, _)| *n != name);
    rv.set_bool(caches.names.len() != before);
}

// __dom.cacheNames(partition, origin) -> `[name, cache, …]`: the names mapped, in the order each was created, each with
// the number of the cache it maps.
fn names_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = key(scope, &args);
    let names: Vec<(Vec<u16>, u32)> = lock().get(&key).map(|c| c.names.clone()).unwrap_or_default();
    let mut items: Vec<v8::Local<v8::Value>> = Vec::with_capacity(names.len() * 2);
    for (name, id) in &names {
        items.push(utf16_value(scope, name));
        items.push(v8::Integer::new_from_unsigned(scope, *id).into());
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.cacheSelect(partition, origin, cache, url, headers, method, ignoreSearch, ignoreVary, ignoreMethod) ->
// `[entry, meta, …]`: the entries of `cache` a request of `url`, `headers` (a flat `[name, value, …]` list, names
// lowercased) and `method` selects ("Query Cache", in stored order) — every entry where `url` is undefined (matchAll and
// keys allow no request), none for a request that is not a GET unless `ignoreMethod`, and none of a cache that is gone.
fn select_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = key(scope, &args);
    let id = u32_arg(scope, &args, 2);
    let request = if args.get(3).is_undefined() {
        None
    } else {
        let url = args.get(3).to_rust_string_lossy(scope);
        let headers = crate::cache_matching::headers(scope, args.get(4));
        let method = args.get(5).to_rust_string_lossy(scope);
        Some((url, headers, method))
    };
    let (ignore_search, ignore_vary, ignore_method) = (args.get(6).is_true(), args.get(7).is_true(), args.get(8).is_true());
    let selected: Vec<(u32, String)> = {
        let reg = lock();
        let Some(cache) = reg.get(&key).and_then(|s| s.caches.get(&id)) else { return rv.set(v8::Array::new(scope, 0).into()) };
        match &request {
            None => cache.entries.iter().map(|e| (e.id, e.meta.clone())).collect(),
            Some((_, _, method)) if method != "GET" && !ignore_method => Vec::new(),
            Some((url, headers, _)) => query(url, headers, ignore_search, ignore_vary, &cache.entries)
                .into_iter()
                .map(|i| (cache.entries[i].id, cache.entries[i].meta.clone()))
                .collect(),
        }
    };
    let mut items: Vec<v8::Local<v8::Value>> = Vec::with_capacity(selected.len() * 2);
    for (entry, meta) in &selected {
        let Some(meta) = v8::String::new(scope, meta) else { continue };
        items.push(v8::Integer::new_from_unsigned(scope, *entry).into());
        items.push(meta.into());
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.cacheResponse(partition, origin, cache, entry) -> the response the entry stores (its wire form), or null where it
// is gone.
fn response_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = key(scope, &args);
    let (id, entry) = (u32_arg(scope, &args, 2), u32_arg(scope, &args, 3));
    let response = lock().get(&key).and_then(|s| s.caches.get(&id)).and_then(|c| c.entries.iter().find(|e| e.id == entry)).map(|e| e.response.clone());
    match response.and_then(|r| v8::String::new(scope, &r)) {
        Some(r) => rv.set(r.into()),
        None => rv.set_null(),
    }
}

// __dom.cachePutAll(partition, origin, cache, items) -> whether the batch was stored: Batch Cache Operations' "put" of
// every item — each `[url, headers, vary, meta, response]`, the request of `url` and `headers` (a flat list, names
// lowercased) whose response's `Vary` is `vary`, stored as `meta` and `response` — each in place of every entry its
// request matches, all at once (no other realm sees half of it); none where two of them are one request
// (`has_duplicate`: an InvalidStateError, the bindings').
fn put_all_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = key(scope, &args);
    let id = u32_arg(scope, &args, 2);
    let mut batch = Vec::new();
    if let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(3)) {
        for i in 0..list.length() {
            let Some(item) = list.get_index(scope, i).and_then(|v| v8::Local::<v8::Array>::try_from(v).ok()) else { continue };
            let field = |k: u32| item.get_index(scope, k).map(|v| v.to_rust_string_lossy(scope)).unwrap_or_default();
            let (url, vary, meta, response) = (field(0), field(2), field(3), field(4));
            let headers = item.get_index(scope, 1).map(|h| crate::cache_matching::headers(scope, h)).unwrap_or_default();
            batch.push(Stored { id: 0, request: Entry::new(url, headers, vary), meta, response });
        }
    }
    if has_duplicate(&batch) {
        return rv.set_bool(false);
    }
    let mut reg = lock();
    let Some(cache) = reg.get_mut(&key).and_then(|c| c.caches.get_mut(&id)) else { return rv.set_bool(true) };
    for mut stored in batch {
        let replaced = query(stored.request.url(), stored.request.headers(), false, false, &cache.entries);
        let mut at = 0;
        cache.entries.retain(|_| {
            at += 1;
            !replaced.contains(&(at - 1))
        });
        cache.last_entry += 1;
        stored.id = cache.last_entry;
        cache.entries.push(stored);
    }
    rv.set_bool(true);
}

// __dom.cacheRemove(partition, origin, cache, entries) -> how many of `entries` (their numbers) the cache held, which it
// holds no more.
fn remove_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = key(scope, &args);
    let id = u32_arg(scope, &args, 2);
    let gone: Vec<u32> = match v8::Local::<v8::Array>::try_from(args.get(3)) {
        Ok(list) => (0..list.length()).filter_map(|i| list.get_index(scope, i)?.uint32_value(scope)).collect(),
        Err(_) => Vec::new(),
    };
    let mut reg = lock();
    let Some(cache) = reg.get_mut(&key).and_then(|s| s.caches.get_mut(&id)) else { return rv.set_uint32(0) };
    let before = cache.entries.len();
    cache.entries.retain(|e| !gone.contains(&e.id));
    rv.set_uint32((before - cache.entries.len()) as u32);
}
