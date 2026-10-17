// A document's state that is no node's tree (DOM §4.5, HTML §3.1): its mode (no-quirks, limited-quirks, quirks), its
// readiness (loading, interactive, complete), whether it has a browsing context, whether it is an XMLDocument (the
// interface's brand — no content type's XML-ness, the node's `STATE_XML_DOCUMENT`), whether a scoped custom element
// registry initialized it, its throw-on-dynamic-markup-insertion counter (HTML §8.4.1), and its currently executing
// script (`currentScript`, HTML §3.1.5: the script element running, null in a shadow tree or a module) — and the texts
// that describe it (DOM §4.5: its URL, its encoding, its content type; HTML: its `document.domain`, the base URL an
// about: one inherits from its creator) and when it was last modified (`docText`) — kept by the document's node, let go
// of with it. The bindings read and write each (`docState`, the Document's `_quirks`,
// `_readyState`, … accessors: dom-nodes.js), and the parser sets the mode it finds.

use std::collections::HashMap;

use crate::dom::{nid_arg, NodeId, RealmArena};

#[derive(Clone, Copy)]
struct DocumentState {
    mode: u32,
    ready: u32,
    flags: u32,
    insertions: u32,
    // Its ignore-destructive-writes counter (HTML §8.4.3): raised while an external classic script it fetched runs, a
    // `document.write` that would open it then ignored.
    destructive_ignored: u32,
    current_script: Option<NodeId>,
}

impl Default for DocumentState {
    // A document is complete and in no-quirks mode until it says otherwise (DOM "create a document": mode "no-quirks";
    // the parser makes one loading).
    fn default() -> Self {
        DocumentState { mode: 0, ready: READY_COMPLETE, flags: 0, insertions: 0, destructive_ignored: 0, current_script: None }
    }
}

// The fields, as the bindings number them (`DOC_*`, dom-nodes.js).
const MODE: u32 = 0;
const READY: u32 = 1;
const FLAGS: u32 = 2;
const INSERTIONS: u32 = 3;
const DESTRUCTIVE_IGNORED: u32 = 4;
const READY_COMPLETE: u32 = 2;

// …its texts, as the bindings number them (`DOC_TEXT_*`): none until set — a document's URL then its realm's, its
// encoding UTF-8, its content type text/html — and its last modification time (ms since the epoch: none, now).
#[derive(Default)]
struct DocumentTexts {
    texts: [Option<String>; TEXTS],
    last_modified: Option<f64>,
    // Its preferred CSS style sheet set name (CSSOM §6.2.1): the title of the first sheet with one that was added to it
    // and is no alternate (`note_sheet_added`), none until one was — added, not first in tree order.
    preferred_set: Option<String>,
    // …and its base URL as last computed (`document_base_url`), with the base epoch and the fallback base URL it was
    // computed against — none once a text is set.
    base_url: Option<(u64, String, String)>,
}
const TEXTS: usize = 5;
const TEXT_URL: usize = 0;
const TEXT_ENCODING: usize = 1;
const TEXT_DOMAIN: usize = 3;
const TEXT_ABOUT_BASE: usize = 4;

#[derive(Default)]
pub(crate) struct DocumentStates(HashMap<NodeId, DocumentState>, HashMap<NodeId, DocumentTexts>);

