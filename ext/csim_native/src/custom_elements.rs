// Custom elements (HTML §4.13): which elements of a subtree a tree change owes reactions to — the connected, disconnected,
// adopted and move callbacks — in shadow-including tree order: those an upgrade has been tried on (`STATE_UPGRADED`).
// The bindings run the callbacks.

use crate::dom::{nid_arg, realm_id, NodeData, NodeId, NodeKind, RealmArena, STATE_UPGRADED};

impl RealmArena {
    // The elements among `root`'s shadow-including inclusive descendants that `pick` takes, in shadow-including tree
    // order (a host, then its shadow tree, then its children).
    pub(crate) fn shadow_including_elements(&self, root: NodeId, pick: impl Fn(&NodeData) -> bool) -> Vec<NodeId> {
        let mut out = Vec::new();
        let mut stack = vec![root];
        while let Some(id) = stack.pop() {
            let Some(n) = self.get(id) else { continue };
            if n.kind == NodeKind::Element && pick(n) {
                out.push(id);
            }
            stack.extend(n.children.iter().rev());
            if let Some(shadow) = n.shadow_root {
                stack.extend(self.get(shadow).into_iter().flat_map(|s| s.children.iter().rev()));
            }
        }
        out
    }
    // …those an upgrade has been tried on.
    pub(crate) fn upgraded_elements_in(&self, root: NodeId) -> Vec<NodeId> {
        self.shadow_including_elements(root, |n| n.state & STATE_UPGRADED != 0)
    }
    // …and HTML "upgrade candidates" for a definition just made: HTML elements of its local name and, for a customized
    // built-in, its `is` value (`is`, its name) — whatever theirs for an autonomous one, whose name is its local name.
    // Which of them the definition is for (their registry's) the bindings say.
    pub(crate) fn upgrade_candidates(&self, root: NodeId, local_name: &str, is: Option<&[u16]>) -> Vec<NodeId> {
        self.shadow_including_elements(root, |n| {
            n.is_html() && &*n.local_name == local_name && is.is_none_or(|is| n.is_value.as_deref() == Some(is))
        })
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "upgradedElementsIn", upgraded_elements_in, context_id);
    crate::dom::register(scope, ns, "upgradeCandidates", upgrade_candidates, context_id);
}

// __dom.upgradedElementsIn(rootNid) -> the elements of its subtree an upgrade has been tried on (`upgraded_elements_in`),
// as `nodes_value` answers.
fn upgraded_elements_in(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let ids = crate::dom::realm(scope, cid).upgraded_elements_in(root);
    rv.set(crate::dom::nodes_value(scope, cid, root, &ids));
}

// __dom.upgradeCandidates(rootNid, localName, isValue) -> the upgrade candidates of a definition under the root
// (`upgrade_candidates`; `isValue` null for an autonomous one), as `nodes_value` answers.
fn upgrade_candidates(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = nid_arg(scope, &args, 0) else { return };
    let local_name = args.get(1).to_rust_string_lossy(scope);
    let is = (!args.get(2).is_null_or_undefined()).then(|| crate::dom::utf16_arg(scope, args.get(2)));
    let cid = realm_id(scope, &args);
    let ids = crate::dom::realm(scope, cid).upgrade_candidates(root, &local_name, is.as_deref());
    rv.set(crate::dom::nodes_value(scope, cid, root, &ids));
}

#[cfg(test)]
mod tests {
    use crate::dom::{NodeData, NodeId, NodeKind, RealmArena, STATE_UPGRADED};
    use web_atoms::ns;

    fn element(arena: &mut RealmArena, parent: Option<NodeId>, upgraded: bool) -> NodeId {
        let mut n = NodeData::of_kind(NodeKind::Element, Vec::new());
        n.local_name = "x-a".into();
        n.ns = ns!(html);
        n.state = if upgraded { STATE_UPGRADED } else { 0 };
        arena.create(n, parent)
    }

    #[test]
    fn upgraded_elements_in_shadow_including_order() {
        let mut arena = RealmArena::default();
        let host = element(&mut arena, None, true);
        let shadow = arena.create(NodeData::of_kind(NodeKind::Fragment, Vec::new()), None);
        arena.get_mut_quietly(host).unwrap().shadow_root = Some(shadow);
        let inner = element(&mut arena, Some(shadow), true);
        let child = element(&mut arena, Some(host), true);
        element(&mut arena, Some(child), false);
        assert_eq!(arena.upgraded_elements_in(host), vec![host, inner, child]);
    }
}
