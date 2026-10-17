// The HTML parser: html5ever's tokenizer and tree builder, run here, handing the page side the tree it builds as a list
// of STEPS (`Op`) for the page side to take in order — create this element, append that node there — rather than
// building a tree of its own. The page's DOM is its own (dom-nodes.js), and a step that depends on it (whether a
// foster-parented table still has a parent, which a script may have changed) is decided where the DOM is, as it is
// taken. A parse stops at each `</script>` the page has to run before the parse goes on (html5ever's
// `TokenizerResult::Script`), and resumes when told; `document.write` puts its text at the insertion point — right after
// the `</script>` the writing script is running for — and parses up to there before it returns.
//
// A node is named by a HANDLE: 0 is the document (or a fragment parse's stand-in for one), 1 a fragment's context
// element, 2 its form element pointer, and every node the parse makes takes the next number. A template's contents
// are a handle of their own, made with the template — or, a declarative shadow root's template (`OP_SHADOW_ROOT`), the
// shadow root it attaches to its host, which its children are parsed straight into.

use std::borrow::Cow;
use std::cell::RefCell;

use html5ever::interface::{ElemName, ElementFlags, NodeOrText, QuirksMode, TreeSink};
use html5ever::tendril::StrTendril;
use html5ever::tokenizer::{BufferQueue, Tokenizer, TokenizerOpts};
use html5ever::tree_builder::{TreeBuilder, TreeBuilderOpts};
use html5ever::{Attribute, LocalName, Namespace, QualName, TokenizerResult};

use crate::dom::register;

// The steps, as the page side reads them: an op code and its operands (handles, numbers, strings), flattened.
const OP_ELEMENT: i32 = 1; // handle, ns, local name, attribute count, [prefix, ns, local name, value]…, contents handle
const OP_COMMENT: i32 = 2; // handle, text
const OP_APPEND: i32 = 3; // parent, child
const OP_APPEND_TEXT: i32 = 4; // parent, text
const OP_APPEND_BASED: i32 = 5; // element, previous element, child
const OP_APPEND_BASED_TEXT: i32 = 6; // element, previous element, text
const OP_INSERT_BEFORE: i32 = 7; // sibling, child
const OP_INSERT_TEXT_BEFORE: i32 = 8; // sibling, text
const OP_DOCTYPE: i32 = 9; // name, public id, system id
const OP_QUIRKS: i32 = 10; // 0 no-quirks, 1 limited-quirks, 2 quirks
const OP_ADD_ATTRS: i32 = 11; // handle, attribute count, [prefix, ns, local name, value]…
const OP_REMOVE: i32 = 12; // handle
const OP_REPARENT: i32 = 13; // node, new parent
const OP_POP: i32 = 14; // handle
const OP_FORM: i32 = 15; // element, form
const OP_SELECTED_CONTENT: i32 = 16; // option
const OP_SCRIPT_STARTED: i32 = 17; // script
const OP_SHADOW_ROOT: i32 = 18; // host, template, root, parent

// A namespace by number: the ones the parser ever gives an element or an attribute.
fn ns_code(ns: &Namespace) -> i32 {
    match &**ns {
        "" => 0,
        "http://www.w3.org/1999/xhtml" => 1,
        "http://www.w3.org/2000/svg" => 2,
        "http://www.w3.org/1998/Math/MathML" => 3,
        "http://www.w3.org/1999/xlink" => 4,
        "http://www.w3.org/XML/1998/namespace" => 5,
        "http://www.w3.org/2000/xmlns/" => 6,
        _ => 0,
    }
}

fn namespace_of(code: i32) -> Namespace {
    match code {
        2 => html5ever::ns!(svg),
        3 => html5ever::ns!(mathml),
        0 => html5ever::ns!(),
        _ => html5ever::ns!(html),
    }
}

enum Operand {
    Int(i32),
    Str(String),
}

#[derive(Debug)]
pub(crate) struct Name<'a>(&'a QualName);

impl ElemName for Name<'_> {
    fn ns(&self) -> &Namespace {
        &self.0.ns
    }
    fn local_name(&self) -> &LocalName {
        &self.0.local
    }
}

// What the tree builder asks of a node it made: its name (boxed, so a reference to it outlives the list growing),
// its template contents' handle, and whether it is a MathML `annotation-xml` integration point.
#[derive(Default)]
struct Node {
    name: Option<Box<QualName>>,
    contents: u32,
    annotation_xml_integration_point: bool,
}

pub(crate) struct Sink {
    nodes: RefCell<Vec<Node>>,
    ops: RefCell<Vec<Operand>>,
    // Whether the parse's document allows declarative shadow roots (HTML's "allow declarative shadow roots"): a
    // navigated-to document's parse and `setHTMLUnsafe`'s, not `innerHTML`'s or DOMParser's.
    declarative: bool,
}

impl Sink {
    fn new(context: Option<QualName>, declarative: bool) -> Sink {
        // (handle 0, the document; 1 and 2 a fragment's context element and form element pointer)
        let mut nodes = vec![Node::default(), Node::default(), Node::default()];
        nodes[1].name = context.map(Box::new);
        nodes[2].name = Some(Box::new(QualName::new(None, html5ever::ns!(html), html5ever::local_name!("form"))));
        Sink { nodes: RefCell::new(nodes), ops: RefCell::new(Vec::new()), declarative }
    }
    fn push(&self, items: impl IntoIterator<Item = Operand>) {
        self.ops.borrow_mut().extend(items);
    }
    fn int(&self, v: i32) {
        self.ops.borrow_mut().push(Operand::Int(v));
    }
    fn str(&self, s: &str) {
        self.ops.borrow_mut().push(Operand::Str(s.to_owned()));
    }
    fn attrs(&self, attrs: &[Attribute]) {
        self.int(attrs.len() as i32);
        for a in attrs {
            self.str(a.name.prefix.as_deref().unwrap_or(""));
            self.int(ns_code(&a.name.ns));
            self.str(&a.name.local);
            self.str(&a.value);
        }
    }
    fn node(&self, node: NodeOrText<u32>, as_node: i32, as_text: i32, operands: &[u32]) {
        match node {
            NodeOrText::AppendNode(child) => {
                self.int(as_node);
                for &o in operands {
                    self.int(o as i32);
                }
                self.int(child as i32);
            }
            NodeOrText::AppendText(text) => {
                self.int(as_text);
                for &o in operands {
                    self.int(o as i32);
                }
                self.str(&text);
            }
        }
    }
    fn new_handle(&self, node: Node) -> u32 {
        let mut nodes = self.nodes.borrow_mut();
        nodes.push(node);
        (nodes.len() - 1) as u32
    }
}

impl TreeSink for Sink {
    type Handle = u32;
    type Output = ();
    type ElemName<'a> = Name<'a>;

