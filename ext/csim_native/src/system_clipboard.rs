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

// __dom.clipboardWrite(partition, entries): the session's clipboard holds `entries` — `[type, bytes, …]`, each's bytes a
// byte string — from now on, its change count moved on.
fn write_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let partition = partition(scope, &args);
    let mut entries = Vec::new();
    if let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(1)) {
        let mut k = 0;
        while k + 1 < list.length() {
            let ty = list.get_index(scope, k).map(|v| v.to_rust_string_lossy(scope)).unwrap_or_default();
            let bytes = list.get_index(scope, k + 1).map(|v| crate::fetch_rules::byte_string(scope, v)).unwrap_or_default();
            entries.push((ty, bytes));
            k += 2;
        }
    }
    // (…its count taken under the lock, so a later write of one session's never holds a smaller one)
    let mut reg = lock();
    let count = LAST_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
    reg.insert(partition, Clipboard { entries, count });
}
