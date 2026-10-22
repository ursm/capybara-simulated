// DOM "adopt" (§4.5)'s walk: each of a subtree's shadow-including inclusive descendants — a host's shadow tree after the
// host, before its children; not a template's contents, which go into the new document's inert template document (the
// bindings') — given its new node document, and its custom element registry association what HTML has it be in it
// ("adopt" step 3.2 and the registry's adopting steps), and a shadow root's adopted stylesheets dropped across documents
// (construct-stylesheets: "adopting a shadow host will empty adoptedStyleSheets" — every one of them was constructed in
// the document it leaves). What a node adopted has to do besides is the bindings': the names of its elements the new
// realm's named properties answer by and its templates' contents; the walk hands back the nodes that may have something
// to do.

use crate::ce_reactions::{FIRST_REGISTRY, NULL, TRACKING, UNSET};
use crate::dom::{nid_arg, nodes_value, realm, realm_id, NodeId, NodeKind};
use crate::node_handle::NodeHandle;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "adoptInto", adopt_into, context_id);
    crate::dom::register(scope, ns, "importInto", import_into, context_id);
}

// What an adopt is: of a template's contents into another inert template document (`CONTENTS`: node documents alone, the
// contents' registries as they are), into the same document (`SAME`), another one (`CROSS`), or another whose window
// registry is another (`CROSS_REGISTRY`).
const CONTENTS: u32 = 0;
const SAME: u32 = 1;
const CROSS: u32 = 2;
const CROSS_REGISTRY: u32 = 3;

// __dom.adoptInto(rootNid, document, kind, windowRegistry) -> the nodes of the walk with steps of the bindings' to run, as
// `nodes_value` answers: across documents, the elements with an `id` or a `name` and the templates; of
// template contents, the templates. `document` is the node document each node gets; `kind` what the adopt is (`CROSS`,
// …); `windowRegistry` the document's window registry's code (0: none).
fn adopt_into(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = nid_arg(scope, &args, 0) else { return };
    let doc = v8::Local::<v8::Object>::try_from(args.get(1)).ok();
    let kind = args.get(2).uint32_value(scope).unwrap_or(SAME);
    let cross = kind >= CROSS;
    let registry_change = kind == CROSS_REGISTRY;
    let window = args.get(3).uint32_value(scope).unwrap_or(UNSET);
    let cid = realm_id(scope, &args);
    let (handles, registries, steps, shadow_roots) = {
        let arena = realm(scope, cid);
        let reactions = &arena.ce_reactions;
        let scoped = |code: u32| code >= FIRST_REGISTRY && !reactions.is_window_registry(code);
        let mut handles: Vec<*const NodeHandle> = Vec::new();
        let mut registries: Vec<(*const NodeHandle, u32)> = Vec::new();
        let mut steps: Vec<NodeId> = Vec::new();
        let mut shadow_roots: Vec<NodeId> = Vec::new();
        // (…in tree order, each node with its parent's association as the walk left it — none for one with no parent or an
        // exclusive fragment's child — which a null element is asked for)
        let association = |p: NodeId| arena.get(p).filter(|pn| !(pn.kind == NodeKind::Fragment && pn.host.is_none())).and_then(|pn| pn.link.handle()).map(|h| h.registry());
        let mut stack = vec![(root, arena.parent_of(root).and_then(association))];
        while let Some((id, parent)) = stack.pop() {
            let Some(n) = arena.get(id) else { continue };
            let shadow_root = n.kind == NodeKind::Fragment && n.host.is_some();
            let mut decided = None;
            if let Some(h) = n.link.handle().filter(|_| kind == CONTENTS) {
                handles.push(h);
            } else if let Some(h) = n.link.handle() {
                handles.push(h);
                let code = h.registry();
                // An explicit adopt takes a node out of template contents, even into the same document.
                let mut next = if code == TRACKING { UNSET } else { code };
                if cross {
                    if next >= FIRST_REGISTRY && !scoped(next) && next != window {
                        // A window's registry other than the new window's: the document's then.
                        next = UNSET;
                    } else if registry_change {
                        if next >= FIRST_REGISTRY && !scoped(next) {
                            next = UNSET;
                        } else if shadow_root {
                            // A shadow root's null is the document's, unless it keeps it (a declarative one's).
                            if next == NULL && !h.keep_null() {
                                next = UNSET;
                            }
                        } else if next == NULL {
                            // A null element's is its parent's effective global registry (DOM "adopt" step 3.3.2) — a
                            // root's or an exclusive fragment's child's the document's: the window's, which none set
                            // tracks; none for a null or a scoped one — so one in a tree kept null stays null.
                            let inherited = parent.unwrap_or(UNSET);
                            next = if inherited == NULL || scoped(inherited) { NULL } else { UNSET };
                        }
                    }
                }
                if next != code {
                    registries.push((h, next));
                }
                decided = Some(next);
            }
            let template = n.is_html_named("template");
            if (kind == CONTENTS && template) || (cross && (template || n.plain_attr("id").is_some() || n.plain_attr("name").is_some())) {
                steps.push(id);
            }
            if cross && shadow_root {
                shadow_roots.push(id);
            }
            let own = (!(n.kind == NodeKind::Fragment && n.host.is_none())).then_some(decided.unwrap_or(UNSET));
            stack.extend(n.children.iter().rev().map(|&c| (c, own)));
            stack.extend(n.shadow_root.map(|sr| (sr, own)));
        }
        (handles, registries, steps, shadow_roots)
    };
    let sheets = &mut crate::dom::dom(scope).arena.adopted_sheets;
    for sr in shadow_roots {
        sheets.remove(&sr);
    }
    // (…the references set once the arena is let go of: setting one needs the scope)
    for h in handles {
        // SAFETY: the handles of the nodes walked, which the arena holds while they are in its trees; nothing between the
        // walk and here runs script or a collection.
        unsafe { &*h }.set_document(scope, doc);
    }
    for (h, code) in registries {
        // SAFETY: as above. (…a code the walk gives is none set or the null registry, which holds no object)
        unsafe { &*h }.set_registry(scope, code, None);
    }
    rv.set(nodes_value(scope, cid, &steps));
}

