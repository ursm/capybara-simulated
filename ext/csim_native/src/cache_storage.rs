// Cache Storage (Service Workers §5.4-5.5): per storage key — a driver session's partition, and the origin key the
// bindings name (cache-storage.js `originKey`) — a name-to-cache map in creation order, each cache a list of
// request-response entries in stored order. One registry for the process, so every window and worker of a session reads
// the same caches, and a page reloaded finds what the last one stored. A cache outlives its name: a Cache object stays
// bound to the cache it opened after `delete()` unmaps the name, and the name opened again is a new cache.
//
// The requests' matching is cache_matching.rs's, over the entries as they are stored. What the bindings keep is the
// objects: the requests (each stored as the metadata they rebuild one from) and the responses (as their wire form),
// both opaque here.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

use crate::cache_matching::{query, Entry};
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
struct Shed {
    last_cache: u32,
    names: Vec<(Vec<u16>, u32)>,
    caches: HashMap<u32, Cache>,
}

static REGISTRY: LazyLock<Mutex<HashMap<(u64, String), Shed>>> = LazyLock::new(Default::default);

fn lock() -> MutexGuard<'static, HashMap<(u64, String), Shed>> {
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
    register(scope, ns, "cachePut", put_op, context_id);
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
    let shed = reg.entry(key).or_default();
    let id = match shed.names.iter().find(|(n, _)| *n == name) {
        Some(&(_, id)) => id,
        None => {
            shed.last_cache += 1;
            let id = shed.last_cache;
            shed.names.push((name, id));
            shed.caches.insert(id, Cache::default());
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
    let Some(shed) = reg.get_mut(&key) else { return rv.set_bool(false) };
    let before = shed.names.len();
    shed.names.retain(|(n, _)| *n != name);
    rv.set_bool(shed.names.len() != before);
}

// __dom.cacheNames(partition, origin) -> the names mapped, in the order each was created.
fn names_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = key(scope, &args);
    let names: Vec<Vec<u16>> = lock().get(&key).map(|s| s.names.iter().map(|(n, _)| n.clone()).collect()).unwrap_or_default();
    let items: Vec<v8::Local<v8::Value>> = names.iter().map(|n| utf16_value(scope, n)).collect();
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

// __dom.cachePut(partition, origin, cache, url, headers, vary, meta, response): Batch Cache Operations' "put" of one
// entry — the request of `url` and `headers` whose response's `Vary` is `vary`, stored as `meta` and `response` — in
// place of every entry its request matches.
fn put_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let key = key(scope, &args);
    let id = u32_arg(scope, &args, 2);
    let url = args.get(3).to_rust_string_lossy(scope);
    let headers = crate::cache_matching::headers(scope, args.get(4));
    let vary = args.get(5).to_rust_string_lossy(scope);
    let (meta, response) = (args.get(6).to_rust_string_lossy(scope), args.get(7).to_rust_string_lossy(scope));
    let mut reg = lock();
    let Some(cache) = reg.get_mut(&key).and_then(|s| s.caches.get_mut(&id)) else { return };
    let replaced = query(&url, &headers, false, false, &cache.entries);
    let mut at = 0;
    cache.entries.retain(|_| {
        at += 1;
        !replaced.contains(&(at - 1))
    });
    cache.last_entry += 1;
    let entry = Stored { id: cache.last_entry, request: Entry::new(url, headers, vary), meta, response };
    cache.entries.push(entry);
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