    fn finish(self) {}
    fn parse_error(&self, _msg: Cow<'static, str>) {}
    fn get_document(&self) -> u32 {
        0
    }
    fn elem_name<'a>(&'a self, target: &'a u32) -> Name<'a> {
        let name: *const QualName = &**self.nodes.borrow()[*target as usize].name.as_ref().expect("an element");
        // SAFETY: a node's name is boxed and set once, at its creation, and nodes are never removed: the QualName stays
        // where it is for as long as the sink lives, however the list around it grows.
        Name(unsafe { &*name })
    }
    fn create_element(&self, name: QualName, attrs: Vec<Attribute>, flags: ElementFlags) -> u32 {
        let contents = if flags.template { self.new_handle(Node::default()) } else { 0 };
        let handle = self.new_handle(Node {
            name: Some(Box::new(name.clone())),
            contents,
            annotation_xml_integration_point: flags.mathml_annotation_xml_integration_point,
        });
        self.int(OP_ELEMENT);
        self.int(handle as i32);
        self.int(ns_code(&name.ns));
        self.str(&name.local);
        self.attrs(&attrs);
        self.int(contents as i32);
        handle
    }
    fn create_comment(&self, text: StrTendril) -> u32 {
        let handle = self.new_handle(Node::default());
        self.push([Operand::Int(OP_COMMENT), Operand::Int(handle as i32), Operand::Str(text.to_string())]);
        handle
    }
    fn create_pi(&self, _target: StrTendril, data: StrTendril) -> u32 {
        // (an HTML parse makes none — a `<?…>` is a bogus comment — but the trait asks)
        self.create_comment(data)
    }
    fn append(&self, parent: &u32, child: NodeOrText<u32>) {
        self.node(child, OP_APPEND, OP_APPEND_TEXT, &[*parent]);
    }
    fn append_based_on_parent_node(&self, element: &u32, prev_element: &u32, child: NodeOrText<u32>) {
        self.node(child, OP_APPEND_BASED, OP_APPEND_BASED_TEXT, &[*element, *prev_element]);
    }
    fn append_doctype_to_document(&self, name: StrTendril, public_id: StrTendril, system_id: StrTendril) {
        self.push([
            Operand::Int(OP_DOCTYPE),
            Operand::Str(name.to_string()),
            Operand::Str(public_id.to_string()),
            Operand::Str(system_id.to_string()),
        ]);
    }
    fn mark_script_already_started(&self, node: &u32) {
        self.push([Operand::Int(OP_SCRIPT_STARTED), Operand::Int(*node as i32)]);
    }
    fn pop(&self, node: &u32) {
        self.push([Operand::Int(OP_POP), Operand::Int(*node as i32)]);
    }
    fn get_template_contents(&self, target: &u32) -> u32 {
        self.nodes.borrow()[*target as usize].contents
    }
    fn same_node(&self, x: &u32, y: &u32) -> bool {
        x == y
    }
    fn set_quirks_mode(&self, mode: QuirksMode) {
        let code = match mode {
            QuirksMode::NoQuirks => 0,
            QuirksMode::LimitedQuirks => 1,
            QuirksMode::Quirks => 2,
        };
        self.push([Operand::Int(OP_QUIRKS), Operand::Int(code)]);
    }
    fn append_before_sibling(&self, sibling: &u32, new_node: NodeOrText<u32>) {
        self.node(new_node, OP_INSERT_BEFORE, OP_INSERT_TEXT_BEFORE, &[*sibling]);
    }
    fn add_attrs_if_missing(&self, target: &u32, attrs: Vec<Attribute>) {
        self.int(OP_ADD_ATTRS);
        self.int(*target as i32);
        self.attrs(&attrs);
    }
    fn associate_with_form(&self, target: &u32, form: &u32, _nodes: (&u32, Option<&u32>)) {
        self.push([Operand::Int(OP_FORM), Operand::Int(*target as i32), Operand::Int(*form as i32)]);
    }
    fn remove_from_parent(&self, target: &u32) {
        self.push([Operand::Int(OP_REMOVE), Operand::Int(*target as i32)]);
    }
    fn reparent_children(&self, node: &u32, new_parent: &u32) {
        self.push([Operand::Int(OP_REPARENT), Operand::Int(*node as i32), Operand::Int(*new_parent as i32)]);
    }
    fn is_mathml_annotation_xml_integration_point(&self, handle: &u32) -> bool {
        self.nodes.borrow()[*handle as usize].annotation_xml_integration_point
    }
    fn allow_declarative_shadow_roots(&self, _intended_parent: &u32) -> bool {
        self.declarative
    }
    // A `<template shadowrootmode>` the tree builder put on the stack of open elements alone: whether the host takes the
    // shadow root is the page side's to decide (it may host one already, a custom element's constructor having attached
    // it, or be one whose definition disables shadow), where it is — and where it does not, it inserts the template as
    // any other, its children going into its contents after all: into the host, or into its contents, a template's (a
    // declarative one's, its shadow root — `parent` says which).
    fn attach_declarative_shadow(&self, host: &u32, template: &u32, _attrs: &[Attribute]) -> bool {
        let root = self.new_handle(Node::default());
        let mut nodes = self.nodes.borrow_mut();
        nodes[*template as usize].contents = root;
        let parent = match nodes[*host as usize].contents {
            0 => *host,
            contents => contents,
        };
        drop(nodes);
        self.push([OP_SHADOW_ROOT, *host as i32, *template as i32, root as i32, parent as i32].map(Operand::Int));
        true
    }
    fn maybe_clone_an_option_into_selectedcontent(&self, option: &u32) {
        self.push([Operand::Int(OP_SELECTED_CONTENT), Operand::Int(*option as i32)]);
    }
}

// A page's string holds UTF-16, a LONE surrogate included — `innerHTML = "a\uD800"` keeps it, in Chrome — where the
// parser takes Rust text, which has no room for one. So a string that is not well formed (the page side asks
// `isWellFormed()`) crosses with each lone surrogate standing as a private-use character, one for one, from a block the
// parse's text has none of (`StandIns`), and every string the parse hands back crosses home with them standing for the
// surrogates again. A block is picked at the first lone surrogate, against all the text the parse has taken until then;
// text that comes later holding that block's characters itself (a `document.write` of them, after one of a lone
// surrogate) would come back as surrogates — a residual no page meets.
const SURROGATE_STANDINS: [u32; 2] = [0xF0000, 0x100000];

#[derive(Clone, Copy, Default)]
pub(crate) struct StandIns {
    // Which blocks the parse's text has characters of.
    used: [bool; 2],
    // The block standing for lone surrogates, once the text had one.
    base: Option<u32>,
}

impl StandIns {
    fn note(&mut self, text: &str) {
        // (…only a character from U+C0000 up has a lead byte from 0xF3: the scan is skipped for nearly every text)
        if !text.bytes().any(|b| b >= 0xF3) {
            return;
        }
        for c in text.chars() {
            for (i, base) in SURROGATE_STANDINS.into_iter().enumerate() {
                self.used[i] |= (base..base + 0x800).contains(&u32::from(c));
            }
        }
    }
    fn holds(&self, c: u32) -> bool {
        self.base.is_some_and(|b| (b..b + 0x800).contains(&c))
    }
    // Whether a string of the parse's has a stand-in.
    fn in_text(&self, text: &str) -> bool {
        self.base.is_some() && text.chars().any(|c| self.holds(u32::from(c)))
    }
    // …that string as the page's UTF-16: its stand-ins the lone surrogates again.
    fn units(&self, text: &str) -> Vec<u16> {
        let Some(base) = self.base.filter(|_| self.in_text(text)) else { return text.encode_utf16().collect() };
        let mut units = Vec::with_capacity(text.len());
        for c in text.chars() {
            if self.holds(u32::from(c)) {
                units.push((u32::from(c) - base + 0xD800) as u16);
            } else {
                let mut pair = [0u16; 2];
                units.extend_from_slice(c.encode_utf16(&mut pair));
            }
        }
        units
    }
}

// `value` as the parser's text: lossless where it is well formed (`well_formed`), else with its lone surrogates
// standing as the parse's block's characters (and lossy only when no block is free).
fn parser_text(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>, well_formed: bool, standins: &mut StandIns) -> String {
    if well_formed {
        let text = value.to_rust_string_lossy(scope);
        standins.note(&text);
        return text;
    }
    let Some(string) = value.to_string(scope) else { return String::new() };
    let mut units = vec![0u16; string.length()];
    string.write_v2(scope, 0, &mut units, v8::WriteFlags::empty());
    let paired: String = char::decode_utf16(units.iter().copied()).filter_map(Result::ok).collect();
    standins.note(&paired);
    if standins.base.is_none() {
        standins.base = SURROGATE_STANDINS.into_iter().zip(standins.used).find(|(_, used)| !used).map(|(base, _)| base);
    }
    let Some(base) = standins.base else { return String::from_utf16_lossy(&units) };
    char::decode_utf16(units.iter().copied())
        .map(|r| r.unwrap_or_else(|e| char::from_u32(base + u32::from(e.unpaired_surrogate()) - 0xD800).unwrap_or('\u{FFFD}')))
        .collect()
}

// …and a string of the parse's, home: its stand-ins the surrogates again.
fn page_string<'s>(scope: &mut v8::PinScope<'s, '_>, text: &str, standins: &StandIns) -> Option<v8::Local<'s, v8::String>> {
    if !standins.in_text(text) {
        return v8::String::new(scope, text);
    }
    v8::String::new_from_two_byte(scope, &standins.units(text), v8::NewStringType::Normal)
}

// One parse in progress: its tokenizer (which owns the tree builder, which owns the sink), the input not yet tokenized,
// and — for each script running with an INSERTION POINT (HTML §13.2.4.1) — the input after it, set aside: a
// `document.write` puts its text at the end of `input`, which is where the insertion point is, and the parse stops
// there when `input` runs out. Once the input has all been taken, the tokenizer is ENDED (its tree builder has popped
// everything) and takes nothing more.
struct Parse {
    tokenizer: Tokenizer<TreeBuilder<u32, Sink>>,
    input: BufferQueue,
    set_aside: Vec<Vec<StrTendril>>,
    standins: StandIns,
    ended: bool,
    // A script-created parser's (`document.open()`, HTML "document open steps"): its input stream has no end until
    // `document.close()` inserts one (`htmlClose`) — the input running out is where its insertion point is.
    script_created: bool,
    // The nodes by handle the engine built (`htmlRunBuilt`), and what holds them while the parse goes on: one a script
    // took out of the tree is the parser's still (an open element, the form element pointer).
    handles: Vec<Option<crate::dom::NodeId>>,
    held: Vec<v8::cppgc::Persistent<crate::node_handle::NodeHandle>>,
    // …and, where a build paused (`Pause`), the steps of its batch left and the status the parse stopped with
    // (`htmlRunBuilt`).
    pending: Option<(std::vec::IntoIter<Operand>, i32)>,
}

impl Parse {
    // Tokenize until the input runs out (-1) or a script has to run first (its handle). The input running out with
    // none set aside is the end of the document.
    fn run(&mut self) -> i32 {
        if self.ended {
            return -1;
        }
        loop {
            match self.tokenizer.feed(&self.input) {
                TokenizerResult::Done => break,
                TokenizerResult::Script(handle) => return handle as i32,
                TokenizerResult::EncodingIndicator(_) => continue,
            }
        }
        if self.set_aside.is_empty() && !self.script_created {
            self.ended = true;
            self.tokenizer.end();
        }
        -1
    }
}

#[derive(Default)]
struct Parses {
    next: u32,
    live: std::collections::HashMap<u32, Parse>,
}

fn parses<'s>(scope: &'s mut v8::PinScope<'_, '_>) -> &'s mut Parses {
    if scope.get_slot::<Parses>().is_none() {
        scope.set_slot(Parses::default());
    }
    scope.get_slot_mut::<Parses>().expect("Parses slot was just set")
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "htmlParse", html_parse, context_id);
    register(scope, ns, "htmlRunBuilt", html_run_built, context_id);
    register(scope, ns, "htmlHandle", html_handle, context_id);
    register(scope, ns, "htmlScriptBegin", html_script_begin, context_id);
    register(scope, ns, "htmlScriptEnd", html_script_end, context_id);
    register(scope, ns, "htmlWrite", html_write, context_id);
    register(scope, ns, "htmlDone", html_done, context_id);
    register(scope, ns, "htmlClose", html_close, context_id);
    register(scope, ns, "htmlParseFragment", html_parse_fragment, context_id);
    register(scope, ns, "htmlParseDocument", html_parse_document, context_id);
}

// Run a parser op, catching a panic (a bug in the parser, or one a page's input found) where it would otherwise unwind
// into V8's callback frame and abort the process: the parse it was running is dropped — what it built so far stands,
// the rest of its input is lost — the bug goes to stderr, and the op answers `panicked` (steps that end the parse, so
// the page side winds it down as it would one whose input ran out).
fn parser_op(
    scope: &mut v8::PinScope<'_, '_>,
    id: Option<u32>,
    rv: &mut v8::ReturnValue<'_, v8::Value>,
    panicked: &[i32],
    op: impl FnOnce(&mut v8::PinScope<'_, '_>, &mut v8::ReturnValue<'_, v8::Value>),
) {
    let Err(panic) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| op(scope, rv))) else { return };
    let what = panic.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| panic.downcast_ref::<String>().cloned());
    eprintln!("csim: the HTML parser panicked: {}", what.unwrap_or_default());
    if let Some(id) = id {
        parses(scope).live.remove(&id);
    }
    let items: Vec<v8::Local<v8::Value>> = panicked.iter().map(|&n| v8::Integer::new(scope, n).into()).collect();
    let answer = v8::Array::new_with_elements(scope, &items);
    rv.set(answer.into());
}

