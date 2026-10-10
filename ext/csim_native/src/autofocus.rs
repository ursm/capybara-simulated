// HTML autofocus (§6.6.7): each top-level document's AUTOFOCUS CANDIDATES — the elements carrying `autofocus` inserted
// into it or a document in its frames, in the order they came — and its "autofocus processed flag", set once one has
// taken focus, anything has, or a dialog has run its focusing steps. The rendering update asks for the next candidate
// (`next`); whether one can take focus is the style engine's to say, in the bindings, which ask again where it cannot.

use std::collections::HashMap;

use crate::dom::{nid_arg, NodeId, NodeKind, RealmArena};

#[derive(Default)]
pub(crate) struct Autofocus {
    // By top-level document: its candidates, each with the document it was inserted into, and whether its autofocus is
    // processed.
    docs: HashMap<NodeId, (Vec<(NodeId, NodeId)>, bool)>,
}

impl RealmArena {
    // The autofocus insertion steps for `node`, inserted into a document whose top-level document is `top`: every element
    // carrying `autofocus` among its shadow-including inclusive descendants, in tree order, appended to `top`'s candidates
    // (moved to the end where it was one already) — none once `top`'s autofocus is processed. Whether `top` has any.
    pub(crate) fn autofocus_insert(&mut self, top: NodeId, node: NodeId) -> bool {
        let doc = self.root_of(self.shadow_including_root(node));
        let mut found = Vec::new();
        let mut stack = vec![node];
        while let Some(id) = stack.pop() {
            let Some(n) = self.get(id) else { continue };
            if n.kind == NodeKind::Element && n.plain_attr("autofocus").is_some() {
                found.push(id);
            }
            stack.extend(n.children.iter().rev());
            stack.extend(n.shadow_root);
        }
        let (list, processed) = self.autofocus.docs.entry(top).or_default();
        if !*processed {
            for id in found {
                list.retain(|&(c, _)| c != id);
                list.push((id, doc));
            }
        }
        !list.is_empty()
    }

    // `top`'s autofocus is processed: its candidates emptied, and none taken after.
    pub(crate) fn autofocus_processed(&mut self, top: NodeId) {
        self.autofocus.docs.insert(top, (Vec::new(), true));
    }

    // HTML "flush autofocus candidates" for `top`, up to what the style engine decides: with an element `focused` there,
    // its autofocus is processed and none is; else its first candidate still in the document it was inserted into, that
    // document and `top` at no fragment (their `:target`) — taken off the list, for the caller to focus where it can and
    // to ask again where it cannot.
    pub(crate) fn autofocus_next(&mut self, top: NodeId, focused: bool) -> Option<NodeId> {
        let (list, processed) = self.autofocus.docs.get(&top)?;
        if *processed || list.is_empty() {
            return None;
        }
        if focused {
            self.autofocus_processed(top);
            return None;
        }
        let candidates = list.clone();
        let mut taken = 0;
        let mut next = None;
        for &(id, doc) in &candidates {
            taken += 1;
            let in_place = self.get(id).is_some() && self.root_of(self.shadow_including_root(id)) == doc;
            if in_place && !self.at_fragment(doc) && !self.at_fragment(top) {
                next = Some(id);
                break;
            }
        }
        if let Some((list, _)) = self.autofocus.docs.get_mut(&top) {
            list.drain(..taken);
        }
        next
    }

    // Whether the document `doc` is at a fragment: its realm's `:target` has an element (§7.4.6.4 its indicated part).
    fn at_fragment(&self, doc: NodeId) -> bool {
        self.get(doc).filter(|d| d.kind == NodeKind::Document).is_some_and(|d| self.target_element_of(d.realm, doc).is_some())
    }

    // A dropped realm's top-level documents are gone, and their candidates with them.
    pub(crate) fn autofocus_forget_dead(&mut self) {
        let mut docs = std::mem::take(&mut self.autofocus.docs);
        docs.retain(|&top, _| self.get(top).is_some());
        self.autofocus.docs = docs;
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "autofocusInsert", insert_op, context_id);
    crate::dom::register(scope, ns, "autofocusProcessed", processed_op, context_id);
    crate::dom::register(scope, ns, "autofocusNext", next_op, context_id);
}

// __dom.autofocusInsert(topNid, nodeNid) -> whether the top-level document holds a candidate (`autofocus_insert`).
fn insert_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(top), Some(node)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1)) else { return rv.set_bool(false) };
    let cid = crate::dom::realm_id(scope, &args);
    rv.set_bool(crate::dom::realm(scope, cid).autofocus_insert(top, node));
}

// __dom.autofocusProcessed(topNid): the top-level document's autofocus is processed (`autofocus_processed`).
fn processed_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(top) = nid_arg(scope, &args, 0) else { return };
    let cid = crate::dom::realm_id(scope, &args);
    crate::dom::realm(scope, cid).autofocus_processed(top);
}

// __dom.autofocusNext(topNid, focused) -> [the next candidate] (`autofocus_next`), as `nodes_value` answers, or undefined
// for none.
fn next_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(top) = nid_arg(scope, &args, 0) else { return };
    let focused = args.get(1).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let Some(next) = arena.autofocus_next(top, focused) else { return };
    let root = arena.shadow_including_root(next);
    rv.set(crate::dom::nodes_value(scope, cid, root, &[next]));
}

#[cfg(test)]
mod tests {
    use crate::dom::{NodeData, NodeId, NodeKind, RealmArena};
    use web_atoms::ns;

    fn node(arena: &mut RealmArena, parent: Option<NodeId>, kind: NodeKind, name: &str, attrs: &[&str]) -> NodeId {
        let mut n = NodeData::of_kind(kind, Vec::new());
        n.local_name = name.into();
        n.ns = ns!(html);
        n.attributes = attrs.iter().map(|a| (a.to_string(), String::new())).collect();
        arena.create(n, parent)
    }

    #[test]
    fn candidates_in_order_once() {
        let mut arena = RealmArena::default();
        let doc = node(&mut arena, None, NodeKind::Document, "", &[]);
        let body = node(&mut arena, Some(doc), NodeKind::Element, "body", &[]);
        let a = node(&mut arena, Some(body), NodeKind::Element, "input", &["autofocus"]);
        let b = node(&mut arena, Some(body), NodeKind::Element, "input", &["autofocus"]);
        node(&mut arena, Some(body), NodeKind::Element, "input", &[]);
        // (…a subtree's in tree order; one inserted again goes to the end)
        assert!(arena.autofocus_insert(doc, body));
        assert!(arena.autofocus_insert(doc, a));
        assert_eq!(arena.autofocus_next(doc, false), Some(b));
        assert_eq!(arena.autofocus_next(doc, false), Some(a));
        assert_eq!(arena.autofocus_next(doc, false), None);
        // (…with focus taken, processed: nothing after)
        assert!(arena.autofocus_insert(doc, a));
        assert_eq!(arena.autofocus_next(doc, true), None);
        assert!(!arena.autofocus_insert(doc, b));
        assert_eq!(arena.autofocus_next(doc, false), None);
    }
}
