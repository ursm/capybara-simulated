// DOM "clone a node" (§4.5), the element's own share — the engine's: its attributes copied (their values exact, their
// namespaces), and the state the cloning steps carry over: the `is` value, the custom element registry association, a
// script's "already started" (HTML §4.12.1.1), an input's or a textarea's dirty checkedness and indeterminateness (HTML
// §4.10.5's cloning steps; its value the bindings copy, whose string they keep). The copy is made by the bindings, whose
// object it is, and they run the steps their own attributes ask for — an event handler's, a named property's, an open
// `<details>` / `<dialog>`'s — whose names the op answers.

use crate::dom::{STATE_CHECKED, STATE_CHECKED_DIRTY, STATE_INDETERMINATE, STATE_IS_VALUE};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "cloneElementSteps", clone_element_steps, context_id);
}

// The attributes whose steps are the bindings' (`appendedAttributeSteps`, an event handler's content attribute).
fn bindings_steps(name: &str) -> bool {
    matches!(name, "open" | "id" | "name") || name.starts_with("on")
}

// __dom.cloneElementSteps(node, copy) -> the names of the copied attributes whose steps the bindings run, or undefined
// for none: `node`'s attributes and cloned state given to `copy`, a new element of its own name.
fn clone_element_steps(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(from), Some(to)) = (crate::node_handle::handle_of(scope, args.get(0)), crate::node_handle::handle_of(scope, args.get(1))) else {
        return;
    };
    let (Some(src), Some(copy)) = (crate::node_handle::nid_of(scope, args.get(0)), crate::node_handle::nid_of(scope, args.get(1))) else {
        return;
    };
    let Some(node) = crate::dom::dom(scope).arena.get(src) else { return };
    let (attributes, attr_u16) = (node.attributes.clone(), node.attr_u16.clone());
    let namespaces = (node.attr_ns.clone(), node.attr_ns_u16.clone());
    let (is_value, script_flags) = (node.is_value.clone(), node.script_flags & crate::script::SCRIPT_ALREADY_STARTED);
    let state = node.state & if node.is_html_named("input") || node.is_html_named("textarea") {
        STATE_IS_VALUE | STATE_CHECKED_DIRTY | STATE_CHECKED | STATE_INDETERMINATE
    } else {
        STATE_IS_VALUE
    };
    let steps: Vec<String> = attributes.iter().map(|(k, _)| k).filter(|k| bindings_steps(k)).cloned().collect();
    let cid = node.realm;
    crate::dom::replace_attributes(scope, cid, copy, attributes, attr_u16, Some(namespaces));
    let arena = crate::dom::realm(scope, cid);
    if let Some(node) = arena.get_mut_quietly(copy) {
        node.is_value = is_value;
        node.script_flags |= script_flags;
    }
    // (…a radio's checkedness with them, where no group of the detached copy's has another to uncheck)
    if state != 0 {
        let had = arena.get(copy).map_or(0, |n| n.state);
        arena.set_state(copy, had | state);
    }
    // SAFETY: the handles live while their objects, the arguments, do.
    crate::ce_reactions::copy_registry(scope, unsafe { from.as_ref() }, unsafe { to.as_ref() });
    if !steps.is_empty() {
        let names: Vec<v8::Local<'_, v8::Value>> =
            steps.iter().map(|n| v8::String::new(scope, n).map_or_else(|| v8::undefined(scope).into(), Into::into)).collect();
        rv.set(v8::Array::new_with_elements(scope, &names).into());
    }
}