// __dom.htmlParse(html, wellFormed, scripting, srcdoc, declarative, scriptCreated) -> [id]: a live document's
// parse, whose batches `htmlRunBuilt` builds — of an iframe srcdoc document with `srcdoc`, which no missing or legacy
// doctype puts in quirks mode; with `declarative`, one that attaches declarative shadow roots; `scriptCreated`, one whose
// input has no end until `htmlClose` (`Parse::script_created`).
fn html_parse(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    // (…a parse that panicked starting is parse 0, which there is none of)
    parser_op(scope, None, &mut rv, &[0], |scope, rv| {
        let mut standins = StandIns::default();
        let well_formed = args.get(1).boolean_value(scope);
        let html = parser_text(scope, args.get(0), well_formed, &mut standins);
        let scripting = args.get(2).boolean_value(scope);
        let iframe_srcdoc = args.get(3).boolean_value(scope);
        let declarative = args.get(4).boolean_value(scope);
        let opts = TreeBuilderOpts { scripting_enabled: scripting, iframe_srcdoc, ..Default::default() };
        // (…the text is decoded already, its byte order mark gone with the decoding: a U+FEFF left is text)
        let tokenizer = Tokenizer::new(TreeBuilder::new(Sink::new(None, declarative), opts), TokenizerOpts { discard_bom: false, ..Default::default() });
        let input = BufferQueue::default();
        input.push_back(StrTendril::from(html));
        let all = parses(scope);
        all.next += 1;
        let id = all.next;
        let script_created = args.get(5).is_true();
        all.live.insert(id, Parse { tokenizer, input, set_aside: Vec::new(), standins, ended: false, script_created, handles: Vec::new(), held: Vec::new(), pending: None });
        rv.set(v8::Array::new_with_elements(scope, &[v8::Integer::new_from_unsigned(scope, id).into()]).into());
    });
}

fn parse_id(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> u32 {
    args.get(0).uint32_value(scope).unwrap_or(0)
}

// What the bindings say of a live document's next batch (`htmlRunBuilt`'s `flags`): whether custom elements are defined,
// whose constructors the parser runs, whether the page observes mutations, and whether the document has a browsing
// context (a script-created parser's in `createHTMLDocument`'s has none: its selects' options set up as they close).
const CE_DEFINED: u32 = 1 << 1;
const OBSERVED: u32 = 1 << 2;
const IN_BROWSING_CONTEXT: u32 = 1 << 3;
// What `htmlRunBuilt` answers for a build that PAUSED (`Pause`), the rest of its batch built once the bindings have
// acted and ask for it: a custom element it constructed went in — they connect what it inserted — or a customizable
// select's node went in or was popped — they run its selectedness and mirror it into its `<selectedcontent>`.
const CUSTOM_ELEMENT_INSERTED: i32 = -2;
const SELECT_NODE_INSERTED: i32 = -3;
const SELECT_NODE_POPPED: i32 = -4;

// Whether a token's attributes hold `customelementregistry` (no namespace): the element's registry the null one, and no
// constructor run for it.
fn names_null_registry(attrs: &[(String, i32, String, String)]) -> bool {
    attrs.iter().any(|(prefix, ns, local, _)| prefix.is_empty() && *ns == 0 && local == "customelementregistry")
}

// Where the step of `ops` at `i` ends: the index of the next one's code.
fn op_end(ops: &[Operand], i: usize) -> Option<usize> {
    let int = |k: usize| match ops.get(k) {
        Some(Operand::Int(v)) => Some(*v),
        _ => None,
    };
    let count = |k: usize| int(k).map(|n| n.max(0) as usize);
    Some(match int(i)? {
        OP_ELEMENT => i + 6 + 4 * count(i + 4)?,
        OP_ADD_ATTRS => i + 3 + 4 * count(i + 2)?,
        OP_SHADOW_ROOT => i + 5,
        OP_DOCTYPE | OP_APPEND_BASED | OP_APPEND_BASED_TEXT => i + 4,
        OP_QUIRKS | OP_REMOVE | OP_POP | OP_SELECTED_CONTENT | OP_SCRIPT_STARTED => i + 2,
        _ => i + 3,
    })
}
// The node the step of `ops` that inserts `handle` first puts it under — the parser's insertion parent for it, which it
// knows only once it has made it — as a handle; for a foster-parented one, the table and the element before it on the
// stack of open elements (`based`).
fn insertion_parent(ops: &[Operand], handle: i32) -> Option<(i32, Option<i32>)> {
    let int = |k: usize| match ops.get(k) {
        Some(Operand::Int(v)) => Some(*v),
        _ => None,
    };
    let mut i = 0;
    while i < ops.len() {
        match int(i)? {
            OP_APPEND if int(i + 2) == Some(handle) => return Some((int(i + 1)?, None)),
            OP_INSERT_BEFORE if int(i + 2) == Some(handle) => return Some((int(i + 1)?, Some(-1))),
            OP_APPEND_BASED if int(i + 3) == Some(handle) => return Some((int(i + 1)?, int(i + 2))),
            _ => {}
        }
        i = op_end(ops, i)?;
    }
    None
}

// __dom.htmlRunBuilt(id, flags, document, templateDocument, html, head, body) -> [status, quirks, sheets, connect,
// images, reused, count, nodes…, element, names, flags, …]: the parse run on to where it stops — a script to run first
// (its handle), or the input run out (-1) — and the batch built as the page's own insertions are (`Build`'s live mode),
// its nodes in `document`, a template's contents in `templateDocument`, the first `<html>`, `<head>` and `<body>` it
// parses the document's own (`html`, `head`, `body`): the document's mode it set (`quirks`, -1 none), whether a style
// sheet's element came in (`sheets`), and the elements the bindings act on — `connect` with a connection step, `images`
// that may fetch one, `reused` skeleton elements, and the node a build that paused at a select's node paused at (the
// last of `nodes`) — then the elements the bindings have steps for (`Build::answer`). [-1] alone for a parse a panic
// wound down.
fn html_run_built(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = parse_id(scope, &args);
    parser_op(scope, Some(id), &mut rv, &[-1], |scope, rv| {
        let flags = args.get(1).uint32_value(scope).unwrap_or(0);
        // (…or the steps a build that paused left of its batch, which stopped where it stopped — built on as they are)
        let resumed = parses(scope).live.get_mut(&id).and_then(|p| p.pending.take());
        let status = match &resumed {
            Some((_, status)) => *status,
            None => parses(scope).live.get_mut(&id).map_or(-1, Parse::run),
        };
        let doc = v8::Local::<v8::Object>::try_from(args.get(2)).ok().map(|d| v8::Local::new(scope, d));
        let Some(document) = doc.and_then(|d| crate::node_handle::nid_of(scope, d.into())) else { return };
        let skeleton: [Option<crate::dom::NodeId>; 3] = [4, 5, 6].map(|k| crate::node_handle::nid_of(scope, args.get(k)));
        let Some(cid) = crate::dom::dom(scope).arena.get(document).map(|n| n.realm) else { return };
        let template_doc = v8::Local::<v8::Object>::try_from(args.get(3)).ok().map(|d| v8::Local::new(scope, d)).or(doc);
        let Some(p) = parses(scope).live.get_mut(&id) else { return };
        let ops = match resumed {
            Some((rest, _)) => rest,
            None => std::mem::take(&mut *p.tokenizer.sink.sink.ops.borrow_mut()).into_iter(),
        };
        let mut handles = std::mem::take(&mut p.handles);
        if handles.is_empty() {
            handles = vec![Some(document), None, None];
        }
        let standins = p.standins;
        let live = Live {
            observed: flags & OBSERVED != 0,
            ce_defined: flags & CE_DEFINED != 0,
            browsing_context: flags & IN_BROWSING_CONTEXT != 0,
            skeleton,
            ..Live::default()
        };
        let mut build = Build::new(cid, doc, template_doc, handles);
        build.standins = standins;
        build.script = crate::script::SCRIPT_ALREADY_STARTED | crate::script::SCRIPT_PARSER_INSERTED;
        build.live = Some(live);
        let built = build.take(scope, ops);
        let live = build.live.take().unwrap_or_default();
        let (paused, failed) = (build.paused.take(), built.is_none());
        if let Some(p) = parses(scope).live.get_mut(&id) {
            p.handles = std::mem::take(&mut build.nodes);
            p.held.append(&mut build.held);
            if let (Some(_), Some(rest)) = (&paused, built) {
                p.pending = Some((rest, status));
            }
        }
        if failed {
            return;
        }
        let (status, stepped) = match paused {
            Some(Pause::CustomElement) => (CUSTOM_ELEMENT_INSERTED, None),
            Some(Pause::Select(node, false)) => (SELECT_NODE_INSERTED, Some(node)),
            Some(Pause::Select(node, true)) => (SELECT_NODE_POPPED, Some(node)),
            None => (status, None),
        };
        let arena = crate::dom::realm(scope, cid);
        let named = |e: &crate::dom::NodeId, names: &[&str]| arena.get(*e).is_some_and(|n| names.iter().any(|t| *t == &*n.local_name));
        let connect: Vec<crate::dom::NodeId> = live.inserted.iter().copied().filter(|&e| arena.get(e).is_some_and(crate::connection_steps::has_connection_step)).collect();
        let images: Vec<crate::dom::NodeId> = live.inserted.iter().copied().filter(|e| named(e, &["img", "image", "input"])).collect();
        let sheets = live.inserted.iter().any(|e| named(e, &["style", "link"]));
        let quirks = build.quirks.unwrap_or(-1);
        let counts = [status, quirks, i32::from(sheets), connect.len() as i32, images.len() as i32, live.reused.len() as i32];
        let tops: Vec<crate::dom::NodeId> = connect.into_iter().chain(images).chain(live.reused).chain(stepped).collect();
        let Some(answer) = build.answer(scope, &tops) else { return };
        let mut out: Vec<v8::Local<'_, v8::Value>> = counts.iter().map(|&n| v8::Integer::new(scope, n).into()).collect();
        out.extend(answer);
        rv.set(v8::Array::new_with_elements(scope, &out).into());
    });
}

// __dom.htmlHandle(id, handle) -> the node a parse's handle names (the engine's build made, or the bindings), or null.
fn html_handle(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = parse_id(scope, &args);
    let handle = args.get(1).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let node = parses(scope).live.get(&id).and_then(|p| p.handles.get(handle).copied().flatten());
    rv.set(crate::dom::node_value(scope, node));
}
// __dom.htmlScriptBegin(id): a script runs with an insertion point — just past its `</script>`, or before the next
// input character for the pending parsing-blocking one: the input after it is set aside until `htmlScriptEnd`.
fn html_script_begin(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = parse_id(scope, &args);
    parser_op(scope, Some(id), &mut rv, &[], |scope, _| {
        if let Some(p) = parses(scope).live.get_mut(&id) {
            let mut rest = Vec::new();
            while let Some(chunk) = p.input.pop_front() {
                rest.push(chunk);
            }
            p.set_aside.push(rest);
        }
    });
}

// __dom.htmlScriptEnd(id): …and has run: what it wrote and the parse did not take stays where it is, and the input set
// aside goes back after it.
fn html_script_end(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = parse_id(scope, &args);
    parser_op(scope, Some(id), &mut rv, &[], |scope, _| {
        if let Some(p) = parses(scope).live.get_mut(&id) {
            for chunk in p.set_aside.pop().unwrap_or_default() {
                p.input.push_back(chunk);
            }
        }
    });
}

// __dom.htmlWrite(id, html, wellFormed) -> whether it went in: `document.write(html)` from a script with an insertion
// point puts its text there — at the end of the input the parse has not taken, before what is set aside.
// (`htmlRunBuilt` parses it, but for a pending parsing-blocking script.) Nothing goes into a parse that has ended.
fn html_write(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = parse_id(scope, &args);
    parser_op(scope, Some(id), &mut rv, &[], |scope, rv| {
        let well_formed = args.get(2).boolean_value(scope);
        let Some(mut standins) = parses(scope).live.get_mut(&id).filter(|p| !p.ended).map(|p| std::mem::take(&mut p.standins)) else {
            return rv.set_bool(false);
        };
        let html = parser_text(scope, args.get(1), well_formed, &mut standins);
        if let Some(p) = parses(scope).live.get_mut(&id) {
            p.standins = standins;
            p.input.push_back(StrTendril::from(html));
        }
        rv.set_bool(true);
    });
}

// __dom.htmlClose(id): a script-created parse's input stream has its end (`document.close()`): it ends where the input
// runs out from now on.
fn html_close(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = parse_id(scope, &args);
    if let Some(p) = parses(scope).live.get_mut(&id) {
        p.script_created = false;
    }
}

// __dom.htmlDone(id): the parse is over (or abandoned); its state goes.
fn html_done(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = parse_id(scope, &args);
    parses(scope).live.remove(&id);
}

// ── a fragment parse, built by the engine ───────────────────────────────────────────────────────────────────────────
//
// `innerHTML` and the like parse a fragment no script runs in and no page is told of until it is inserted: its steps are
// taken here, into the arena, the nodes made in the engine (their objects made when the page is handed them:
// node_handle.rs `object_of`) — as html-tree-builder.js takes them for a parse that runs scripts. What the bindings'
// own steps are for — an element's event handler, named property, details or autofocus, a namespaced attribute's
// names, a select's options — they run after, for the elements the build names.

// A namespace as `ns_code` numbers it, as the arena names it.
fn arena_namespace(code: i32) -> web_atoms::Namespace {
    web_atoms::Namespace::from(&*namespace_of(code))
}

// …and an attribute's: the foreign attributes' namespaces too (xlink, xml, xmlns), as `ns_code` numbers them.
fn attribute_namespace(code: i32) -> &'static str {
    match code {
        4 => "http://www.w3.org/1999/xlink",
        5 => "http://www.w3.org/XML/1998/namespace",
        6 => "http://www.w3.org/2000/xmlns/",
        2 => "http://www.w3.org/2000/svg",
        3 => "http://www.w3.org/1998/Math/MathML",
        1 => "http://www.w3.org/1999/xhtml",
        _ => "",
    }
}