impl DocumentStates {
    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty() && self.1.is_empty()
    }
    // The domain a `document.domain` write set on `doc`, none until one did.
    pub(crate) fn domain(&self, doc: NodeId) -> Option<&str> {
        self.1.get(&doc).and_then(|t| t.texts[TEXT_DOMAIN].as_deref())
    }
    pub(crate) fn set_domain(&mut self, doc: NodeId, domain: String) {
        self.1.entry(doc).or_default().texts[TEXT_DOMAIN] = Some(domain);
    }
    // The document freed: its state let go of with it.
    pub(crate) fn forget(&mut self, doc: NodeId) {
        self.0.remove(&doc);
        self.1.remove(&doc);
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
        let states = &self.document_states;
        let freed: Vec<NodeId> = states.0.keys().chain(states.1.keys()).copied().filter(|&d| self.get(d).is_none()).collect();
        for doc in freed {
            self.document_states.forget(doc);
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    // (…a fast call: a sheet's cascade key and its owner's sheet memo read the mode on every refresh)
    crate::dom::register_fast(scope, ns, "docState", doc_state, DOC_STATE_FAST, context_id);
    crate::dom::register(scope, ns, "setDocState", set_doc_state, context_id);
    // (…and one: a node's name and an element's serialization ask whether its document is an HTML one)
    crate::dom::register_fast(scope, ns, "docIsHtml", doc_is_html, DOC_IS_HTML_FAST, context_id);
    crate::dom::register(scope, ns, "docUrl", doc_url, context_id);
    crate::dom::register(scope, ns, "docBaseUrl", doc_base_url, context_id);
    crate::dom::register(scope, ns, "docText", doc_text, context_id);
    crate::dom::register(scope, ns, "setDocText", set_doc_text, context_id);
    crate::dom::register(scope, ns, "docLastModified", doc_last_modified, context_id);
    crate::dom::register(scope, ns, "currentScript", current_script, context_id);
    crate::dom::register(scope, ns, "setCurrentScript", set_current_script, context_id);
}

// __dom.docState(docNid, field) -> the document's field (0 its mode — 0 no-quirks, 1 limited-quirks, 2 quirks; 1 its
// readiness — 0 loading, 1 interactive, 2 complete; 2 its flags, the bindings'; 3 its markup insertion counter; 4 its
// ignore-destructive-writes counter).
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
        DESTRUCTIVE_IGNORED => state.destructive_ignored,
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
        DESTRUCTIVE_IGNORED => state.destructive_ignored = value,
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

// __dom.docText(docNid, field) -> the document's text (0 its URL, 1 its encoding, 2 its content type, 3 its
// `document.domain` set, 4 the base URL of an about: one), or null where none is set.
fn doc_text(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let doc = nid_arg(scope, &args, 0);
    let field = args.get(1).uint32_value(scope).map_or(TEXTS, |f| f as usize);
    let texts = &crate::dom::dom(scope).arena.document_states.1;
    let text = doc.and_then(|d| texts.get(&d)).and_then(|t| t.texts.get(field)).cloned().flatten();
    match text.and_then(|t| v8::String::new(scope, &t)) {
        Some(text) => rv.set(text.into()),
        None => rv.set_null(),
    }
}

// __dom.setDocText(docNid, field, text) — the document's text set (null, or undefined: none).
fn set_doc_text(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let Some(field) = args.get(1).uint32_value(scope).map(|f| f as usize).filter(|&f| f < TEXTS) else { return };
    let text = (!args.get(2).is_null_or_undefined()).then(|| args.get(2).to_rust_string_lossy(scope));
    let texts = crate::dom::dom(scope).arena.document_states.1.entry(doc).or_default();
    texts.texts[field] = text;
    // (…its URL, encoding or inherited base each one the base URL is computed from)
    texts.base_url = None;
}

// __dom.docLastModified(docNid[, time]) -> when the document was last modified (ms since the epoch), or null for none
// known; with `time`, that set (null: none).
fn doc_last_modified(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return rv.set_null() };
    let set = (args.length() > 1).then(|| {
        let time = args.get(1);
        if time.is_number() { time.number_value(scope).filter(|t| t.is_finite()) } else { None }
    });
    let texts = &mut crate::dom::dom(scope).arena.document_states.1;
    if let Some(time) = set {
        texts.entry(doc).or_default().last_modified = time;
    }
    match texts.get(&doc).and_then(|t| t.last_modified) {
        Some(time) => rv.set_double(time),
        None => rv.set_null(),
    }
}

// __dom.docIsHtml(docNid) -> whether the document is an HTML document: its content type no XML MIME type, as the
// bindings set the node's STATE_XML_DOCUMENT with it (`document_mode`) — one the engine holds no node of is.
fn doc_is_html(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let doc = nid_arg(scope, &args, 0);
    rv.set_bool(is_html(&crate::dom::dom(scope).arena, doc));
}
fn is_html(arena: &RealmArena, doc: Option<NodeId>) -> bool {
    !doc.and_then(|d| arena.get(d)).is_some_and(|n| n.state & crate::dom::STATE_XML_DOCUMENT != 0)
}
fn doc_is_html_fast(_receiver: v8::Local<v8::Value>, nid: f64, options: *mut v8::fast_api::FastApiCallbackOptions) -> bool {
    let doc = if nid >= 0.0 { NodeId::from_i64(nid as i64) } else { None };
    crate::dom::fast_dom(options).is_none_or(|d| is_html(&d.arena, doc))
}
const DOC_IS_HTML_FAST: &[v8::fast_api::CFunction] = &[v8::fast_api::CFunction::new(
    doc_is_html_fast as _,
    &v8::fast_api::CFunctionInfo::new(
        v8::fast_api::Type::Bool.as_info(),
        &[v8::fast_api::Type::V8Value.as_info(), v8::fast_api::Type::Float64.as_info(), v8::fast_api::Type::CallbackOptions.as_info()],
        v8::fast_api::Int64Representation::Number,
    ),
)];

