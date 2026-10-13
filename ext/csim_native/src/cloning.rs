// DOM "clone a node" (§4.5) — the engine's: each copy made of its source's kind, name and data, its attributes copied
// (their values exact, their namespaces), and the state the cloning steps carry over — the `is` value, the custom
// element registry association, a script's "already started" (HTML §4.12.1.1), an input's or a textarea's dirty
// checkedness, indeterminateness and live value (HTML §4.10.5), the nonce (HTML §2.6.4) — a shadow host's clonable
// shadow root attached by the bindings, whose state it is, and its tree cloned into it; and the steps of the bindings'
// own the op answers — an event handler's, a named property's, an image's, a select's, an open `<details>` /
// `<dialog>`'s.

use web_atoms::ns;
use crate::dom::{NodeData, NodeId, NodeKind, RealmArena, STATE_CHECKED, STATE_CHECKED_DIRTY, STATE_INDETERMINATE, STATE_IS_VALUE};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "cloneTree", clone_tree_op, context_id);
    crate::dom::register(scope, ns, "setCloneShadowRootHook", set_clone_shadow_root_hook, context_id);
    crate::dom::register(scope, ns, "takeCloneException", take_clone_exception, context_id);
}

// The attributes whose steps are the bindings' (`appendedAttributeSteps`, an event handler's content attribute).
pub(crate) fn bindings_steps(name: &str) -> bool {
    matches!(name, "open" | "id" | "name") || name.starts_with("on")
}

