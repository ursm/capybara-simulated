// DOM "clone a node" (§4.5), the element's own share — the engine's: its attributes copied (their values exact, their
// namespaces), and the state the cloning steps carry over: the `is` value, the custom element registry association, a
// script's "already started" (HTML §4.12.1.1), an input's or a textarea's dirty checkedness and indeterminateness (HTML
// §4.10.5's cloning steps; its value the bindings copy, whose string they keep). The copy is made by the bindings, whose
// object it is, and they run the steps their own attributes ask for — an event handler's, a named property's, an open
// `<details>` / `<dialog>`'s — whose names the op answers.

use crate::dom::{STATE_CHECKED, STATE_CHECKED_DIRTY, STATE_INDETERMINATE, STATE_IS_VALUE};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "cloneElementSteps", clone_element_steps, context_id);
    crate::dom::register(scope, ns, "cloneTree", clone_tree_op, context_id);
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
        rv.set(names_value(scope, &steps));
    }
}

// __dom.cloneTree(node, deep) -> [copy, source, copy, names, …], or undefined where the engine declines: DOM "clone a node"
// (§4.5) of `node` (the object) — with its descendants, `deep` — the engine's whole: every copy made in the engine, of
// its source's kind, name, data, attributes and cloned state (`copy_of`), in its source's node document, its
// descendants appended in order; each one's object made only when the page is handed it (node_handle.rs `object_of`).
// After the copy, the elements whose cloning steps are the bindings' too — their attributes' (`bindings_steps`), an
// image's, a select's, a namespaced attribute's names — each with its source and the names of those attributes
// (undefined for none, as `cloneElementSteps` answers), in tree order. Declined, for the bindings
// to clone, where the node is no element or character data, or the clone holds a `<template>` (its contents) or a
// shadow host (its shadow root).
fn clone_tree_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let node = args.get(0);
    let (Some(src), Some(from)) = (crate::node_handle::nid_of(scope, node), crate::node_handle::handle_of(scope, node)) else { return };
    let deep = args.get(1).is_true();
    let arena = &crate::dom::dom(scope).arena;
    let Some(cid) = arena.get(src).map(|n| n.realm) else { return };
    if !clonable(arena, src, deep) {
        return;
    }
    // SAFETY: the handle lives while its object, the argument, does.
    let doc = unsafe { from.as_ref() }.document(scope);
    let (mut held, mut steps) = (Vec::new(), Vec::new());
    let Some(copy) = clone_into(scope, cid, src, None, deep, doc, &mut held, &mut steps) else { return };
    let mut out = vec![crate::dom::node_value(scope, Some(copy))];
    out.extend(bindings_value(scope, cid, &steps));
    rv.set(v8::Array::new_with_elements(scope, &out).into());
}
// The copies whose cloning steps are the bindings' too, each with its source and the names of the attributes whose steps
// are theirs (`bindings_steps`) — as the page has them: `[source, copy, names, …]`.
pub(crate) type BindingsSteps = Vec<(NodeId, NodeId, Vec<String>)>;
pub(crate) fn bindings_value<'s>(scope: &mut v8::PinScope<'s, '_>, cid: i32, steps: &BindingsSteps) -> Vec<v8::Local<'s, v8::Value>> {
    let ids: Vec<NodeId> = steps.iter().flat_map(|(s, c, _)| [*s, *c]).collect();
    let Ok(nodes) = v8::Local::<v8::Array>::try_from(crate::dom::nodes_value(scope, cid, &ids)) else { return Vec::new() };
    let mut out = Vec::with_capacity(steps.len() * 3);
    for (k, (_, _, names)) in steps.iter().enumerate() {
        for i in [2 * k as u32, 2 * k as u32 + 1] {
            out.push(nodes.get_index(scope, i).unwrap_or_else(|| v8::null(scope).into()));
        }
        out.push(names_value(scope, names));
    }
    out
}
// The names of the attributes whose steps are the bindings', or undefined for none.
fn names_value<'s>(scope: &mut v8::PinScope<'s, '_>, names: &[String]) -> v8::Local<'s, v8::Value> {
    if names.is_empty() {
        return v8::undefined(scope).into();
    }
    let values: Vec<v8::Local<'_, v8::Value>> =
        names.iter().map(|n| v8::String::new(scope, n).map_or_else(|| v8::undefined(scope).into(), Into::into)).collect();
    v8::Array::new_with_elements(scope, &values).into()
}

