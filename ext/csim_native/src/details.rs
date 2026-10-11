// The details element's name groups (HTML §4.11.1): a details element with a non-empty `name` shares a group with the
// other details elements of its tree that have the same one, of which at most one is open — the attribute change and
// insertion steps that keep it so ("ensure details exclusivity") ask which of the group are open. The bindings remove
// the `open` attributes, whose change has steps of its own (the `toggle` task).

use crate::dom::{nid_arg, nodes_value, realm, realm_id, NodeData, NodeId, NodeKind, RealmArena};

// An open details element with a name: one that may close another, or be closed by one.
fn open_named_details(n: &NodeData) -> bool {
    n.kind == NodeKind::Element && n.is_html_named("details") && n.plain_attr("open").is_some() && n.plain_attr("name").is_some_and(|v| !v.is_empty())
}

impl RealmArena {
    // The open details elements of `id`'s name group, `id` not among them, in tree order — none where it has no name.
    pub(crate) fn open_details_in_group(&self, id: NodeId) -> Vec<NodeId> {
        let Some(name) = self.get(id).and_then(|n| n.plain_attr_units("name")).filter(|v| !v.is_empty()) else { return Vec::new() };
        let mut out = Vec::new();
        let mut stack = vec![self.root_of(id)];
        while let Some(c) = stack.pop() {
            let Some(n) = self.get(c) else { continue };
            if c != id && open_named_details(n) && n.plain_attr_is("name", &name) {
                out.push(c);
            }
            stack.extend(n.children.iter().rev().copied());
        }
        out
    }
    // The open details elements with a name among `root`'s shadow-including inclusive descendants, in shadow-including
    // tree order: those whose insertion steps may close them.
    pub(crate) fn open_named_details_in(&self, root: NodeId) -> Vec<NodeId> {
        self.shadow_including_elements(root, open_named_details)
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "openDetailsInGroup", open_details_in_group, context_id);
    crate::dom::register(scope, ns, "openNamedDetailsIn", open_named_details_in, context_id);
}

// __dom.openDetailsInGroup(nid) -> the other open details elements of its name group (`open_details_in_group`), as
// `nodes_value` answers.
fn open_details_in_group(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let ids = realm(scope, cid).open_details_in_group(id);
    rv.set(nodes_value(scope, cid, &ids));
}

// __dom.openNamedDetailsIn(rootNid) -> the open named details elements of the root's subtree (`open_named_details_in`),
// as `nodes_value` answers.
fn open_named_details_in(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let ids = realm(scope, cid).open_named_details_in(root);
    rv.set(nodes_value(scope, cid, &ids));
}