// The form-associated elements the parser associates with its form element pointer (HTML "create an element for the
// token" step 12) — no `<img>`, no custom element.
const FORM_ASSOCIATED: [&str; 7] = ["button", "fieldset", "input", "object", "output", "select", "textarea"];

// What the bindings run for an element the build made, after it: its attributes' steps (`names`), and — `BUILT_*` —
// a select's options set up, its insertion steps, and — a `<details>` its name group has another open one of before it
// — its closing, which the build made (its `open` added, then removed: both its toggle's states, the bindings' task).
const BUILT_SELECT: u32 = 1;
const BUILT_INSERTED: u32 = 1 << 2;
pub(crate) const BUILT_CLOSED: u32 = 1 << 3;

// One build — the HTML parser's, and the XML parser's (xml_parse.rs `xmlBuild`): the realm it is in and the one whose
// code asked, the node document of what it makes and of what template contents hold (the inert one), the nodes by
// handle — each held until its object is made or a tree holds it — the nodes in template contents, the elements the
// bindings have steps for, and the flag a script it inserts out of template contents takes.
pub(crate) struct Build<'s> {
    pub(crate) cid: i32,
    maker: i32,
    doc: Option<v8::Local<'s, v8::Object>>,
    template_doc: Option<v8::Local<'s, v8::Object>>,
    nodes: Vec<Option<crate::dom::NodeId>>,
    held: Vec<v8::cppgc::Persistent<crate::node_handle::NodeHandle>>,
    in_contents: std::collections::HashSet<crate::dom::NodeId>,
    // …the template contents it made, roots of trees no later insertion runs steps over
    contents: Vec<crate::dom::NodeId>,
    // …the declarative shadow roots it attached, whose slots no insertion into them assigned (one out of a live document)
    shadows: Vec<crate::dom::NodeId>,
    steps: Vec<(crate::dom::NodeId, Vec<String>, u32)>,
    // A document's mode, as `htmlParse` numbers it, where the parse set one.
    quirks: Option<i32>,
    // (…"already started" — a fragment's, a document no script runs in — or, an XML document's, "parser-inserted"; and
    // in template contents none, a fragment's "already started": the fragment parser marks every script it makes)
    pub(crate) script: u8,
    pub(crate) contents_script: u8,
    // A live document's build (`htmlRunBuilt`): what it does as the page's own insertions do, none otherwise.
    live: Option<Live>,
    // The registry association every element it makes takes (ce_reactions.rs codes, and the registry a code names): a
    // fragment parse's context's, where it has one — a scoped registry, the null one or the tracking null.
    pub(crate) registry: Option<(u32, Option<v8::Local<'s, v8::Object>>)>,
    // …and where it paused, for the bindings to act before it goes on (`Pause`).
    paused: Option<Pause>,
    // The stand-ins of the parse's lone surrogates (`StandIns`): its text, comments, doctype and attribute values made the
    // page's UTF-16 again, as the bindings would have them.
    pub(crate) standins: StandIns,
}

// Where a live document's build pauses for the bindings: after a custom element it constructed went in — connected
// before the next start tag's constructor runs — or at a customizable select's node (`select_node`), inserted or popped
// (`true`): the select's selectedness run and its `<selectedcontent>` made to mirror it as the parser goes, the steps
// the bindings' (custom-elements.js).
enum Pause {
    CustomElement,
    Select(crate::dom::NodeId, bool),
}

// Whether `node`, just inserted or `popped`, is a customizable select's node the bindings act on: a `<selectedcontent>`
// in a select — which makes it one — and an option of one, as it goes in and as it closes, and the select closing.
fn select_node(arena: &crate::dom::RealmArena, node: crate::dom::NodeId, popped: bool) -> bool {
    let customizable = |select: Option<crate::dom::NodeId>| {
        select.and_then(|s| arena.get(s)).is_some_and(|n| n.element_flags & crate::element_flags::SELECT_HAS_SELECTED_CONTENT != 0)
    };
    match arena.get(node) {
        Some(n) if n.is_html_named("selectedcontent") => !popped && arena.html_ancestor(node, "select", false).is_some(),
        Some(n) if n.is_html_named("option") => customizable(arena.html_ancestor(node, "select", false)),
        Some(n) if n.is_html_named("select") => popped && customizable(Some(node)),
        _ => false,
    }
}

// A live document parse's batch the engine builds: the document's `<html>`, `<head>` and `<body>` not taken yet, which
// the parser's first of each takes the place of (their identities kept); the nodes it made — a text one of an earlier
// batch is the page's already, its data changed as any write changes it — and what the bindings act on after it: the
// elements it inserted out of template contents, in order, and the skeleton elements it reused.
#[derive(Default)]
struct Live {
    // (…and whether the page observes mutations, each insertion and removal then queuing its childList record, as the
    // page's own do)
    observed: bool,
    // (…whether custom elements are defined, whose constructors it runs as it makes their elements)
    ce_defined: bool,
    // (…whether its document has a browsing context, whose connection sets a select's options up)
    browsing_context: bool,
    skeleton: [Option<crate::dom::NodeId>; 3],
    made: std::collections::HashSet<crate::dom::NodeId>,
    inserted: Vec<crate::dom::NodeId>,
    reused: Vec<crate::dom::NodeId>,
}

impl Live {
    // The skeleton element a start tag of `local` (in the HTML namespace) takes the place of — the first of its name,
    // where the document has one.
    fn reuse(&mut self, ns: i32, local: &str) -> Option<crate::dom::NodeId> {
        let k = ["html", "head", "body"].iter().position(|&n| n == local).filter(|_| namespace_of(ns) == html5ever::ns!(html))?;
        let node = self.skeleton[k].take()?;
        self.reused.push(node);
        Some(node)
    }
}

