// HTML autofocus (§6.6.7): each top-level document's AUTOFOCUS CANDIDATES — the elements carrying `autofocus` inserted
// into it or a document in its frames, in the order they came — and its "autofocus processed flag", set once one has
// taken focus, anything has, it is at a fragment, or a dialog has run its focusing steps. The rendering update takes the
// candidates in turn (`autofocus_next`); which navigable a candidate's document is in, and whether it can take focus,
// the bindings answer — they hold the frames and ask the style engine — and they ask again where one cannot.

use std::collections::HashMap;

use crate::dom::{nid_arg, NodeId, NodeKind, RealmArena};

#[derive(Default)]
pub(crate) struct Autofocus {
    // By top-level document: its candidates, and whether its autofocus is processed.
    docs: HashMap<NodeId, (Vec<NodeId>, bool)>,
    // Whether any element has ever carried `autofocus` — no insertion need ask before one has, in whichever realm — and
    // the buffer every realm's bindings read that from without a call (`autofocusSeen`, a view each).
    seen: bool,
    flag: Option<v8::SharedRef<v8::BackingStore>>,
}

impl Autofocus {
    // An element carries `autofocus`: from now on insertions look for candidates.
    pub(crate) fn note_source(&mut self) {
        if !self.seen {
            self.seen = true;
            if let Some(flag) = &self.flag {
                flag[0].set(1);
            }
        }
    }
}

impl RealmArena {
    // The autofocus insertion steps for `node`, inserted into a document whose top-level document is `top`: every element
    // carrying `autofocus` among its shadow-including inclusive descendants, in tree order, appended to `top`'s candidates
    // (moved to the end where it was one already) — none once `top`'s autofocus is processed. Whether `top` has any.
    pub(crate) fn autofocus_insert(&mut self, top: NodeId, node: NodeId) -> bool {
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
                list.retain(|&c| c != id);
                list.push(id);
            }
        }
        !list.is_empty()
    }

    // `top`'s autofocus is processed: its candidates emptied, and none taken after.
    pub(crate) fn autofocus_processed(&mut self, top: NodeId) {
        self.autofocus.docs.insert(top, (Vec::new(), true));
    }

    // HTML "flush autofocus candidates" for `top`, up to what the bindings decide: where an element is `focused` there,
    // or `top` is at a fragment (its realm's `:target` has an element), its autofocus is processed and none is; else its
    // first candidate still in a document — taken off the list.
    pub(crate) fn autofocus_next(&mut self, top: NodeId, focused: bool) -> Option<NodeId> {
        let (list, processed) = self.autofocus.docs.get(&top)?;
        if *processed || list.is_empty() {
            return None;
        }
        if focused || self.at_fragment(top) {
            self.autofocus_processed(top);
            return None;
        }
        loop {
            let (list, _) = self.autofocus.docs.get_mut(&top)?;
            if list.is_empty() {
                return None;
            }
            let id = list.remove(0);
            let in_document = self.get(id).is_some() && self.get(self.shadow_including_root(id)).is_some_and(|r| r.kind == NodeKind::Document);
            if in_document {
                return Some(id);
            }
        }
    }

    // Whether the document `doc` is at a fragment: its realm's `:target` has an element (§7.4.6.4 its indicated part).
    pub(crate) fn at_fragment(&self, doc: NodeId) -> bool {
        self.get(doc).filter(|d| d.kind == NodeKind::Document).is_some_and(|d| self.target_element_of(d.realm, doc).is_some())
    }

    // A dropped or begun-again realm's documents are gone, and their candidates with them; so are the dialogs' records
    // of what they gave focus back to, and its controls' selections.
    pub(crate) fn forget_dead_focus_records(&mut self) {
        let mut selections = std::mem::take(&mut self.text_selections);
        selections.retain(|&id, _| self.get(id).is_some());
        self.text_selections = selections;
        let mut docs = std::mem::take(&mut self.autofocus.docs);
        docs.retain(|&top, _| self.get(top).is_some());
        self.autofocus.docs = docs;
        let mut previous = std::mem::take(&mut self.previously_focused);
        previous.retain(|&dialog, &mut p| self.get(dialog).is_some() && self.get(p).is_some());
        self.previously_focused = previous;
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "autofocusInsert", insert_op, context_id);
    crate::dom::register(scope, ns, "autofocusProcessed", processed_op, context_id);
    crate::dom::register(scope, ns, "autofocusNext", next_op, context_id);
    crate::dom::register(scope, ns, "atFragment", at_fragment_op, context_id);
    // (…and the flag, a view on the isolate's one buffer)
    let store = {
        let autofocus = &mut crate::dom::dom(scope).arena.autofocus;
        let seen = autofocus.seen;
        autofocus.flag.get_or_insert_with(|| v8::ArrayBuffer::new_backing_store_from_vec(vec![u8::from(seen)]).make_shared()).clone()
    };
    let buffer = v8::ArrayBuffer::with_backing_store(scope, &store);
    if let (Some(view), Some(key)) = (v8::Uint8Array::new(scope, buffer, 0, 1), v8::String::new(scope, "autofocusSeen")) {
        ns.set(scope, key.into(), view.into());
    }
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

// __dom.autofocusNext(topNid, focused) -> [the next candidate] (`autofocus_next`), its object — a candidate is in a
// document, so held — or undefined for none.
fn next_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(top) = nid_arg(scope, &args, 0) else { return };
    let focused = args.get(1).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let Some(next) = arena.autofocus_next(top, focused) else { return };
    let root = arena.shadow_including_root(next);
    rv.set(crate::dom::nodes_value(scope, cid, root, &[next]));
}

// __dom.atFragment(docNid, …) -> whether any of the documents is at a fragment (`at_fragment`).
fn at_fragment_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let docs: Vec<NodeId> = (0..args.length()).filter_map(|i| nid_arg(scope, &args, i)).collect();
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    rv.set_bool(docs.into_iter().any(|d| arena.at_fragment(d)));
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
