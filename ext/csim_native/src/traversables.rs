// The process's top-level traversables — each window of each session, a Browser's page, by a number the process gives
// it — and what one window of a browsing context group knows of another whose page lives in another isolate: the window
// that opened it (HTML's opener browsing context, null once its page disowned it: `window.opener = null`), whether it is
// closed, and the origin of its active document, as its page publishes it each time a document of it commits. "Familiar
// with" between such windows is judged here, by what they published, with no call into the other's isolate.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};

#[derive(Default)]
struct Entry {
    opener: Option<u64>,
    disowned: bool,
    closed: bool,
    // Its active document's origin's key (realm_location.rs `origin_key`), an opaque one's made the process's own — none
    // before its first document commits.
    origin: Option<String>,
}

static TRAVERSABLES: LazyLock<Mutex<(u64, HashMap<u64, Entry>)>> = LazyLock::new(Default::default);
fn traversables() -> MutexGuard<'static, (u64, HashMap<u64, Entry>)> {
    TRAVERSABLES.lock().unwrap_or_else(PoisonError::into_inner)
}

// Traversable `id`'s page disowned its opener (window.js `set_opener`).
pub(crate) fn disown(id: u64) {
    if let Some(entry) = traversables().1.get_mut(&id) {
        entry.disowned = true;
    }
}
// …whether it has.
pub(crate) fn disowned(id: u64) -> bool {
    traversables().1.get(&id).is_some_and(|e| e.disowned)
}
// Its active document's origin is the one keyed `key` — an opaque one's (`opaque:…`, its isolate's) made unique to it.
pub(crate) fn set_origin(id: u64, key: String) {
    let key = if key.starts_with("opaque:") { format!("{key}@t{id}") } else { key };
    if let Some(entry) = traversables().1.get_mut(&id) {
        entry.origin = Some(key);
    }
}

// HTML "familiar with", between top-level traversables `a` and `b`: their active documents of one origin, `a` being `b`,
// or `b` an auxiliary one whose opener — not disowned — `a` is familiar with.
fn familiar(map: &HashMap<u64, Entry>, a: u64, b: u64, depth: u8) -> bool {
    let origin = |id: u64| map.get(&id).and_then(|e| e.origin.as_deref());
    if a == b || origin(a).is_some_and(|o| origin(b) == Some(o)) {
        return true;
    }
    let opener = map.get(&b).filter(|e| !e.disowned).and_then(|e| e.opener);
    depth < 8 && opener.is_some_and(|o| familiar(map, a, o, depth + 1))
}

// One window's traversable, as its Browser holds it: registered as it is made, gone with it.
#[magnus::wrap(class = "Capybara::Simulated::Native::Traversable", free_immediately)]
pub(crate) struct Traversable {
    id: u64,
}

impl Drop for Traversable {
    fn drop(&mut self) {
        traversables().1.remove(&self.id);
    }
}

impl Traversable {
    fn new() -> Self {
        let mut registry = traversables();
        registry.0 += 1;
        let id = registry.0;
        registry.1.insert(id, Entry::default());
        Traversable { id }
    }
    // #id -> its number, which its realms are told (`setTraversable`).
    fn id(&self) -> u64 {
        self.id
    }
    // #opener = traversable: the window that opened it (HTML "create a new auxiliary browsing context").
    fn set_opener(&self, opener: &Traversable) {
        if let Some(entry) = traversables().1.get_mut(&self.id) {
            entry.opener = Some(opener.id);
        }
    }
    // #disowned? -> whether its page disowned its opener.
    fn is_disowned(&self) -> bool {
        disowned(self.id)
    }
    // #close! / #closed?: it closed (HTML "close a top-level traversable"), and whether it has.
    fn close(&self) {
        if let Some(entry) = traversables().1.get_mut(&self.id) {
            entry.closed = true;
        }
    }
    fn is_closed(&self) -> bool {
        traversables().1.get(&self.id).is_none_or(|e| e.closed)
    }
    // #familiar_with?(other) -> whether it is familiar with `other` (`familiar`).
    fn is_familiar_with(&self, other: &Traversable) -> bool {
        familiar(&traversables().1, self.id, other.id, 0)
    }
}

pub(crate) fn define(native: magnus::RModule, ruby: &magnus::Ruby) -> Result<(), magnus::Error> {
    use magnus::{function, method, Module, Object};
    let class = native.define_class("Traversable", ruby.class_object())?;
    class.define_singleton_method("new", function!(Traversable::new, 0))?;
    class.define_method("id", method!(Traversable::id, 0))?;
    class.define_method("opener=", method!(Traversable::set_opener, 1))?;
    class.define_method("disowned?", method!(Traversable::is_disowned, 0))?;
    class.define_method("close!", method!(Traversable::close, 0))?;
    class.define_method("closed?", method!(Traversable::is_closed, 0))?;
    class.define_method("familiar_with?", method!(Traversable::is_familiar_with, 1))?;
    Ok(())
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "setTraversable", set_traversable, context_id);
    crate::dom::register(scope, ns, "publishTraversableOrigin", publish_origin, context_id);
}

// __dom.setTraversable(id) — the traversable of the isolate's page (`Traversable#id`), the host's to say.
fn set_traversable(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).number_value(scope).map_or(0, |n| n as u64);
    crate::dom::dom(scope).arena.navigables.traversable = id;
}

// __dom.publishTraversableOrigin() — the page's document's origin, as it begins to load, the one its traversable is of.
fn publish_origin(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let arena = crate::dom::realm(scope, 0);
    let id = arena.navigables.traversable;
    if id != 0 {
        let key = arena.realm_state_mut(0).map(|s| s.location.origin_key(0));
        if let Some(key) = key {
            set_origin(id, key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_is_familiar_by_origin_or_through_an_opener_it_kept() {
        let (page, popup, other) = (Traversable::new(), Traversable::new(), Traversable::new());
        set_origin(page.id, "http://a.test".into());
        set_origin(popup.id, "http://b.test".into());
        set_origin(other.id, "http://a.test".into());
        popup.set_opener(&page);
        assert!(other.is_familiar_with(&page));
        assert!(page.is_familiar_with(&popup));
        assert!(!popup.is_familiar_with(&page));
        disown(popup.id);
        assert!(!page.is_familiar_with(&popup));
        // (…opaque origins, each its own)
        set_origin(page.id, "opaque:realm0".into());
        set_origin(other.id, "opaque:realm0".into());
        assert!(!other.is_familiar_with(&page));
    }
}