use crate::dom::{NodeData, NodeId, NodeKind, RealmArena};

// Whether the engine clones `src` (and, `deep`, what it holds): an element or character data, and no `<template>` or
// shadow host among it.
pub(crate) fn clonable(arena: &RealmArena, src: NodeId, deep: bool) -> bool {
    let Some(n) = arena.get(src) else { return false };
    match n.kind {
        NodeKind::Text | NodeKind::Comment | NodeKind::ProcessingInstruction => true,
        NodeKind::Element => n.shadow_root.is_none() && !n.is_html_named("template") && (!deep || n.children.iter().all(|&c| clonable(arena, c, true))),
        _ => false,
    }
}

// One copy, of `src`, appended to `parent` (none: the clone's root), and — `deep` — its children's after it: each held
// (`held`) until its object is made or a tree holds it, and the elements whose steps are the bindings' too noted with
// their sources (`steps`), in tree order.
#[allow(clippy::too_many_arguments)]
pub(crate) fn clone_into(
    scope: &mut v8::PinScope<'_, '_>,
    cid: i32,
    src: NodeId,
    parent: Option<NodeId>,
    deep: bool,
    doc: Option<v8::Local<'_, v8::Object>>,
    held: &mut Vec<v8::cppgc::Persistent<crate::node_handle::NodeHandle>>,
    steps: &mut BindingsSteps,
) -> Option<NodeId> {
    let arena = crate::dom::realm(scope, cid);
    let n = arena.get(src)?;
    let (data, state, value, bindings) = copy_of(n);
    let names: Vec<String> = n.attributes.iter().map(|(k, _)| k).filter(|k| bindings_steps(k)).cloned().collect();
    let children = if deep { n.children.clone() } else { Vec::new() };
    let copy = arena.create(data, parent);
    if state != 0 {
        let had = arena.get(copy).map_or(0, |c| c.state);
        arena.set_state(copy, had | state);
    }
    if value.is_some() {
        arena.write_live_value(copy, value);
    }
    let handle = crate::node_handle::bare(scope, copy, doc);
    // (…its custom element registry association, the source's)
    let from = crate::dom::dom(scope).arena.get(src).and_then(|n| n.link.handle().map(|h| h as *const crate::node_handle::NodeHandle));
    if let (Some(from), Some(to)) = (from, handle.get()) {
        // SAFETY: the source's handle lives while its node is in the arena, which this op does not change.
        crate::ce_reactions::copy_registry(scope, unsafe { &*from }, to);
    }
    held.push(handle);
    if bindings {
        steps.push((src, copy, names));
    }
    for c in children {
        clone_into(scope, cid, c, Some(copy), true, doc, held, steps)?;
    }
    Some(copy)
}

// What a copy of `n` is made of: its kind, data, name, attributes, `is` value and a script's "already started" (DOM
// "clone a node" steps 2-4, HTML's cloning steps); the element states the cloning steps carry over (an input's or a
// textarea's dirty checkedness and indeterminateness: HTML §4.10.5) and its live value; and whether the bindings have
// steps of their own for it (`bindings_steps`, an image, a select, a namespaced attribute's names).
fn copy_of(n: &NodeData) -> (NodeData, u32, Option<Box<[u16]>>, bool) {
    let control = n.is_html_named("input") || n.is_html_named("textarea");
    let state = n.state & if control { STATE_IS_VALUE | STATE_CHECKED_DIRTY | STATE_CHECKED | STATE_INDETERMINATE } else { STATE_IS_VALUE };
    let data = NodeData {
        local_name: n.local_name.clone(),
        ns: n.ns.clone(),
        prefix: n.prefix.clone(),
        name_u16: n.name_u16.clone(),
        attributes: n.attributes.clone(),
        attr_u16: n.attr_u16.clone(),
        attr_ns: n.attr_ns.clone(),
        attr_ns_u16: n.attr_ns_u16.clone(),
        cdata: n.cdata,
        is_value: n.is_value.clone(),
        script_flags: n.script_flags & crate::script::SCRIPT_ALREADY_STARTED,
        ..NodeData::of_kind(n.kind, n.data.clone())
    };
    let bindings = n.kind == NodeKind::Element
        && (n.attributes.iter().any(|(k, _)| bindings_steps(k)) || !n.attr_ns.is_empty() || n.is_html_named("img") || n.is_html_named("select"));
    (data, state, if control { n.value.clone() } else { None }, bindings)
}
