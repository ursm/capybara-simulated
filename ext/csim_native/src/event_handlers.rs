// HTML's event handler content attributes (§8.1.8.1-2): which attribute of an element is one, the event type its
// handler listens for, and which a body or frameset forwards to its Window — from the tables the IDL's event handler
// attributes make (reflect_keywords.rs). The bindings compile and call the handler.

use crate::dom::{nid_arg, realm_id, NodeId, NodeKind, RealmArena};
use crate::reflect_keywords::{ELEMENT_EVENT_HANDLERS, FORWARDED_EVENT_HANDLERS, LEGACY_HANDLER_EVENT_TYPES};

// The event type the handler `name` listens for: its name past `on`, but HTML's four legacy WebKit-prefixed handlers'
// camel-case one.
pub(crate) fn event_type(name: &str) -> &str {
    LEGACY_HANDLER_EVENT_TYPES.iter().find(|(n, _)| *n == name).map_or_else(|| name.get(2..).unwrap_or(""), |&(_, t)| t)
}

// Whether `name` is a body's or frameset's handler its Window has instead (§8.1.8.2).
fn forwarded(name: &str) -> bool {
    FORWARDED_EVENT_HANDLERS.binary_search(&name).is_ok()
}

// The attribute `name` (in no namespace) of the element `id` as an event handler content attribute: none where it is
// none of that element's — an element outside HTML, SVG and MathML has none — else whether the handler is its Window's,
// a body's or frameset's forwarded one.
pub(crate) fn inline_handler(arena: &RealmArena, id: NodeId, name: &str) -> Option<bool> {
    let n = arena.get(id).filter(|n| n.kind == NodeKind::Element)?;
    if n.is_html_named("body") || n.is_html_named("frameset") {
        if forwarded(name) {
            return Some(true);
        }
    } else if !(n.is_html() || n.ns == web_atoms::ns!(svg) || n.ns == web_atoms::ns!(mathml)) {
        return None;
    }
    ELEMENT_EVENT_HANDLERS.binary_search(&name).is_ok().then_some(false)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "inlineHandler", inline_handler_op, context_id);
    crate::dom::register(scope, ns, "handlerForwarded", handler_forwarded_op, context_id);
}

// __dom.inlineHandler(nid, name) -> [eventType, forwarded] for the element's event handler content attribute `name`
// (`inline_handler`), or null where it is none.
fn inline_handler_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_null() };
    let name = args.get(1).to_rust_string_lossy(scope);
    let cid = realm_id(scope, &args);
    let Some(forwarded) = inline_handler(crate::dom::realm(scope, cid), id, &name) else { return rv.set_null() };
    let ty = v8::String::new(scope, event_type(&name)).unwrap().into();
    let forwarded = v8::Boolean::new(scope, forwarded).into();
    rv.set(v8::Array::new_with_elements(scope, &[ty, forwarded]).into());
}

// __dom.handlerForwarded(nid, name) -> whether the element's event handler IDL attribute `name` is its Window's: a body's
// or frameset's forwarded one (§8.1.8.2).
fn handler_forwarded_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let name = args.get(1).to_rust_string_lossy(scope);
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    rv.set_bool(arena.get(id).is_some_and(|n| n.is_html_named("body") || n.is_html_named("frameset")) && forwarded(&name));
}

#[cfg(test)]
mod tests {
    use crate::reflect_keywords::{ELEMENT_EVENT_HANDLERS, FORWARDED_EVENT_HANDLERS};

    // The generated tables are searched by halves: they must stay sorted.
    #[test]
    fn the_handler_tables_are_sorted() {
        assert!(ELEMENT_EVENT_HANDLERS.is_sorted());
        assert!(FORWARDED_EVENT_HANDLERS.is_sorted());
        assert_eq!(super::event_type("onwebkitanimationend"), "webkitAnimationEnd");
        assert_eq!(super::event_type("onclick"), "click");
    }
}