impl<'s> Build<'s> {
    fn node(&self, handle: i32) -> Option<crate::dom::NodeId> {
        self.nodes.get(handle as usize).copied().flatten()
    }
    fn set(&mut self, handle: i32, id: crate::dom::NodeId) {
        let at = handle as usize;
        if self.nodes.len() <= at {
            self.nodes.resize(at + 1, None);
        }
        self.nodes[at] = Some(id);
    }
    // A new node of `data`, in the parse's node document.
    pub(crate) fn make(&mut self, scope: &mut v8::PinScope<'s, '_>, data: crate::dom::NodeData) -> crate::dom::NodeId {
        let id = crate::dom::realm(scope, self.cid).create(data, None);
        if let Some(live) = self.live.as_mut() {
            live.made.insert(id);
        }
        self.held.push(crate::node_handle::bare(scope, id, self.doc, self.maker));
        id
    }
    // An element of the parser's token: its attributes — the first of a name taken, as "create an element for the token"
    // appends them — written as any element's are (`replace_attributes`), a namespaced one's names with them; its `is`
    // value; the steps its attributes have that are the bindings'. A name holding a stand-in of a lone surrogate is the
    // page's again exactly (`name_u16`), beside its lossy interned one — Chrome's and Firefox's `<a\uD800>` keeps it.
    fn element(&mut self, scope: &mut v8::PinScope<'s, '_>, ns: i32, local: &str, attrs: Vec<(String, i32, String, String)>) -> crate::dom::NodeId {
        let ns = arena_namespace(ns);
        let (local_name, name_u16) = if self.standins.in_text(local) {
            let units = self.standins.units(local);
            let exact = crate::dom::ExactName { ns: ns.encode_utf16().collect(), local: units.clone(), prefix: None };
            (web_atoms::LocalName::from(String::from_utf16_lossy(&units)), Some(Box::new(exact)))
        } else {
            (web_atoms::LocalName::from(local), None)
        };
        let id = self.make(scope, crate::dom::NodeData {
            local_name,
            ns,
            name_u16,
            ..crate::dom::NodeData::of_kind(crate::dom::NodeKind::Element, Vec::new())
        });
        self.stamp_registry(scope, id);
        self.attributes(scope, id, attrs, Vec::new());
        self.is_value(scope, id);
        id
    }
    // HTML "create an element for the token" where it will execute script — a live document's, whose window registry
    // defines a custom element of the token's name: its constructor run now, as the parser makes it (a page's hook,
    // which holds the document's throw-on-dynamic-markup-insertion counter while it runs) — not where the element goes
    // into template contents, or under a node of the null registry. The element, and whether it is custom (a constructor
    // that failed leaves an HTMLUnknownElement); None where no constructor runs. `rest` the steps after the token's.
    fn construct(&mut self, scope: &mut v8::PinScope<'s, '_>, ns: i32, local: &str, handle: i32, rest: &[Operand]) -> Option<(crate::dom::NodeId, bool)> {
        if !self.live.as_ref().is_some_and(|l| l.ce_defined) || namespace_of(ns) != html5ever::ns!(html) || !local.contains('-') {
            return None;
        }
        // (…a name holding a stand-in of a lone surrogate looked up exactly, as the registry keys it)
        let exact = self.standins.in_text(local).then(|| crate::ce_reactions::name_key(&self.standins.units(local)));
        if !crate::dom::dom(scope).arena.ce_reactions.defines(self.cid, exact.as_deref().unwrap_or(local)) {
            return None;
        }
        let (parent, based) = insertion_parent(rest, handle)?;
        let parent = match based {
            // (…a foster parent: the table's parent, where it has one, else the element before it)
            Some(prev) if prev >= 0 => crate::dom::realm(scope, self.cid).parent_of(self.node(parent)?).or_else(|| self.node(prev))?,
            Some(_) => crate::dom::realm(scope, self.cid).parent_of(self.node(parent)?)?,
            None => self.node(parent)?,
        };
        if self.in_template_contents(scope, parent) {
            return None;
        }
        let registry = crate::dom::dom(scope).arena.get(parent).and_then(|n| n.link.handle().map(crate::node_handle::NodeHandle::registry));
        if registry.is_some_and(|r| r == crate::ce_reactions::NULL || r == crate::ce_reactions::TRACKING) {
            return None;
        }
        let hook = v8::String::new(scope, "__csimConstructParsedElement")?;
        let global = scope.get_current_context().global(scope);
        let hook = v8::Local::<v8::Function>::try_from(global.get(scope, hook.into())?).ok()?;
        let name = page_string(scope, local, &self.standins)?;
        let doc: v8::Local<'_, v8::Value> = self.doc.map_or_else(|| v8::null(scope).into(), Into::into);
        let made = hook.call(scope, global.into(), &[name.into(), doc])?;
        let made = v8::Local::<v8::Array>::try_from(made).ok()?;
        let element = made.get_index(scope, 0)?;
        let custom = made.get_index(scope, 1).is_some_and(|c| c.is_true());
        let id = crate::node_handle::nid_of(scope, element)?;
        // (…held until a tree holds it, as every node the build made)
        let held = crate::dom::dom(scope).arena.get(id).and_then(|n| crate::node_handle::holding(&n.link))?;
        self.held.push(held);
        if let Some(live) = self.live.as_mut() {
            live.made.insert(id);
        }
        Some((id, custom))
    }
    // HTML's declarative shadow root steps for a `<template shadowrootmode>` (the bindings', a hook: dom-nodes.js
    // `attachDeclarativeShadow`): the shadow root they attached to `host`, as its attributes ask — none where the host
    // takes none.
    fn attach_shadow(&mut self, scope: &mut v8::PinScope<'s, '_>, host: crate::dom::NodeId, template: crate::dom::NodeId) -> Option<crate::dom::NodeId> {
        let hook = v8::String::new(scope, "__csimAttachParsedShadow")?;
        let global = scope.get_current_context().global(scope);
        let hook = v8::Local::<v8::Function>::try_from(global.get(scope, hook.into())?).ok()?;
        let host = crate::dom::node_value(scope, Some(host));
        let template = crate::dom::node_value(scope, Some(template));
        if crate::dom::factory_threw(scope) {
            return None;
        }
        let root = hook.call(scope, global.into(), &[host, template])?;
        crate::node_handle::nid_of(scope, root)
    }
    // …and the token's attributes appended to what its constructor made — attributes it set kept, the first of a name
    // taken — each an attributeChanged reaction of a custom one, run as it is made (the page's hook).
    fn constructed(&mut self, scope: &mut v8::PinScope<'s, '_>, id: crate::dom::NodeId, attrs: Vec<(String, i32, String, String)>, custom: bool) {
        let existing = crate::dom::realm(scope, self.cid).get(id).map_or_else(Vec::new, |n| n.attributes.clone());
        self.attributes(scope, id, attrs, existing);
        if !custom {
            return;
        }
        let element = crate::dom::node_value(scope, Some(id));
        let Some(hook) = v8::String::new(scope, "__csimParsedElementReactions") else { return };
        let global = scope.get_current_context().global(scope);
        let Some(hook) = global.get(scope, hook.into()).and_then(|h| v8::Local::<v8::Function>::try_from(h).ok()) else { return };
        hook.call(scope, global.into(), &[element]);
    }
    // An HTML element's `is` attribute its `is` value — fixed as "create an element" makes it.
    pub(crate) fn is_value(&mut self, scope: &mut v8::PinScope<'s, '_>, id: crate::dom::NodeId) {
        if crate::dom::realm(scope, self.cid).get(id).is_some_and(|n| n.ns == web_atoms::ns!(html)) {
            let arena = crate::dom::realm(scope, self.cid);
            let is = arena.get(id).and_then(|n| n.plain_attr("is").map(|v| v.encode_utf16().collect::<Vec<u16>>()));
            if let Some(is) = is {
                if let Some(n) = arena.get_mut_quietly(id) {
                    n.is_value = Some(is.into_boxed_slice());
                }
                let had = arena.get(id).map_or(0, |n| n.state);
                arena.set_state(id, had | crate::dom::STATE_IS_VALUE);
            }
        }
    }
    // `attrs` (prefix, namespace code, local name, value) given to `id` after `existing` — none already there taken
    // again — and the steps they have that are the bindings'.
    fn attributes(&mut self, scope: &mut v8::PinScope<'s, '_>, id: crate::dom::NodeId, attrs: Vec<(String, i32, String, String)>, existing: Vec<(String, String)>) {
        self.null_registry(scope, id, &attrs);
        // (…a name holding a stand-in of a lone surrogate lossy, as a page's write of one is: the attribute list keeps no
        // exact name of its own)
        let lossy = |name: String| if self.standins.in_text(&name) { String::from_utf16_lossy(&self.standins.units(&name)) } else { name };
        let named = attrs.into_iter().map(|(prefix, ns, local, value)| {
            let (prefix, local) = (lossy(prefix), lossy(local));
            let name = if prefix.is_empty() { local.clone() } else { format!("{prefix}:{local}") };
            (name, value, (ns != 0).then(|| (attribute_namespace(ns).to_owned(), local)))
        });
        self.named_attributes(scope, id, named.collect(), existing);
    }
    // …(name, value, namespace and local name where it has a namespace).
    #[allow(clippy::type_complexity)]
    pub(crate) fn named_attributes(&mut self, scope: &mut v8::PinScope<'s, '_>, id: crate::dom::NodeId, attrs: Vec<(String, String, Option<(String, String)>)>, existing: Vec<(String, String)>) {
        // (…a value holding a stand-in kept exactly beside its lossy text, as a page's write of one is: `attr_u16`)
        let (mut namespaced, mut exact) =
            crate::dom::realm(scope, self.cid).get(id).map_or_else(Default::default, |n| (n.attr_ns.clone(), n.attr_u16.clone()));
        let mut list = existing;
        exact.retain(|(k, _)| list.iter().any(|(name, _)| name == k));
        let mut names = Vec::new();
        for (name, value, ns) in attrs {
            if list.iter().any(|(k, _)| *k == name) {
                continue;
            }
            if let Some((ns, local)) = ns {
                namespaced.push((name.clone(), ns, local));
            }
            if crate::cloning::bindings_steps(&name) || matches!(name.as_str(), "autofocus") {
                names.push(name.clone());
            }
            let value = if self.standins.in_text(&value) {
                let units = self.standins.units(&value);
                let lossy = String::from_utf16_lossy(&units);
                exact.push((name.clone(), units));
                lossy
            } else {
                value
            };
            list.push((name, value));
        }
        crate::dom::replace_attributes(scope, self.cid, id, list, exact, Some((namespaced, Vec::new())));
        if !names.is_empty() {
            self.steps.push((id, names, 0));
        }
    }
    // `child` into `parent` before `before` (none: last) — its node document the inert one where `parent` is in template
    // contents — and what the parser making it gives it (`script_made`).
    pub(crate) fn insert(&mut self, scope: &mut v8::PinScope<'s, '_>, parent: crate::dom::NodeId, child: crate::dom::NodeId, before: Option<crate::dom::NodeId>) {
        // (…a live document's as any insertion into it: its style engine told, its ranges, slots and insertion steps)
        if let Some(live) = self.live.as_ref() {
            let observed = live.observed;
            crate::dom::insert_nodes(scope, self.cid, parent, &[child], before);
            if observed {
                crate::mutation::record_child_list(scope, self.maker, parent, &[child], &[], None, None);
            }
        } else {
            crate::dom::realm(scope, self.cid).insert_child(parent, child, before);
        }
        self.inherit_registry(scope, parent, child);
        let contents = self.in_template_contents(scope, parent);
        if let Some(live) = self.live.as_mut().filter(|_| !contents) {
            let arena = crate::dom::realm(scope, self.cid);
            if arena.is_element(child) && arena.parent_of(child) == Some(parent) {
                live.inserted.push(child);
                // (…a custom element it constructed: HTML "insert an element at the adjusted insertion location" pops
                // the element queue it pushed, its connectedCallback before the next start tag's constructor — a pause)
                if live.made.contains(&child) && arena.get(child).is_some_and(|n| n.state & crate::dom::STATE_CUSTOM != 0) {
                    self.paused = Some(Pause::CustomElement);
                } else if live.browsing_context && select_node(arena, child, false) {
                    self.paused = Some(Pause::Select(child, false));
                }
            }
        }
        if contents && self.in_contents.insert(child) {
            let handle = crate::dom::realm(scope, self.cid).get(child).and_then(|n| n.link.handle().map(|h| h as *const crate::node_handle::NodeHandle));
            // SAFETY: the node's handle lives while the build holds it, which it does every node it made.
            if let Some(h) = handle {
                unsafe { &*h }.set_document(scope, self.template_doc);
            }
        }
        self.script_made(scope, child, contents);
        // (…an open details element with a name closed where its tree has another of its name group open: its
        // insertion steps, HTML "ensure details exclusivity by closing the given element if needed" — its `open`
        // removed now, its record among the insertion's and what a constructor after it sees; its toggle the bindings')
        let arena = crate::dom::realm(scope, self.cid);
        let open_named = arena.get(child).is_some_and(|n| n.is_html_named("details") && n.plain_attr("open").is_some() && n.plain_attr("name").is_some_and(|v| !v.is_empty()));
        if open_named && !arena.open_details_in_group(child).is_empty() {
            self.close_details(scope, child);
        }
    }
    // A `customelementregistry` attribute the parser gives an element: its registry the null one, which the elements the
    // parser inserts under it take after it — where it makes the element, and where a later `<body>` or `<html>` tag adds
    // it to the one there (Chrome 155: the body's registry null, and an element parsed into it after not defined).
    fn null_registry(&self, scope: &mut v8::PinScope<'s, '_>, id: crate::dom::NodeId, attrs: &[(String, i32, String, String)]) {
        if names_null_registry(attrs) {
            if let Some(handle) = crate::dom::realm(scope, self.cid).get(id).and_then(|n| n.link.handle()) {
                handle.set_registry_state(crate::ce_reactions::NULL);
            }
        }
    }
    // …the registry association the build's elements take, given to one it made (`registry`).
    fn stamp_registry(&self, scope: &mut v8::PinScope<'s, '_>, id: crate::dom::NodeId) {
        let Some((code, object)) = self.registry else { return };
        let handle = crate::dom::realm(scope, self.cid).get(id).and_then(|n| n.link.handle().map(|h| h as *const crate::node_handle::NodeHandle));
        // SAFETY: the node's handle lives while the build holds it, which it does every node it made.
        if let Some(h) = handle {
            unsafe { &*h }.set_registry(scope, code, object);
        }
    }
    // The parser's registry for an element it inserts under a node of a null one — its intended parent's, which "create
    // an element for the token" looks a definition up in: the tracking null passed on, the null registry given to one
    // that has none set but the build's own (`registry`: a declarative shadow root of the null registry in a scoped
    // context's fragment holds elements of none, Chrome 155) — and a scoped one, a declarative shadow root's that a
    // script of its own initialized, given to one that has none set.
    fn inherit_registry(&self, scope: &mut v8::PinScope<'s, '_>, parent: crate::dom::NodeId, child: crate::dom::NodeId) {
        let d = crate::dom::dom(scope);
        let arena = d.arena.enter(self.cid);
        let from = arena.get(parent).and_then(|n| n.link.handle()).map(|h| h as *const crate::node_handle::NodeHandle);
        let to = arena.get(child).filter(|n| n.kind == crate::dom::NodeKind::Element).and_then(|n| n.link.handle()).map(|h| h as *const crate::node_handle::NodeHandle);
        let (Some(from), Some(to)) = (from, to) else { return };
        // SAFETY: both handles live while the build holds the nodes, which it does every node it made and their parents.
        let (from, to) = unsafe { (&*from, &*to) };
        let stamped = self.registry.is_some_and(|(code, _)| code == to.registry());
        match from.registry() {
            crate::ce_reactions::TRACKING => to.set_registry_state(crate::ce_reactions::TRACKING),
            crate::ce_reactions::NULL if to.registry() == 0 || stamped => to.set_registry_state(crate::ce_reactions::NULL),
            code if code >= crate::ce_reactions::FIRST_REGISTRY && to.registry() == 0 && !d.arena.ce_reactions.is_window_registry(code) => {
                let object = from.registry_object(scope);
                to.set_registry(scope, code, object);
            }
            _ => {}
        }
    }
    // What the parser making `node` gives it, a script's flags: no longer "force async", and the build's own — in
    // template `contents` (`contents_script`) or out of them (`script`).
    pub(crate) fn script_made(&mut self, scope: &mut v8::PinScope<'s, '_>, node: crate::dom::NodeId, contents: bool) {
        let arena = crate::dom::realm(scope, self.cid);
        let Some(n) = arena.get(node) else { return };
        let script = &*n.local_name == "script" && (n.ns == web_atoms::ns!(html) || n.ns == web_atoms::ns!(svg));
        let started = n.script_flags & (crate::script::SCRIPT_ALREADY_STARTED | crate::script::SCRIPT_PARSER_INSERTED) != 0;
        if script && !started {
            if let Some(n) = arena.get_mut_quietly(node) {
                n.script_flags |= crate::script::SCRIPT_NOT_FORCE_ASYNC | if contents { self.contents_script } else { self.script };
            }
        }
    }
    // Text into `parent` before `before` (none: last): into the text node there before it, where there is one.
    fn text(&mut self, scope: &mut v8::PinScope<'s, '_>, parent: crate::dom::NodeId, text: &str, before: Option<crate::dom::NodeId>) {
        let arena = crate::dom::realm(scope, self.cid);
        let prev = match before {
            Some(b) => arena.sibling(b, -1),
            None => arena.get(parent).and_then(|p| p.children.last().copied()),
        };
        if let Some(t) = prev.filter(|&t| arena.get(t).is_some_and(|n| n.kind == crate::dom::NodeKind::Text)) {
            // (…a live document's text of an earlier batch the page's already: its data changed as any write does)
            if self.live.as_ref().is_some_and(|l| !l.made.contains(&t)) {
                let at = arena.get(t).map_or(0, |n| n.data.len());
                let object = crate::dom::node_value(scope, Some(t));
                let Some(more) = page_string(scope, text, &self.standins).filter(|_| !crate::dom::factory_threw(scope)) else { return };
                let _ = crate::character_data::replace_data(scope, self.maker, t, object, at, 0, more);
                return;
            }
            let units = self.standins.units(text);
            if let Some(n) = crate::dom::realm(scope, self.cid).get_mut_quietly(t) {
                n.data.extend(units);
            }
            return;
        }
        let t = self.make(scope, crate::dom::NodeData::of_kind(crate::dom::NodeKind::Text, self.standins.units(text)));
        self.insert(scope, parent, t, before);
    }