// __dom.importInto(rootNid, document, sourceInert, fallback, fallbackRegistry) -> the elements with an `id` or a `name` of a
// clone `Document.importNode` made, as `nodes_value` answers: each of its shadow-including inclusive descendants given
// `document` as its node document, and the registry association HTML "clone a node" gives it with a fallback registry —
// `fallback` (a code; `fallbackRegistry` its registry where it is one), the option's where it gives another than the
// document's window registry, else none set: an element with the null registry or the template contents' null, or none
// set from a document without a browsing context (`sourceInert`), takes the fallback; one with a window's registry
// tracks the document; a scoped one keeps it. A shadow root maps as an element does, and one with the null registry keeps
// it and shields its tree from the fallback ("preserve null-ness").
fn import_into(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = nid_arg(scope, &args, 0) else { return };
    let doc = v8::Local::<v8::Object>::try_from(args.get(1)).ok();
    let source_inert = args.get(2).is_true();
    let fallback = args.get(3).uint32_value(scope).unwrap_or(UNSET);
    let fallback_registry = v8::Local::<v8::Object>::try_from(args.get(4)).ok().filter(|_| fallback >= FIRST_REGISTRY);
    let cid = realm_id(scope, &args);
    let (handles, mapped, named) = {
        let arena = realm(scope, cid);
        let reactions = &arena.ce_reactions;
        let mut handles: Vec<*const NodeHandle> = Vec::new();
        let mut mapped: Vec<(*const NodeHandle, u32)> = Vec::new();
        let mut named: Vec<NodeId> = Vec::new();
        let mut stack = vec![(root, false)];
        while let Some((id, shielded)) = stack.pop() {
            let Some(n) = arena.get(id) else { continue };
            let shadow_root = n.kind == NodeKind::Fragment && n.host.is_some();
            let mut shields = shielded;
            if let Some(h) = n.link.handle() {
                handles.push(h);
                let code = h.registry();
                if shadow_root && code == NULL {
                    shields = true;
                } else if !shielded && (n.kind == NodeKind::Element || shadow_root) {
                    if code == NULL || code == TRACKING || (code == UNSET && source_inert) {
                        mapped.push((h, fallback));
                    } else if reactions.is_window_registry(code) {
                        mapped.push((h, UNSET));
                    }
                }
            }
            if n.kind == NodeKind::Element && (n.plain_attr("id").is_some() || n.plain_attr("name").is_some()) {
                named.push(id);
            }
            stack.extend(n.children.iter().rev().map(|&c| (c, shields && shadow_root || shielded)));
            if let Some(sr) = n.shadow_root {
                stack.push((sr, shielded));
            }
        }
        (handles, mapped, named)
    };
    for h in handles {
        // SAFETY: the clone's handles, which the arena holds while they are in its tree; nothing in between runs script.
        unsafe { &*h }.set_document(scope, doc);
    }
    for (h, code) in mapped {
        // SAFETY: as above.
        unsafe { &*h }.set_registry(scope, code, fallback_registry.filter(|_| code >= FIRST_REGISTRY));
    }
    rv.set(nodes_value(scope, cid, &named));
}