impl RealmArena {
    // The document `doc`'s preferred style sheet set name (`DocumentTexts::preferred_set`).
    pub(crate) fn preferred_set(&self, doc: NodeId) -> Option<&str> {
        self.document_states.1.get(&doc).and_then(|t| t.preferred_set.as_deref())
    }
    // …that of `doc`, where it has none yet: the title of a sheet added to it (CSSOM "add a CSS style sheet" step 2).
    pub(crate) fn prefer_set(&mut self, doc: NodeId, title: &str) {
        let texts = self.document_states.1.entry(doc).or_default();
        texts.preferred_set.get_or_insert_with(|| title.to_owned());
    }
    // …and the documents of realm `cid` with none again: a page load begins its document anew.
    pub(crate) fn forget_preferred_sets(&mut self, cid: i32) {
        let docs: Vec<NodeId> = self.document_states.1.keys().copied().filter(|&d| self.get(d).is_some_and(|n| n.realm == cid)).collect();
        for doc in docs {
            if let Some(texts) = self.document_states.1.get_mut(&doc) {
                texts.preferred_set = None;
            }
        }
    }
    // The document `doc`'s URL — its own, where a load or its creation gave it one, else its realm's (a window's live
    // document keeps none: it is the realm's `location`) — or, with `fallback_base`, HTML's "fallback base URL": that
    // URL, but for an about:blank / about:srcdoc document the base URL it inherited from its creator, where it has one
    // (an opaque URL can be no base). '' where it has none at all.
    fn document_url(&self, doc: NodeId, fallback_base: bool) -> String {
        let texts = self.document_states.1.get(&doc);
        let text = |field: usize| texts.and_then(|t| t.texts[field].as_deref()).filter(|t| !t.is_empty());
        let realm = || self.get(doc).and_then(|n| self.realm_state(n.realm)).map(|s| s.location.href());
        let url = text(TEXT_URL).or_else(realm).filter(|u| !u.is_empty());
        if !fallback_base {
            return url.unwrap_or_default().to_owned();
        }
        let url = url.unwrap_or("about:blank");
        let about = url.get(..6).is_some_and(|scheme| scheme.eq_ignore_ascii_case("about:"));
        match text(TEXT_ABOUT_BASE) {
            Some(base) if about => base.to_owned(),
            _ => url.to_owned(),
        }
    }
    // HTML "document base URL" (url_ops.rs `document_base_url`): against its fallback base URL, in its encoding. Kept
    // against the base epoch, which moves with a `<base>` linked, unlinked or freed or its `href` written — the parser's
    // included — and with no other write a page makes; and against the fallback, which a navigation can change with
    // the epoch where it was (the live document is reused across visits).
    pub(crate) fn document_base_url(&mut self, doc: NodeId) -> String {
        let fallback = self.document_url(doc, true);
        let epoch = self.base_epoch;
        let texts = self.document_states.1.get(&doc);
        if let Some((_, _, href)) = texts.and_then(|t| t.base_url.as_ref()).filter(|(e, f, _)| *e == epoch && *f == fallback) {
            return href.clone();
        }
        let encoding = texts.and_then(|t| t.texts[TEXT_ENCODING].as_deref()).filter(|e| !e.is_empty()).unwrap_or("UTF-8");
        let href = crate::url_ops::document_base_url(self, doc, &fallback, Some(encoding));
        // (…none kept for a document freed, which a page can still hold: nothing would let go of it)
        if self.get(doc).is_some() {
            self.document_states.1.entry(doc).or_default().base_url = Some((epoch, fallback, href.clone()));
        }
        href
    }
}

// __dom.docUrl(docNid[, fallbackBase]) -> the document's URL (`document_url`), or with `fallbackBase` its fallback base
// URL.
fn doc_url(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let fallback_base = args.get(1).is_true();
    let url = match nid_arg(scope, &args, 0) {
        Some(doc) => crate::dom::dom(scope).arena.document_url(doc, fallback_base),
        None => String::new(),
    };
    rv.set(v8::String::new(scope, &url).unwrap().into());
}

// __dom.docBaseUrl(docNid) -> the document's base URL (`document_base_url`).
fn doc_base_url(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let url = match nid_arg(scope, &args, 0) {
        Some(doc) => crate::dom::dom(scope).arena.document_base_url(doc),
        None => String::new(),
    };
    rv.set(v8::String::new(scope, &url).unwrap().into());
}