    // `flags` added to those the bindings run for `id` — the element last made, whose entry is the last one where it has
    // one.
    // A details element the parser's insertion steps close: its `open` removed — as any removal, its record queued — and
    // its toggle the bindings' to queue (`BUILT_CLOSED`: the `open` it was made with, then none).
    pub(crate) fn close_details(&mut self, scope: &mut v8::PinScope<'s, '_>, id: crate::dom::NodeId) {
        crate::attributes::remove_plain(scope, self.cid, self.maker, id, "open");
        self.flag(id, BUILT_CLOSED);
    }
    pub(crate) fn flag(&mut self, id: crate::dom::NodeId, flags: u32) {
        match self.steps.iter_mut().rev().find(|(e, ..)| *e == id) {
            Some((_, _, had)) => *had |= flags,
            None => self.steps.push((id, Vec::new(), flags)),
        }
    }
    // Whether `id` is a template's contents the build made.
    pub(crate) fn is_contents(&self, id: crate::dom::NodeId) -> bool {
        self.contents.contains(&id)
    }
    // Whether `node` is in template contents: one the build made — or, a live document's, whose batches go on from where
    // an earlier one left a template open, one whose node document is not the page's: the inert one template contents
    // are in (a fragment a script moved an open element into is the page's).
    fn in_template_contents(&self, scope: &mut v8::PinScope<'s, '_>, node: crate::dom::NodeId) -> bool {
        if self.live.is_none() || self.in_contents.contains(&node) {
            return self.in_contents.contains(&node);
        }
        let handle = crate::dom::realm(scope, self.cid).get(node).and_then(|n| n.link.handle().map(|h| h as *const crate::node_handle::NodeHandle));
        // SAFETY: the node's handle lives while its node is in the arena, which this reads before anything allocates.
        let document = handle.and_then(|h| unsafe { &*h }.document(scope));
        match (document, self.doc) {
            (Some(document), Some(page)) => !document.strict_equals(page.into()),
            _ => false,
        }
    }
    // `node` out of its parent — a live document's as any removal from it.
    fn take_out(&mut self, scope: &mut v8::PinScope<'s, '_>, node: crate::dom::NodeId) {
        if let Some(live) = self.live.as_ref() {
            let observed = live.observed;
            let arena = crate::dom::realm(scope, self.cid);
            let (parent, siblings) = (arena.parent_of(node), (arena.sibling(node, -1), arena.sibling(node, 1)));
            crate::dom::take_out(scope, self.cid, node);
            if let Some(parent) = parent.filter(|_| observed) {
                crate::mutation::record_child_list(scope, self.maker, parent, &[], &[node], Some(siblings), None);
            }
        } else {
            crate::dom::realm(scope, self.cid).detach(node);
        }
    }
    // A reused skeleton element given the start tag's attributes in place of those it had, and its `is` value.
    fn reset(&mut self, scope: &mut v8::PinScope<'s, '_>, el: crate::dom::NodeId, attrs: Vec<(String, i32, String, String)>) {
        crate::dom::replace_attributes(scope, self.cid, el, Vec::new(), Vec::new(), Some((Vec::new(), Vec::new())));
        let arena = crate::dom::realm(scope, self.cid);
        if let Some(n) = arena.get_mut_quietly(el) {
            n.is_value = None;
        }
        let had = arena.get(el).map_or(0, |n| n.state);
        arena.set_state(el, had & !crate::dom::STATE_IS_VALUE);
        self.attributes(scope, el, attrs, Vec::new());
        self.is_value(scope, el);
    }
    // A template's contents: a fragment of their own, in the inert document, with template contents' null registry.
    pub(crate) fn contents_of(&mut self, scope: &mut v8::PinScope<'s, '_>, template: crate::dom::NodeId) -> crate::dom::NodeId {
        let frag = crate::dom::realm(scope, self.cid).create(crate::dom::NodeData::of_kind(crate::dom::NodeKind::Fragment, Vec::new()), None);
        let held = crate::node_handle::bare(scope, frag, self.template_doc, self.maker);
        if let Some(h) = held.get() {
            h.set_registry_state(crate::ce_reactions::TRACKING);
        }
        self.held.push(held);
        self.in_contents.insert(frag);
        self.contents.push(frag);
        crate::dom::realm(scope, self.cid).set_template_content(template, Some(frag));
        frag
    }

