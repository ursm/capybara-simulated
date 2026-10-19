// MediaQueryLists (CSSOM View §4.2): every `matchMedia` list of the isolate — its realm, its media text, the answer it
// last reported — in the order they were made, which is the order "evaluate media queries and report changes" visits
// them in ("oldest first"). The isolate's (its `Dom`), like the BroadcastChannels.
//
// A list's object is held weakly — one nothing holds has no listener to tell, and is let go of as the registry grows —
// but strongly while it has a `change` listener (events.js `noteChangeListeners`), as browsers keep it: a page that
// keeps one only through its listener still hears of a flip. What stays with the bindings (media-query.js) is the event
// each flip is.

use std::collections::BTreeMap;

use crate::dom::{dom, realm_id, register};

struct List {
    realm: i32,
    media: String,
    // (…its "matches state" as the last evaluation left it)
    matches: bool,
    object: v8::Weak<v8::Value>,
    // (…while it has a `change` listener)
    held: Option<v8::Global<v8::Value>>,
}

#[derive(Default)]
pub(crate) struct MediaQueryLists {
    next: u64,
    // (…in creation order, which its numbers are)
    of: BTreeMap<u64, List>,
    // The size at which the next sweep lets go of the lists nothing holds: twice what the last one left.
    sweep_at: usize,
}

impl MediaQueryLists {
    // A realm's lists, gone with it — its page left, the session reset, its frame removed.
    pub(crate) fn drop_realm(&mut self, cid: i32) {
        self.of.retain(|_, l| l.realm != cid);
    }
    // The isolate's slots go after V8 has disposed it, and a handle's drop resets its node, freed memory by then: let go
    // of whole (as the Dom's other weak handles are).
    pub(crate) fn leak_handles(&mut self) {
        std::mem::forget(std::mem::take(&mut self.of));
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "mqlNew", new_op, context_id);
    register(scope, ns, "mqlListened", listened_op, context_id);
    register(scope, ns, "mqlChanges", changes_op, context_id);
}

fn id_arg(scope: &mut v8::PinScope<'_, '_>, v: v8::Local<'_, v8::Value>) -> u64 {
    v.number_value(scope).map_or(0, |n| n as u64)
}

// Whether `media` matches in realm `cid` on a `width` x `height` viewport (and dom.rs `mediaMatches`'s answer).
pub(crate) fn matches(scope: &mut v8::PinScope<'_, '_>, cid: i32, media: &str, viewport: (f32, f32)) -> bool {
    let d = dom(scope);
    let screen = crate::style::Screen { viewport, touch: d.touch_input };
    let Some(arena) = d.arena.enter_known(cid) else { return false };
    crate::style::media_matches(d.styles.get(&cid), arena, screen, media)
}

pub(crate) fn viewport_here(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> (f32, f32) {
    let [w, h] = crate::viewport::here(scope, args);
    (w as f32, h as f32)
}

// __dom.mqlNew(list, media) -> the number of `list`, a new one of the calling realm's for the serialized media query list
// `media`, its matches state its answer on the realm's viewport.
fn new_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let object = v8::Weak::new(scope, args.get(0));
    let realm = realm_id(scope, &args);
    let media = args.get(1).to_rust_string_lossy(scope);
    let viewport = viewport_here(scope, &args);
    let matches = matches(scope, realm, &media, viewport);
    let lists = &mut dom(scope).media_query_lists;
    if lists.of.len() >= lists.sweep_at.max(64) {
        lists.of.retain(|_, l| l.held.is_some() || !l.object.is_empty());
        lists.sweep_at = lists.of.len() * 2;
    }
    lists.next += 1;
    let id = lists.next;
    lists.of.insert(id, List { realm, media, matches, object, held: None });
    rv.set_double(id as f64);
}

// __dom.mqlListened(id, listened): the list held strongly, while it has a `change` listener, or weakly again.
fn listened_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, args.get(0));
    let listened = args.get(1).is_true();
    let mut lists = std::mem::take(&mut dom(scope).media_query_lists);
    if let Some(l) = lists.of.get_mut(&id) {
        if !listened {
            l.held = None;
        } else if l.held.is_none() {
            l.held = l.object.to_local(scope).map(|o| v8::Global::new(scope, o));
        }
    }
    dom(scope).media_query_lists = lists;
}

// __dom.mqlChanges() -> the calling realm's lists whose answer on its viewport flipped since the last
// evaluation, oldest first, each with its new one — [list, matches, list, matches, …] — their matches states updated.
fn changes_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = realm_id(scope, &args);
    let viewport = viewport_here(scope, &args);
    let mut lists = std::mem::take(&mut dom(scope).media_query_lists);
    let mut flips = Vec::new();
    for l in lists.of.values_mut().filter(|l| l.realm == realm) {
        let Some(object) = l.object.to_local(scope) else { continue };
        let now = matches(scope, realm, &l.media, viewport);
        if now != l.matches {
            l.matches = now;
            flips.push(object);
            flips.push(v8::Boolean::new(scope, now).into());
        }
    }
    dom(scope).media_query_lists = lists;
    rv.set(v8::Array::new_with_elements(scope, &flips).into());
}
