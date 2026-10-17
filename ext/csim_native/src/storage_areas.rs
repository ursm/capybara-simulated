// Web Storage's areas (HTML §12.2): a storage shed per partition — a session's for `localStorage`, which every window
// of the session shares, a top-level browsing context's for `sessionStorage` — of one area per origin, each an ordered
// list of key-value pairs of DOMStrings (UTF-16, a lone surrogate kept). The host makes the partitions and clears them;
// the bindings read and write an area through the realm whose global's area it is, by that realm's document's origin.
// The `storage` events are the bindings' and the host's (storage.js, `storage_changed`).

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

use crate::dom::{realm_id, register, utf16_arg, utf16_value};

// What an area may hold, in code units of its keys and values together — Chrome and Firefox both cap an area at ~5 MiB
// (the WPT quota tests `setItem` in a loop until QuotaExceededError).
const QUOTA_UNITS: usize = 5 * 1024 * 1024;

#[derive(Default)]
struct Area {
    items: Vec<(Vec<u16>, Vec<u16>)>,
    units: usize,
}
impl Area {
    fn position(&self, key: &[u16]) -> Option<usize> {
        self.items.iter().position(|(k, _)| k == key)
    }
}

#[derive(Default)]
struct Registry {
    next: u64,
    areas: HashMap<(u64, String), Area>,
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
    lock().areas.retain(|(p, _), _| *p != partition);
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

// The area an op names: its shed (arg 0) and the origin of realm arg 1's document — the realm whose global's area it
// is, whichever realm's method runs.
fn area_key(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> Option<(u64, String)> {
    let partition = args.get(0).number_value(scope).filter(|p| *p >= 1.0)? as u64;
    let realm = args.get(1);
    let realm = if realm.is_int32() { realm.int32_value(scope)? } else { realm_id(scope, args) };
    let origin = crate::dom::dom(scope).arena.realm_state(realm).map(|st| st.location.origin().to_owned())?;
    Some((partition, origin))
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
// __dom.storageSet(partition, realm, key, value) -> false where the area's quota leaves no room (nothing stored), else
// true.
fn set_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (key, value) = (utf16_arg(scope, args.get(2)), utf16_arg(scope, args.get(3)));
    let Some(k) = area_key(scope, &args) else { return rv.set_bool(false) };
    let mut reg = lock();
    let area = reg.areas.entry(k).or_default();
    let had = area.position(&key);
    let freed = had.map_or(0, |i| area.items[i].0.len() + area.items[i].1.len());
    if area.units - freed + key.len() + value.len() > QUOTA_UNITS {
        return rv.set_bool(false);
    }
    area.units = area.units - freed + key.len() + value.len();
    match had {
        Some(i) => area.items[i].1 = value,
        None => area.items.push((key, value)),
    }
    rv.set_bool(true);
}
// __dom.storageRemove(partition, realm, key) — the item gone.
fn remove_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let key = utf16_arg(scope, args.get(2));
    let Some(k) = area_key(scope, &args) else { return };
    let mut reg = lock();
    let Some(area) = reg.areas.get_mut(&k) else { return };
    if let Some(i) = area.position(&key) {
        let (k, v) = area.items.remove(i);
        area.units -= k.len() + v.len();
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
