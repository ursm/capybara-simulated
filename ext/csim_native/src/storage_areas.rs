// Web Storage's areas (HTML §12.2): a storage shed per partition — a session's for `localStorage`, which every window
// of the session shares, a top-level browsing context's for `sessionStorage` — of one area per storage key: the origin,
// and the site of the top-level document it is under (the storage partitioning Chrome and Firefox ship: a third-party
// frame's area is not the one the same origin has as a first party, privacycg/storage-partitioning) — each an ordered
// list of key-value pairs of DOMStrings (UTF-16, a lone surrogate kept). The host makes the partitions and clears them;
// the bindings read and write an area through the realm whose global's area it is, by that realm's document's origin.
// The `storage` events are the bindings' and the host's (storage.js, `storage_changed`).

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

use crate::dom::{realm_id, register, utf16_arg, utf16_value};

// What an area may hold, in code units of its keys and values together — Chrome and Firefox both cap an area at ~5 MiB
// (the WPT quota tests `setItem` in a loop until QuotaExceededError).
const QUOTA_UNITS: usize = 5 * 1024 * 1024;

// An area: its items in the order each key was first set, with each key's place among them, and the code units they hold.
#[derive(Default)]
struct Area {
    items: Vec<(Vec<u16>, Vec<u16>)>,
    places: HashMap<Vec<u16>, usize>,
    units: usize,
}
impl Area {
    fn position(&self, key: &[u16]) -> Option<usize> {
        self.places.get(key).copied()
    }
    fn remove(&mut self, key: &[u16]) -> Option<Vec<u16>> {
        let i = self.places.remove(key)?;
        let (k, v) = self.items.remove(i);
        self.units -= k.len() + v.len();
        for (place, (k, _)) in self.items.iter().enumerate().skip(i) {
            self.places.insert(k.clone(), place);
        }
        Some(v)
    }
}

#[derive(Default)]
struct Registry {
    next: u64,
    areas: HashMap<(u64, String, String), Area>,
}
static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));
fn lock() -> MutexGuard<'static, Registry> {
    REGISTRY.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ── For the host ─────────────────────────────────────────────────────────────────────────────────────────────────────
// A new storage shed.
pub(crate) fn partition_new() -> u64 {
    let mut reg = lock();
    reg.next += 1;
    reg.next
}
// Every area of a shed emptied (a session reset; a window closed).
pub(crate) fn clear(partition: u64) {
    lock().areas.retain(|(p, _, _), _| *p != partition);
}

// ── For the bindings ─────────────────────────────────────────────────────────────────────────────────────────────────
pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "storageGet", get_op, context_id);
    register(scope, ns, "storageSet", set_op, context_id);
    register(scope, ns, "storageRemove", remove_op, context_id);
    register(scope, ns, "storageClear", clear_op, context_id);
    register(scope, ns, "storageKey", key_op, context_id);
    register(scope, ns, "storageLength", length_op, context_id);
}

// The area an op names: its shed (arg 0) and the storage key of realm arg 1's document — the realm whose global's area
// it is, whichever realm's method runs: its origin, and the site of its top-level document's (scheme and host: no
// public suffix list is kept). None for an opaque origin, which has no storage key (HTML "obtain a storage key": the
// bindings' getters throw before any op runs), and for no shed.
fn area_key(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> Option<(u64, String, String)> {
    let partition = args.get(0).number_value(scope).filter(|p| *p >= 1.0)? as u64;
    let realm = args.get(1);
    let realm = if realm.is_int32() { realm.int32_value(scope)? } else { realm_id(scope, args) };
    let arena = &crate::dom::dom(scope).arena;
    let origin_of = |r: i32| arena.realm_state(r).map(|st| st.location.origin().to_owned());
    let origin = origin_of(realm).filter(|o| !o.is_empty() && o != "null")?;
    let top = origin_of(arena.top_level_realm(realm)).unwrap_or_default();
    let site = ada_url::Url::parse(&top, None).ok().map_or(top.clone(), |u| format!("{}//{}", u.protocol(), u.hostname()));
    Some((partition, site, origin))
}

// __dom.storageGet(partition, realm, key) -> the item's value, or null.
fn get_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = utf16_arg(scope, args.get(2));
    let value = area_key(scope, &args).and_then(|k| {
        let reg = lock();
        let area = reg.areas.get(&k)?;
        area.position(&key).map(|i| area.items[i].1.clone())
    });
    match value {
        Some(v) => rv.set(utf16_value(scope, &v)),
        None => rv.set_null(),
    }
}
// __dom.storageSet(partition, realm, key, value) -> [stored, old]: false where the area's quota leaves no room (nothing
// stored), or there is no area; the item's value before (null for none).
fn set_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (key, value) = (utf16_arg(scope, args.get(2)), utf16_arg(scope, args.get(3)));
    let (stored, old) = area_key(scope, &args).map_or((false, None), |k| {
        let mut reg = lock();
        let area = reg.areas.entry(k).or_default();
        let had = area.position(&key);
        let freed = had.map_or(0, |i| area.items[i].0.len() + area.items[i].1.len());
        if area.units - freed + key.len() + value.len() > QUOTA_UNITS {
            return (false, had.map(|i| area.items[i].1.clone()));
        }
        area.units = area.units - freed + key.len() + value.len();
        match had {
            Some(i) => (true, Some(std::mem::replace(&mut area.items[i].1, value))),
            None => {
                area.places.insert(key.clone(), area.items.len());
                area.items.push((key, value));
                (true, None)
            }
        }
    });
    let old = match old {
        Some(v) => utf16_value(scope, &v),
        None => v8::null(scope).into(),
    };
    let stored = v8::Boolean::new(scope, stored).into();
    rv.set(v8::Array::new_with_elements(scope, &[stored, old]).into());
}
// __dom.storageRemove(partition, realm, key) -> the item's value, gone now, or null for none.
fn remove_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = utf16_arg(scope, args.get(2));
    let old = area_key(scope, &args).and_then(|k| lock().areas.get_mut(&k)?.remove(&key));
    match old {
        Some(v) => rv.set(utf16_value(scope, &v)),
        None => rv.set_null(),
    }
}
// __dom.storageClear(partition, realm) — every item gone.
fn clear_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(k) = area_key(scope, &args) else { return };
    lock().areas.remove(&k);
}
// __dom.storageKey(partition, realm, index) -> the index-th item's key, in the order the items were set first, or null.
fn key_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let index = args.get(2).number_value(scope).unwrap_or(-1.0);
    let key = area_key(scope, &args).and_then(|k| {
        let reg = lock();
        let area = reg.areas.get(&k)?;
        (index >= 0.0).then(|| area.items.get(index as usize).map(|(k, _)| k.clone())).flatten()
    });
    match key {
        Some(k) => rv.set(utf16_value(scope, &k)),
        None => rv.set_null(),
    }
}
// __dom.storageLength(partition, realm) -> how many items the area has.
fn length_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let n = area_key(scope, &args).map_or(0, |k| lock().areas.get(&k).map_or(0, |a| a.items.len()));
    rv.set_uint32(n as u32);
}
