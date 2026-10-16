// A document's state that is no node's tree (DOM §4.5, HTML §3.1): its mode (no-quirks, limited-quirks, quirks), its
// readiness (loading, interactive, complete), whether it has a browsing context, whether it is an XMLDocument (the
// interface's brand — no content type's XML-ness, the node's `STATE_XML_DOCUMENT`), whether a scoped custom element
// registry initialized it, its throw-on-dynamic-markup-insertion counter (HTML §8.4.1), and its currently executing
// script (`currentScript`, HTML §3.1.5: the script element running, null in a shadow tree or a module) — kept by the
// document's node, let go of with it. The bindings read and write each (`docState`, the Document's `_quirks`,
// `_readyState`, … accessors: dom-nodes.js), and the parser sets the mode it finds.

use std::collections::HashMap;

use crate::dom::{nid_arg, NodeId, RealmArena};

#[derive(Clone, Copy)]
struct DocumentState {
    mode: u32,
    ready: u32,
    flags: u32,
    insertions: u32,
    current_script: Option<NodeId>,
}

impl Default for DocumentState {
    // A document is complete and in no-quirks mode until it says otherwise (DOM "create a document": mode "no-quirks";
    // the parser makes one loading).
    fn default() -> Self {
        DocumentState { mode: 0, ready: READY_COMPLETE, flags: 0, insertions: 0, current_script: None }
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
    // The mode a document's selectors match in — whether it is in quirks mode (a class or id selector folds ASCII
    // case), whether it is an HTML document (a type selector and an attribute name fold case, where an XML document's
    // do not: its content type's, the node's `STATE_XML_DOCUMENT`) — an HTML no-quirks one's for none.
    pub(crate) fn document_mode(&self, doc: Option<NodeId>) -> (bool, bool) {
        let quirks = doc.and_then(|d| self.document_states.0.get(&d)).is_some_and(|s| s.mode == 2);
        let html = !doc.and_then(|d| self.get(d)).is_some_and(|n| n.state & crate::dom::STATE_XML_DOCUMENT != 0);
        (quirks, html)
    }
    // …and those of documents freed with their realm.
    pub(crate) fn forget_freed_document_states(&mut self) {
        let freed: Vec<NodeId> = self.document_states.0.keys().copied().filter(|&d| self.get(d).is_none()).collect();
        for doc in freed {
            self.document_states.0.remove(&doc);
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    // (…a fast call: a sheet's cascade key and its owner's sheet memo read the mode on every refresh)
    crate::dom::register_fast(scope, ns, "docState", doc_state, DOC_STATE_FAST, context_id);
    crate::dom::register(scope, ns, "setDocState", set_doc_state, context_id);
    crate::dom::register(scope, ns, "currentScript", current_script, context_id);
    crate::dom::register(scope, ns, "setCurrentScript", set_current_script, context_id);
}

// __dom.docState(docNid, field) -> the document's field (0 its mode — 0 no-quirks, 1 limited-quirks, 2 quirks; 1 its
// readiness — 0 loading, 1 interactive, 2 complete; 2 its flags, the bindings'; 3 its markup insertion counter).
fn doc_state(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    // (…the state a document starts with for one the engine holds none of, as the fast call answers)
    let doc = nid_arg(scope, &args, 0);
    let field = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let state = doc.and_then(|d| crate::dom::dom(scope).arena.document_states.0.get(&d).copied()).unwrap_or_default();
    rv.set_uint32(field_of(state, field));
}
fn field_of(state: DocumentState, field: u32) -> u32 {
    match field {
        MODE => state.mode,
        READY => state.ready,
        FLAGS => state.flags,
        INSERTIONS => state.insertions,
        _ => 0,
    }
}
fn doc_state_fast(_receiver: v8::Local<v8::Value>, nid: f64, field: i32, options: *mut v8::fast_api::FastApiCallbackOptions) -> i32 {
    let doc = if nid >= 0.0 { NodeId::from_i64(nid as i64) } else { None };
    let state = crate::dom::fast_dom(options).and_then(|d| d.arena.document_states.0.get(&doc?).copied()).unwrap_or_default();
    i32::try_from(field_of(state, u32::try_from(field).unwrap_or(u32::MAX))).unwrap_or(0)
}
const DOC_STATE_FAST: &[v8::fast_api::CFunction] = &[v8::fast_api::CFunction::new(
    doc_state_fast as _,
    &v8::fast_api::CFunctionInfo::new(
        v8::fast_api::Type::Int32.as_info(),
        &[
            v8::fast_api::Type::V8Value.as_info(),
            v8::fast_api::Type::Float64.as_info(),
            v8::fast_api::Type::Int32.as_info(),
            v8::fast_api::Type::CallbackOptions.as_info(),
        ],
        v8::fast_api::Int64Representation::Number,
    ),
)];

// __dom.setDocState(docNid, field, value) — the document's field set.
fn set_doc_state(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let field = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    // (…none below 0: the counter's unbalanced decrement stays 0, where a wrapped one would throw at every write)
    let value = u32::try_from(args.get(2).int32_value(scope).unwrap_or(0)).unwrap_or(0);
    let state = crate::dom::dom(scope).arena.document_states.0.entry(doc).or_default();
    match field {
        MODE => state.mode = value.min(2),
        READY => state.ready = value.min(2),
        FLAGS => state.flags = value,
        INSERTIONS => state.insertions = value,
        _ => {}
    }
}

// __dom.currentScript(docNid) -> the document's currently executing script, or null.
fn current_script(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let doc = nid_arg(scope, &args, 0);
    // (…none that is gone: a script freed since is no node to answer with)
    let arena = &crate::dom::dom(scope).arena;
    let script = doc.and_then(|d| arena.document_states.0.get(&d)).and_then(|s| s.current_script).filter(|&s| arena.get(s).is_some());
    rv.set(crate::dom::node_value(scope, script));
}

// __dom.setCurrentScript(docNid, scriptNid) — the document's currently executing script, none for null.
fn set_current_script(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let script = nid_arg(scope, &args, 1);
    crate::dom::dom(scope).arena.document_states.0.entry(doc).or_default().current_script = script;
}