// __dom.cloneTree(node, deep) -> [copy, source, copy, names, …], or undefined where the engine declines: DOM "clone a node"
// (§4.5) of `node` (the object) — with its descendants, `deep` — the engine's whole: every copy made in the engine, of
// its source's kind, name, data, attributes and cloned state (`copy_of`), in its source's node document, its
// descendants appended in order; each one's object made only when the page is handed it (node_handle.rs `object_of`).
// After the copy, the elements whose cloning steps are the bindings' too — their attributes' (`bindings_steps`), an
// image's, a select's, a namespaced attribute's names — each with its source and the names of those attributes
// (undefined for none), in tree order. Declined, for the bindings to clone, where the
// node is no element, character data or fragment (a shadow root none) — a document, a doctype.
fn clone_tree_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let node = args.get(0);
    let Some(src) = crate::node_handle::nid_of(scope, node) else { return };
    begin_clone(scope);
    let deep = args.get(1).is_true();
    let arena = &crate::dom::dom(scope).arena;
    let Some(cid) = arena.get(src).map(|n| n.realm) else { return };
    if !clonable(arena, src) {
        return;
    }
    let doc = crate::editing::document_of(scope, src);
    let (mut held, mut steps) = (Vec::new(), Vec::new());
    let maker = crate::dom::realm_id(scope, &args);
    let Some(copy) = clone_into(scope, cid, maker, src, None, deep, doc, &mut held, &mut steps) else { return };
    let mut out = vec![crate::dom::node_value(scope, Some(copy))];
    if crate::dom::factory_threw(scope) {
        return;
    }
    out.extend(bindings_value(scope, cid, &steps));
    if crate::dom::factory_threw(scope) {
        return;
    }
    rv.set(v8::Array::new_with_elements(scope, &out).into());
}
// The copies whose cloning steps are the bindings' too, each with its source and the names of the attributes whose steps
// are theirs (`bindings_steps`) — as the page has them: `[source, copy, names, …]`; none where a node factory threw
// (`factory_threw`, which the caller asks).
pub(crate) type BindingsSteps = Vec<(NodeId, NodeId, Vec<String>)>;
pub(crate) fn bindings_value<'s>(scope: &mut v8::PinScope<'s, '_>, cid: i32, steps: &BindingsSteps) -> Vec<v8::Local<'s, v8::Value>> {
    let ids: Vec<NodeId> = steps.iter().flat_map(|(s, c, _)| [*s, *c]).collect();
    let Ok(nodes) = v8::Local::<v8::Array>::try_from(crate::dom::nodes_value(scope, cid, &ids)) else { return Vec::new() };
    if crate::dom::factory_threw(scope) {
        return Vec::new();
    }
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
pub(crate) fn names_value<'s>(scope: &mut v8::PinScope<'s, '_>, names: &[String]) -> v8::Local<'s, v8::Value> {
    if names.is_empty() {
        return v8::undefined(scope).into();
    }
    let values: Vec<v8::Local<'_, v8::Value>> =
        names.iter().map(|n| v8::String::new(scope, n).map_or_else(|| v8::undefined(scope).into(), Into::into)).collect();
    v8::Array::new_with_elements(scope, &values).into()
}


// Whether the engine clones `src`: an element, character data, a processing instruction or a fragment that is no shadow
// root — a document, a doctype and an attribute are the bindings', and are no descendant of one of those.
pub(crate) fn clonable(arena: &RealmArena, src: NodeId) -> bool {
    arena.get(src).is_some_and(|n| match n.kind {
        NodeKind::Element | NodeKind::Text | NodeKind::Comment | NodeKind::ProcessingInstruction => true,
        NodeKind::Fragment => n.host.is_none(),
        _ => false,
    })
}

// One copy, of `src`, appended to `parent` (none: the clone's root), made by realm `maker`'s code, and — `deep` — its
// children's after it: each held (`held`) until its object is made or a tree holds it, and the elements whose steps are
// the bindings' too noted with their sources (`steps`), in tree order.
#[allow(clippy::too_many_arguments)]
pub(crate) fn clone_into(
    scope: &mut v8::PinScope<'_, '_>,
    cid: i32,
    maker: i32,
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
    let attributes = (n.kind == NodeKind::Element)
        .then(|| (n.attributes.clone(), n.attr_u16.clone(), (n.attr_ns.clone(), n.attr_ns_u16.clone())));
    let copy = arena.create(data, parent);
    // (…its attributes written as any element's are — its id, its radio group, its direction, its slot, as the engine
    // notes them: `replace_attributes`)
    if let Some((attributes, attr_u16, namespaces)) = attributes {
        crate::dom::replace_attributes(scope, cid, copy, attributes, attr_u16, Some(namespaces));
    }
    let arena = crate::dom::realm(scope, cid);
    arena.clone_nonce(src, copy);
    if state != 0 {
        let had = arena.get(copy).map_or(0, |c| c.state);
        arena.set_state(copy, had | state);
        // (…a dirty checkedness its radio group's too)
        arena.note_radio(copy);
    }
    if value.is_some() {
        arena.write_live_value(copy, value);
    }
    let handle = crate::node_handle::bare(scope, copy, doc, maker);
    // (…an element's custom element registry association, the source's)
    let from = crate::dom::dom(scope).arena.get(src).filter(|n| n.kind == NodeKind::Element).and_then(|n| n.link.handle().map(|h| h as *const _));
    if let (Some(from), Some(to)) = (from, handle.get()) {
        // SAFETY: the source's handle lives while its node is in the arena, which this op does not change.
        crate::ce_reactions::copy_registry(scope, unsafe { &*from }, to);
    }
    held.push(handle);
    // (…noted too where it may be a custom element: the bindings upgrade the copies in the order they were made, as the
    // upgrade reactions "create an element" enqueues for them run)
    let candidate = crate::dom::dom(scope).arena.get(copy).is_some_and(|n| n.is_html() && (n.local_name.contains('-') || n.is_value.is_some()));
    if bindings || candidate {
        steps.push((src, copy, names));
    }
    for c in children {
        clone_into(scope, cid, maker, c, Some(copy), true, doc, held, steps)?;
    }
    // (…a shadow host's clonable shadow root onto the copy — after its children, DOM "clone a node" — and that tree with
    // it, deep, whatever `deep` says: the root the bindings attach as the source's was, whose state is theirs; its slots
    // assigned the copy's children, their `slotchange` signaled)
    let shadow = crate::dom::dom(scope).arena.get(src).and_then(|n| n.shadow_root);
    if let Some(shadow) = shadow {
        if let Some(root) = clone_shadow_root(scope, cid, src, copy)? {
            let kids = crate::dom::dom(scope).arena.get(shadow).map_or_else(Vec::new, |n| n.children.clone());
            for c in kids {
                clone_into(scope, cid, maker, c, Some(root), true, doc, held, steps)?;
            }
            crate::dom::assign_slots_in(scope, cid, Some(root), &[]);
        }
    }
    // (…a template's contents, deep: a fragment of their own, in the source contents' node document — the inert one —
    // with template contents' null registry, holding copies of theirs)
    let content = crate::dom::dom(scope).arena.get(src).and_then(|n| n.template_content).filter(|_| deep);
    if let Some(content) = content {
        let content_doc = crate::dom::dom(scope).arena.get(content).and_then(|n| n.link.handle().map(|h| h as *const crate::node_handle::NodeHandle));
        // SAFETY: as the registry's source above.
        let content_doc = content_doc.and_then(|h| unsafe { &*h }.document(scope));
        let frag = crate::dom::realm(scope, cid).create(NodeData::of_kind(NodeKind::Fragment, Vec::new()), None);
        let handle = crate::node_handle::bare(scope, frag, content_doc, maker);
        if let Some(h) = handle.get() {
            h.set_registry_state(crate::ce_reactions::TRACKING);
        }
        held.push(handle);
        let kids = crate::dom::dom(scope).arena.get(content).map_or_else(Vec::new, |n| n.children.clone());
        for c in kids {
            clone_into(scope, cid, maker, c, Some(frag), true, content_doc, held, steps)?;
        }
        crate::dom::realm(scope, cid).set_template_content(copy, Some(frag));
    }
    Some(copy)
}

// The shadow root the bindings attach to `copy` for its source `src`'s, as DOM "clone a node" does a clonable one's — the
// hook of realm `cid`, whose nodes they are (dom-nodes.js `REALM.cloneShadowRoot`): Some(None) where it is not clonable
// (or the realm has no hook); None where the hook threw — what it threw kept for the bindings to rethrow once they have
// finished what the op changed (`takeCloneException`), the clone stopping there — or making an object did, its
// exception pending.
fn clone_shadow_root(scope: &mut v8::PinScope<'_, '_>, cid: i32, src: NodeId, copy: NodeId) -> Option<Option<NodeId>> {
    let source = crate::dom::node_value(scope, Some(src));
    let made = crate::dom::node_value(scope, Some(copy));
    if crate::dom::factory_threw(scope) {
        return None;
    }
    let hook = crate::dom::dom(scope).clone_shadow_hooks.get(&cid).cloned();
    let Some(hook) = hook.and_then(|h| h.to_local(scope)) else { return Some(None) };
    let global: v8::Local<'_, v8::Value> = scope.get_current_context().global(scope).into();
    v8::tc_scope!(let tc, scope);
    let root = hook.call(tc, global, &[source, made]);
    if let Some(exception) = tc.exception().filter(|_| root.is_none()) {
        let exception = v8::Global::new(tc, exception);
        crate::dom::dom(tc).clone_exception = Some(exception);
        return None;
    }
    Some(crate::node_handle::nid_of(tc, root?))
}
// An op that clones, beginning: nothing thrown yet.
pub(crate) fn begin_clone(scope: &mut v8::PinScope<'_, '_>) {
    crate::dom::dom(scope).clone_exception = None;
}

// __dom.takeCloneException() -> `[exception]` where a shadow root's hook threw in the op that cloned last, the bindings to
// throw it once they have finished what that op changed; null for none.
fn take_clone_exception(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(exception) = crate::dom::dom(scope).clone_exception.take() else { return rv.set_null() };
    let exception = v8::Local::new(scope, exception);
    rv.set(v8::Array::new_with_elements(scope, &[exception]).into());
}

// __dom.setCloneShadowRootHook(hook) — the realm's hook a clone attaches a shadow root through (`clone_shadow_root`).
fn set_clone_shadow_root_hook(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(hook) = v8::Local::<v8::Function>::try_from(args.get(0)) else { return };
    let cid = crate::dom::realm_id(scope, &args);
    let hook = v8::Weak::new(scope, hook);
    crate::dom::dom(scope).clone_shadow_hooks.insert(cid, hook);
}

// What a copy of `n` is made of — its attributes are written after (`replace_attributes`): its kind, data, name, `is`
// value and a script's "already started" (DOM
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
        cdata: n.cdata,
        is_value: n.is_value.clone(),
        script_flags: n.script_flags & crate::script::SCRIPT_ALREADY_STARTED,
        ..NodeData::of_kind(n.kind, n.data.clone())
    };
    // (…an image's data the bindings' to update — an `<img>`, an `<input>` (an image button is one by its type, which may
    // change), an SVG `<image>`: dom-nodes.js `isImageElement`)
    let image = n.is_html_named("img") || n.is_html_named("input") || (n.ns == ns!(svg) && &*n.local_name == "image");
    let bindings = n.kind == NodeKind::Element
        && (n.attributes.iter().any(|(k, _)| bindings_steps(k)) || image || n.is_html_named("select"));
    (data, state, if control { n.value.clone() } else { None }, bindings)
}
