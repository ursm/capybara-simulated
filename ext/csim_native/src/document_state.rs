// A document's state that is no node's tree (DOM §4.5, HTML §3.1): its mode (no-quirks, limited-quirks, quirks), its
// readiness (loading, interactive, complete), whether it has a browsing context, whether it is an XML document,
// whether a scoped custom element registry initialized it, and its throw-on-dynamic-markup-insertion counter (HTML
// §8.4.1) — kept by the document's node, let go of with it. The bindings read and write each (`docState`, the
// Document's `_quirks`, `_readyState`, … accessors: dom-nodes.js), and the parser sets the mode it finds.

use std::collections::HashMap;

use crate::dom::{nid_arg, NodeId, RealmArena};

#[derive(Clone, Copy)]
struct DocumentState {
    mode: u32,
    ready: u32,
    flags: u32,
    insertions: u32,
}

impl Default for DocumentState {
    // A document is complete and in no-quirks mode until it says otherwise (DOM "create a document": mode "no-quirks";
    // the parser makes one loading).
    fn default() -> Self {
        DocumentState { mode: 0, ready: READY_COMPLETE, flags: 0, insertions: 0 }
    }
}

// The fields, as the bindings number them (`DOC_*`, dom-nodes.js).
const MODE: u32 = 0;
const READY: u32 = 1;
const FLAGS: u32 = 2;
const INSERTIONS: u32 = 3;
const READY_COMPLETE: u32 = 2;

#[derive(Default)]
pub(crate) struct DocumentStates(HashMap<NodeId, DocumentState>);

impl DocumentStates {
    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    // The document freed: its state let go of with it.
    pub(crate) fn forget(&mut self, doc: NodeId) {
        self.0.remove(&doc);
    }
}

impl RealmArena {
    // …and those of documents freed with their realm.
    pub(crate) fn forget_freed_document_states(&mut self) {
        let freed: Vec<NodeId> = self.document_states.0.keys().copied().filter(|&d| self.get(d).is_none()).collect();
        for doc in freed {
            self.document_states.0.remove(&doc);
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "docState", doc_state, context_id);
    crate::dom::register(scope, ns, "setDocState", set_doc_state, context_id);
}

// __dom.docState(docNid, field) -> the document's field (0 its mode — 0 no-quirks, 1 limited-quirks, 2 quirks; 1 its
// readiness — 0 loading, 1 interactive, 2 complete; 2 its flags, the bindings'; 3 its markup insertion counter).
fn doc_state(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return rv.set_uint32(0) };
    let field = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let state = crate::dom::dom(scope).arena.document_states.0.get(&doc).copied().unwrap_or_default();
    rv.set_uint32(match field {
        MODE => state.mode,
        READY => state.ready,
        FLAGS => state.flags,
        INSERTIONS => state.insertions,
        _ => 0,
    });
}

// __dom.setDocState(docNid, field, value) — the document's field set.
fn set_doc_state(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let field = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let value = args.get(2).uint32_value(scope).unwrap_or(0);
    let state = crate::dom::dom(scope).arena.document_states.0.entry(doc).or_default();
    match field {
        MODE => state.mode = value.min(2),
        READY => state.ready = value.min(2),
        FLAGS => state.flags = value,
        INSERTIONS => state.insertions = value,
        _ => {}
    }
}
