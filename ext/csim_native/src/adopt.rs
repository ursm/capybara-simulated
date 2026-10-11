// DOM "adopt" (§4.5)'s walk: each of a subtree's shadow-including inclusive descendants — a host's shadow tree after the
// host, before its children; not a template's contents, which go into the new document's inert template document (the
// bindings') — given its new node document, and its custom element registry association what HTML has it be in it
// ("adopt" step 3.2 and the registry's adopting steps). What a node adopted has to do besides is the bindings': the
// names of its elements the new realm's named properties answer by, its templates' contents, its shadow roots' adopted
// stylesheets; the walk hands back the nodes that may have something to do.

use crate::ce_reactions::{FIRST_REGISTRY, NULL, TRACKING, UNSET};
use crate::dom::{nid_arg, nodes_value, realm, realm_id, NodeId, NodeKind};
use crate::node_handle::NodeHandle;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "adoptInto", adopt_into, context_id);
}

// What the walk changes of one node's registry association: its new code, and the node whose registry object it takes
// with it (its parent's, for a null one that takes its parent's scoped registry).
struct Registry {
    handle: *const NodeHandle,
    code: u32,
    from: Option<*const NodeHandle>,
}

// What an adopt is: of a template's contents into another inert template document (`CONTENTS`: node documents alone, the
// contents' registries as they are), into the same document (`SAME`), another one (`CROSS`), or another whose window
// registry is another (`CROSS_REGISTRY`).
const CONTENTS: u32 = 0;
const SAME: u32 = 1;
const CROSS: u32 = 2;
const CROSS_REGISTRY: u32 = 3;

// __dom.adoptInto(rootNid, document, kind, windowRegistry) -> the nodes of the walk with steps of the bindings' to run, as
// `nodes_value` answers: across documents, the elements with an `id` or a `name`, the templates and the shadow roots; of
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
    let (handles, registries, steps) = {
        let arena = realm(scope, cid);
        let reactions = &arena.ce_reactions;
        let scoped = |code: u32| code >= FIRST_REGISTRY && !reactions.is_window_registry(code);
        let mut handles: Vec<*const NodeHandle> = Vec::new();
        let mut registries: Vec<Registry> = Vec::new();
        let mut steps: Vec<NodeId> = Vec::new();
        // (…in tree order, so a null element's parent has had its own adopting steps when it is asked for its registry)
        let mut stack = vec![root];
        while let Some(id) = stack.pop() {
            let Some(n) = arena.get(id) else { continue };
            let shadow_root = n.kind == NodeKind::Fragment && n.host.is_some();
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
                            // A null element's is its parent's — a root's or a fragment's child's the document's — so one
                            // in a shadow root kept null stays null.
                            let parent = arena.parent_of(id).and_then(|p| arena.get(p).map(|pn| (p, pn)));
                            let from = parent.filter(|(_, pn)| !(pn.kind == NodeKind::Fragment && pn.host.is_none())).and_then(|(_, pn)| pn.link.handle());
                            let inherited = from.map_or(UNSET, |p| p.registry());
                            if inherited == NULL || scoped(inherited) {
                                registries.push(Registry { handle: h, code: inherited, from: from.map(|p| p as *const _) });
                                next = code;   // (…set with its object below)
                            } else {
                                next = UNSET;
                            }
                        }
                    }
                }
                if next != code {
                    registries.push(Registry { handle: h, code: next, from: None });
                }
            }
            let template = n.is_html_named("template");
            if (kind == CONTENTS && template) || (cross && (shadow_root || template || n.plain_attr("id").is_some() || n.plain_attr("name").is_some())) {
                steps.push(id);
            }
            stack.extend(n.children.iter().rev().copied());
            stack.extend(n.shadow_root);
        }
        (handles, registries, steps)
    };
    // (…the references set once the arena is let go of: setting one needs the scope)
    for h in handles {
        // SAFETY: the handles of the nodes walked, which the arena holds while they are in its trees; nothing between the
        // walk and here runs script or a collection.
        unsafe { &*h }.set_document(scope, doc);
    }
    for r in registries {
        // SAFETY: as above.
        let handle = unsafe { &*r.handle };
        let object = r.from.and_then(|p| unsafe { &*p }.registry_object(scope)).filter(|_| r.code >= FIRST_REGISTRY);
        handle.set_registry(scope, r.code, object);
    }
    rv.set(nodes_value(scope, cid, &steps));
}