    // Take the parser's steps — up to where it pauses (`paused`): the steps left.
    fn take(&mut self, scope: &mut v8::PinScope<'s, '_>, mut ops: std::vec::IntoIter<Operand>) -> Option<std::vec::IntoIter<Operand>> {
        let int = |o: Option<Operand>| match o {
            Some(Operand::Int(i)) => Some(i),
            _ => None,
        };
        let string = |o: Option<Operand>| match o {
            Some(Operand::Str(s)) => Some(s),
            _ => None,
        };
        let attrs = |ops: &mut std::vec::IntoIter<Operand>| -> Option<Vec<(String, i32, String, String)>> {
            let n = int(ops.next())?;
            (0..n).map(|_| Some((string(ops.next())?, int(ops.next())?, string(ops.next())?, string(ops.next())?))).collect()
        };
        while let Some(op) = self.paused.is_none().then(|| ops.next()).flatten() {
            let Operand::Int(op) = op else { return None };
            match op {
                OP_ELEMENT => {
                    let (handle, ns, local) = (int(ops.next())?, int(ops.next())?, string(ops.next())?);
                    let list = attrs(&mut ops)?;
                    let contents = int(ops.next())?;
                    let reused = self.live.as_mut().and_then(|l| l.reuse(ns, &local));
                    let constructed = match reused {
                        None if !names_null_registry(&list) => self.construct(scope, ns, &local, handle, ops.as_slice()),
                        _ => None,
                    };
                    let el = match (reused, constructed) {
                        (Some(el), _) => {
                            self.reset(scope, el, list);
                            el
                        }
                        (None, Some((el, custom))) => {
                            self.constructed(scope, el, list, custom);
                            el
                        }
                        (None, None) => self.element(scope, ns, &local, list),
                    };
                    self.set(handle, el);
                    if contents != 0 {
                        let frag = self.contents_of(scope, el);
                        self.set(contents, frag);
                    }
                }
                OP_COMMENT => {
                    let (handle, text) = (int(ops.next())?, string(ops.next())?);
                    let c = self.make(scope, crate::dom::NodeData::of_kind(crate::dom::NodeKind::Comment, self.standins.units(&text)));
                    self.set(handle, c);
                }
                OP_APPEND => {
                    let (parent, child) = (self.node(int(ops.next())?)?, self.node(int(ops.next())?)?);
                    self.insert(scope, parent, child, None);
                }
                OP_APPEND_TEXT => {
                    let (parent, text) = (self.node(int(ops.next())?)?, string(ops.next())?);
                    self.text(scope, parent, &text, None);
                }
                // (…the foster parent: before the table, where it has a parent, else into the element before it on the
                // stack of open elements)
                OP_APPEND_BASED | OP_APPEND_BASED_TEXT => {
                    let (el, prev) = (self.node(int(ops.next())?)?, self.node(int(ops.next())?)?);
                    let parent = crate::dom::realm(scope, self.cid).parent_of(el);
                    let (to, before) = match parent {
                        Some(p) => (p, Some(el)),
                        None => (prev, None),
                    };
                    if op == OP_APPEND_BASED_TEXT {
                        let text = string(ops.next())?;
                        self.text(scope, to, &text, before);
                    } else {
                        let child = self.node(int(ops.next())?)?;
                        self.insert(scope, to, child, before);
                    }
                }
                OP_INSERT_BEFORE | OP_INSERT_TEXT_BEFORE => {
                    let sibling = self.node(int(ops.next())?)?;
                    let parent = crate::dom::realm(scope, self.cid).parent_of(sibling);
                    if op == OP_INSERT_TEXT_BEFORE {
                        let text = string(ops.next())?;
                        if let Some(p) = parent {
                            self.text(scope, p, &text, Some(sibling));
                        }
                    } else {
                        let child = self.node(int(ops.next())?)?;
                        if let Some(p) = parent {
                            self.insert(scope, p, child, Some(sibling));
                        }
                    }
                }
                // (…a second `<html>` or `<body>` start tag: the attributes its element does not have yet added to it, an
                // observer's record of each in the token's order, as DOM "append an attribute" queues them — Chrome)
                OP_ADD_ATTRS => {
                    let id = self.node(int(ops.next())?)?;
                    let list = attrs(&mut ops)?;
                    let existing = crate::dom::realm(scope, self.cid).get(id).map_or_else(Vec::new, |n| n.attributes.clone());
                    let observed = self.live.as_ref().is_some_and(|l| l.observed) && !self.in_template_contents(scope, id);
                    let mut added: Vec<String> = Vec::new();
                    if observed {
                        for (prefix, _, local, _) in &list {
                            let name = if prefix.is_empty() { local.clone() } else { format!("{prefix}:{local}") };
                            if !existing.iter().any(|(k, _)| *k == name) && !added.contains(&name) {
                                added.push(name);
                            }
                        }
                    }
                    self.attributes(scope, id, list, existing);
                    for name in added {
                        let target = crate::dom::node_value(scope, Some(id));
                        let null: v8::Local<'_, v8::Value> = v8::null(scope).into();
                        let name = page_string(scope, &name, &self.standins).map_or(null, Into::into);
                        let kind = v8::Integer::new(scope, 1).into();
                        crate::mutation_observers::queue_record(scope, self.cid, id, &[kind, target, null, null, null, null, name, null, null]);
                    }
                }
                OP_REMOVE => {
                    let id = self.node(int(ops.next())?)?;
                    self.take_out(scope, id);
                }
                OP_REPARENT => {
                    let (node, to) = (self.node(int(ops.next())?)?, self.node(int(ops.next())?)?);
                    let kids = crate::dom::realm(scope, self.cid).get(node).map_or_else(Vec::new, |n| n.children.clone());
                    for c in kids {
                        self.take_out(scope, c);
                        self.insert(scope, to, c, None);
                    }
                }
                // (…a select closed: its options set up — in a document with a browsing context by its connection, out of
                // template contents)
                OP_POP => {
                    let id = self.node(int(ops.next())?)?;
                    let connected = self.live.as_ref().is_some_and(|l| l.browsing_context) && !self.in_template_contents(scope, id);
                    let arena = crate::dom::realm(scope, self.cid);
                    if !connected && arena.get(id).is_some_and(|n| n.is_html_named("select")) {
                        self.steps.push((id, Vec::new(), BUILT_SELECT));
                    } else if connected && select_node(arena, id, true) {
                        self.paused = Some(Pause::Select(id, true));
                    }
                }
                OP_FORM => {
                    let (el, form) = (self.node(int(ops.next())?)?, int(ops.next())?);
                    let arena = crate::dom::realm(scope, self.cid);
                    let associated = arena.get(el).is_some_and(|n| n.ns == web_atoms::ns!(html) && FORM_ASSOCIATED.contains(&&*n.local_name) && n.plain_attr("form").is_none());
                    if associated {
                        let form = self.nodes.get(form as usize).copied().flatten();
                        crate::dom::realm(scope, self.cid).set_parser_form_owner(el, form);
                    }
                }
                OP_SELECTED_CONTENT => {
                    int(ops.next())?;
                }
                OP_SCRIPT_STARTED => {
                    let id = self.node(int(ops.next())?)?;
                    if let Some(n) = crate::dom::realm(scope, self.cid).get_mut_quietly(id) {
                        n.script_flags = (n.script_flags | crate::script::SCRIPT_ALREADY_STARTED | crate::script::SCRIPT_NOT_FORCE_ASYNC) & !crate::script::SCRIPT_PARSER_INSERTED;
                    }
                }
                // (…a document's doctype and mode — none in a fragment parse — and no declarative shadow root)
                // (…appended whatever the document holds already — a doctype a script appended before a `document.write` of
                // another: HTML §13.2.6.4.1 "append a DocumentType node", with no check, as Firefox does; Chrome keeps one)
                OP_DOCTYPE => {
                    let (name, public, system) = (string(ops.next())?, string(ops.next())?, string(ops.next())?);
                    let doc = self.node(0)?;
                    let ids = Some(Box::new((self.standins.units(&public), self.standins.units(&system))));
                    let dt = self.make(scope, crate::dom::NodeData { doctype_ids: ids, ..crate::dom::NodeData::of_kind(crate::dom::NodeKind::Other, self.standins.units(&name)) });
                    self.insert(scope, doc, dt, None);
                }
                OP_QUIRKS => self.quirks = Some(int(ops.next())?),
                // (…a declarative shadow root attached to its host — the template not inserted, the root what its
                // contents go into — or, where the host takes none, the template inserted, its contents theirs)
                OP_SHADOW_ROOT => {
                    let (host, template, root, parent) = (self.node(int(ops.next())?)?, self.node(int(ops.next())?)?, int(ops.next())?, int(ops.next())?);
                    let into = match self.attach_shadow(scope, host, template) {
                        Some(shadow) => {
                            if self.live.is_none() {
                                self.shadows.push(shadow);
                            }
                            shadow
                        }
                        None => {
                            let parent = self.node(parent)?;
                            self.insert(scope, parent, template, None);
                            crate::dom::realm(scope, self.cid).get(template).and_then(|n| n.template_content)?
                        }
                    };
                    self.set(root, into);
                }
                _ => return None,
            }
        }
        Some(ops)
    }
}

// __dom.htmlParseFragment(html, wellFormed, contextNs, contextLocalName, formNid, quirks, document, templateDocument,
// declarative, registry, registryObject) -> [count, nodes…, element, names, flags, …]: HTML's fragment
// parsing algorithm in the context of an element (its namespace as `ns_code` numbers it, its local name; the nearest form
// its form element pointer, -1 for none; its document's mode, as `htmlParse` takes it), built by the engine — the nodes
// in `document`, those in template contents in `templateDocument` — and answered as the parse's top-level nodes, out
// of any parent, then the elements the bindings have steps for (`BUILT_*`), each with the names of its attributes whose
// steps are theirs (undefined for none). With `declarative` (setHTMLUnsafe's), the declarative shadow roots the markup
// makes are attached; with a `registry` code (ce_reactions.rs: 0 none), the context's registry association, which every
// element made takes — `registryObject` the registry it names. [-1] for a parse a panic wound down.
fn html_parse_fragment(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    parser_op(scope, None, &mut rv, &[-1], |scope, rv| {
        let mut standins = StandIns::default();
        let well_formed = args.get(1).boolean_value(scope);
        let html = parser_text(scope, args.get(0), well_formed, &mut standins);
        let ns = args.get(2).int32_value(scope).unwrap_or(1);
        let local = args.get(3).to_rust_string_lossy(scope);
        let form = crate::dom::nid_arg(scope, &args, 4);
        let opts = TreeBuilderOpts { scripting_enabled: true, quirks_mode: quirks_mode(args.get(5).int32_value(scope)), ..Default::default() };
        let name = QualName::new(None, namespace_of(ns), LocalName::from(local.as_str()));
        let declarative = args.get(8).boolean_value(scope);
        let builder = TreeBuilder::new_for_fragment(Sink::new(Some(name), declarative), 1, form.is_some().then_some(2), opts);
        let initial_state = Some(builder.tokenizer_state_for_context_elem(true));
        let tokenizer = Tokenizer::new(builder, TokenizerOpts { initial_state, discard_bom: false, ..Default::default() });
        let cid = crate::dom::realm_id(scope, &args);
        // (…re-rooted in this scope, as the build's other handles are)
        let doc = v8::Local::<v8::Object>::try_from(args.get(6)).ok().map(|d| v8::Local::new(scope, d));
        let template_doc = v8::Local::<v8::Object>::try_from(args.get(7)).ok().map(|d| v8::Local::new(scope, d)).or(doc);
        let mut build = Build::new(cid, doc, template_doc, vec![None, None, form]);
        build.contents_script = crate::script::SCRIPT_ALREADY_STARTED;
        let registry = args.get(9).uint32_value(scope).unwrap_or(0);
        let registry_object = v8::Local::<v8::Object>::try_from(args.get(10)).ok().map(|r| v8::Local::new(scope, r));
        build.registry = (registry != 0).then_some((registry, registry_object));
        let ops = parsed(tokenizer, html);
        build.standins = standins;
        let root = build.make(scope, crate::dom::NodeData::of_kind(crate::dom::NodeKind::Fragment, Vec::new()));
        build.set(0, root);
        if build.take(scope, ops.into_iter()).is_none() {
            return;
        }
        build.finish(scope, None);
        // (…the parse's nodes: the children of the root `<html>` it made, taken out of it)
        let arena = crate::dom::realm(scope, cid);
        let html_root = arena.get(root).and_then(|n| n.children.first().copied());
        let tops = html_root.and_then(|h| arena.get(h)).map_or_else(Vec::new, |n| n.children.clone());
        for &t in &tops {
            arena.detach(t);
        }
        if let Some(out) = build.answer(scope, &tops) {
            rv.set(v8::Array::new_with_elements(scope, &out).into());
        }
    });
}

// __dom.htmlParseDocument(html, wellFormed, document, templateDocument, declarative) -> [quirks, element, names, flags,
// …] ([-2] for a parse a panic wound down): HTML's parse of a whole document no script runs in
// (DOMParser's, scripting off), built by the engine into `document` (empty) as a fragment parse is (`htmlParseFragment`)
// — its doctype too, and with `declarative` (parseHTMLUnsafe's) its declarative shadow roots — answered as the mode it
// set (`htmlParse`'s numbers, -1 for none) and the elements the bindings have steps for.
fn html_parse_document(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    parser_op(scope, None, &mut rv, &[-2], |scope, rv| {
        let mut standins = StandIns::default();
        let well_formed = args.get(1).boolean_value(scope);
        let html = parser_text(scope, args.get(0), well_formed, &mut standins);
        let Some(document) = crate::node_handle::nid_of(scope, args.get(2)) else { return };
        let opts = TreeBuilderOpts { scripting_enabled: false, ..Default::default() };
        let declarative = args.get(4).boolean_value(scope);
        let tokenizer = Tokenizer::new(TreeBuilder::new(Sink::new(None, declarative), opts), TokenizerOpts { discard_bom: false, ..Default::default() });
        let cid = crate::dom::realm_id(scope, &args);
        let doc = v8::Local::<v8::Object>::try_from(args.get(2)).ok().map(|d| v8::Local::new(scope, d));
        let template_doc = v8::Local::<v8::Object>::try_from(args.get(3)).ok().map(|d| v8::Local::new(scope, d)).or(doc);
        let ops = parsed(tokenizer, html);
        let mut build = Build::new(cid, doc, template_doc, vec![Some(document), None, None]);
        build.standins = standins;
        if build.take(scope, ops.into_iter()).is_none() {
            return;
        }
        build.finish(scope, Some(document));
        let quirks = build.quirks.unwrap_or(-1);
        if let Some(mut out) = build.answer(scope, &[]) {
            out[0] = v8::Integer::new(scope, quirks).into();
            rv.set(v8::Array::new_with_elements(scope, &out).into());
        }
    });
}

// A document mode as `htmlParse` numbers it.
fn quirks_mode(code: Option<i32>) -> QuirksMode {
    match code {
        Some(2) => QuirksMode::Quirks,
        Some(1) => QuirksMode::LimitedQuirks,
        _ => QuirksMode::NoQuirks,
    }
}
// The steps of a parse of `html` run to its end — a fragment's or a scriptless document's: no script runs anywhere.
fn parsed(tokenizer: Tokenizer<TreeBuilder<u32, Sink>>, html: String) -> Vec<Operand> {
    let input = BufferQueue::default();
    input.push_back(StrTendril::from(html));
    while let TokenizerResult::Script(_) | TokenizerResult::EncodingIndicator(_) = tokenizer.feed(&input) {}
    tokenizer.end();
    std::mem::take(&mut *tokenizer.sink.sink.ops.borrow_mut())
}

impl<'s> Build<'s> {
    pub(crate) fn new(cid: i32, doc: Option<v8::Local<'s, v8::Object>>, template_doc: Option<v8::Local<'s, v8::Object>>, nodes: Vec<Option<crate::dom::NodeId>>) -> Build<'s> {
        Build {
            cid,
            maker: cid,
            doc,
            template_doc,
            nodes,
            held: Vec::new(),
            in_contents: std::collections::HashSet::new(),
            contents: Vec::new(),
            shadows: Vec::new(),
            steps: Vec::new(),
            quirks: None,
            script: crate::script::SCRIPT_ALREADY_STARTED,
            contents_script: 0,
            live: None,
            registry: None,
            paused: None,
            standins: StandIns::default(),
        }
    }
    // The insertion steps of the engine's own over what no later insertion runs them for — a document's children, every
    // template's contents (a fragment's top-level nodes have theirs as they are inserted): its radio buttons' (a group's
    // last checked one the one left checked, as each insertion in turn left it: dom.rs `insertion_steps`), and its
    // shadow trees' slots'.
    pub(crate) fn finish(&mut self, scope: &mut v8::PinScope<'s, '_>, document: Option<crate::dom::NodeId>) {
        let arena = crate::dom::realm(scope, self.cid);
        let mut roots: Vec<crate::dom::NodeId> = document.and_then(|d| arena.get(d)).map_or_else(Vec::new, |n| n.children.clone());
        for &c in &self.contents {
            roots.extend(arena.get(c).map_or(&[][..], |n| &n.children[..]).iter().copied());
        }
        if arena.radio_insertion_steps(&roots) {
            arena.observers.note_state_changed();
        }
        // (…and the slots of each shadow tree it attached assigned, as the insertions into a live one assign them)
        for &shadow in &self.shadows {
            crate::dom::assign_slots_in(scope, self.cid, Some(shadow), &[]);
        }
    }
    // What the page is handed: the count of `tops` and their objects, then each element the bindings have steps for,
    // the names of its attributes whose steps are theirs and its flags — an element with an id, autofocus or an
    // `open` given its insertion steps too (`BUILT_INSERTED`). None past a node factory that threw: its exception is what
    // the op ends with.
    pub(crate) fn answer(&mut self, scope: &mut v8::PinScope<'s, '_>, tops: &[crate::dom::NodeId]) -> Option<Vec<v8::Local<'s, v8::Value>>> {
        for (_, names, flags) in self.steps.iter_mut() {
            if names.iter().any(|n| matches!(n.as_str(), "id" | "autofocus" | "open")) {
                *flags |= BUILT_INSERTED;
            }
            names.retain(|n| n != "autofocus");
        }
        let mut out: Vec<v8::Local<'s, v8::Value>> = vec![v8::Integer::new_from_unsigned(scope, tops.len() as u32).into()];
        let nodes = v8::Local::<v8::Array>::try_from(crate::dom::nodes_value(scope, self.cid, tops)).ok()?;
        if crate::dom::factory_threw(scope) {
            return None;
        }
        for i in 0..tops.len() as u32 {
            out.push(nodes.get_index(scope, i).unwrap_or_else(|| v8::null(scope).into()));
        }
        let ids: Vec<crate::dom::NodeId> = self.steps.iter().map(|(id, ..)| *id).collect();
        let elements = v8::Local::<v8::Array>::try_from(crate::dom::nodes_value(scope, self.cid, &ids)).ok()?;
        if crate::dom::factory_threw(scope) {
            return None;
        }
        for (k, (_, names, flags)) in self.steps.iter().enumerate() {
            out.push(elements.get_index(scope, k as u32).unwrap_or_else(|| v8::null(scope).into()));
            out.push(crate::cloning::names_value(scope, names));
            out.push(v8::Integer::new_from_unsigned(scope, *flags).into());
        }
        Some(out)
    }
}
