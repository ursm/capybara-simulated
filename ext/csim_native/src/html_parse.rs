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
// are a handle of their own, made with the template.

use std::borrow::Cow;
use std::cell::{Cell, RefCell};

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
}

impl Sink {
    fn new(context: Option<QualName>) -> Sink {
        // (handle 0, the document; 1 and 2 a fragment's context element and form element pointer)
        let mut nodes = vec![Node::default(), Node::default(), Node::default()];
        nodes[1].name = context.map(Box::new);
        nodes[2].name = Some(Box::new(QualName::new(None, html5ever::ns!(html), html5ever::local_name!("form"))));
        Sink { nodes: RefCell::new(nodes), ops: RefCell::new(Vec::new()) }
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
        false
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

#[derive(Default)]
struct StandIns {
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
    if standins.base.is_none() || !text.chars().any(|c| standins.holds(u32::from(c))) {
        return v8::String::new(scope, text);
    }
    let base = standins.base.unwrap_or_default();
    let mut units = Vec::with_capacity(text.len());
    for c in text.chars() {
        if standins.holds(u32::from(c)) {
            units.push((u32::from(c) - base + 0xD800) as u16);
        } else {
            let mut pair = [0u16; 2];
            units.extend_from_slice(c.encode_utf16(&mut pair));
        }
    }
    v8::String::new_from_two_byte(scope, &units, v8::NewStringType::Normal)
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
        if self.set_aside.is_empty() {
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
    register(scope, ns, "htmlRun", html_run, context_id);
    register(scope, ns, "htmlScriptBegin", html_script_begin, context_id);
    register(scope, ns, "htmlScriptEnd", html_script_end, context_id);
    register(scope, ns, "htmlWrite", html_write, context_id);
    register(scope, ns, "htmlDone", html_done, context_id);
}

// Run a parser op, catching a panic (a bug in the parser, or one a page's input found) where it would otherwise unwind
// into V8's callback frame and abort the process: the parse it was running is dropped — what it built so far stands,
// the rest of its input is lost — and the bug goes to stderr.
fn parser_op(scope: &mut v8::PinScope<'_, '_>, id: Option<u32>, op: impl FnOnce(&mut v8::PinScope<'_, '_>)) {
    let Err(panic) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| op(scope))) else { return };
    let what = panic.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| panic.downcast_ref::<String>().cloned());
    eprintln!("csim: the HTML parser panicked: {}", what.unwrap_or_default());
    if let Some(id) = id {
        parses(scope).live.remove(&id);
    }
}

// The steps taken since the last call, then the status: -1 the input ran out, else the script handle to run first —
// after the parse's id, for the call that starts it.
fn steps<'s>(scope: &mut v8::PinScope<'s, '_>, id: u32, status: i32, with_id: bool) -> v8::Local<'s, v8::Array> {
    let (ops, standins) = match parses(scope).live.get_mut(&id) {
        Some(p) => (std::mem::take(&mut *p.tokenizer.sink.sink.ops.borrow_mut()), std::mem::take(&mut p.standins)),
        None => (Vec::new(), StandIns::default()),
    };
    let mut items: Vec<v8::Local<v8::Value>> = Vec::with_capacity(ops.len() + 2);
    if with_id {
        items.push(v8::Integer::new_from_unsigned(scope, id).into());
    }
    for op in ops {
        items.push(match op {
            Operand::Int(i) => v8::Integer::new(scope, i).into(),
            Operand::Str(s) => page_string(scope, &s, &standins).map_or_else(|| v8::undefined(scope).into(), Into::into),
        });
    }
    if let Some(p) = parses(scope).live.get_mut(&id) {
        p.standins = standins;
    }
    items.push(v8::Integer::new(scope, status).into());
    v8::Array::new_with_elements(scope, &items)
}

// __dom.htmlParse(html, wellFormed, scripting, contextNs, contextLocalName, withForm, quirks) -> [id, steps…, status].
// A document parse, or — given the namespace (as `ns_code` numbers it) and local name of the element whose content it
// is — a fragment parse in that context (handle 1; handle 2 its form element pointer, `withForm`), in its document's
// mode (`quirks` 0 no-quirks, 1 limited-quirks, 2 quirks).
fn html_parse(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    parser_op(scope, None, |scope| {
        let mut standins = StandIns::default();
        let well_formed = args.get(1).boolean_value(scope);
        let html = parser_text(scope, args.get(0), well_formed, &mut standins);
        let scripting = args.get(2).boolean_value(scope);
        let context = (!args.get(4).is_null_or_undefined())
            .then(|| (args.get(3).int32_value(scope).unwrap_or(1), args.get(4).to_rust_string_lossy(scope)));
        let with_form = args.get(5).boolean_value(scope);
        let quirks_mode = match args.get(6).int32_value(scope) {
            Some(2) => QuirksMode::Quirks,
            Some(1) => QuirksMode::LimitedQuirks,
            _ => QuirksMode::NoQuirks,
        };
        let opts = TreeBuilderOpts { scripting_enabled: scripting, quirks_mode, ..Default::default() };
        // (…the text is decoded already, its byte order mark gone with the decoding: a U+FEFF left is text)
        let tokenizer_opts = TokenizerOpts { discard_bom: false, ..Default::default() };
        let tokenizer = match &context {
            None => Tokenizer::new(TreeBuilder::new(Sink::new(None), opts), tokenizer_opts),
            Some((ns, local)) => {
                let name = QualName::new(None, namespace_of(*ns), LocalName::from(local.as_str()));
                let builder = TreeBuilder::new_for_fragment(Sink::new(Some(name)), 1, with_form.then_some(2), opts);
                let initial_state = Some(builder.tokenizer_state_for_context_elem(scripting));
                Tokenizer::new(builder, TokenizerOpts { initial_state, ..tokenizer_opts })
            }
        };
        let input = BufferQueue::default();
        input.push_back(StrTendril::from(html));
        let all = parses(scope);
        all.next += 1;
        let id = all.next;
        all.live.insert(id, Parse { tokenizer, input, set_aside: Vec::new(), standins, ended: false });
        let status = all.live.get_mut(&id).map_or(-1, Parse::run);
        let steps = steps(scope, id, status, true);
        rv.set(steps.into());
    });
}

fn parse_id(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> u32 {
    args.get(0).uint32_value(scope).unwrap_or(0)
}

// __dom.htmlRun(id) -> [steps…, status]: parse on, from where the parse stopped.
fn html_run(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = parse_id(scope, &args);
    parser_op(scope, Some(id), |scope| {
        let status = parses(scope).live.get_mut(&id).map_or(-1, Parse::run);
        let steps = steps(scope, id, status, false);
        rv.set(steps.into());
    });
}

// __dom.htmlScriptBegin(id): a script runs with an insertion point — just past its `</script>`, or before the next
// input character for the pending parsing-blocking one: the input after it is set aside until `htmlScriptEnd`.
fn html_script_begin(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = parse_id(scope, &args);
    parser_op(scope, Some(id), |scope| {
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
fn html_script_end(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = parse_id(scope, &args);
    parser_op(scope, Some(id), |scope| {
        if let Some(p) = parses(scope).live.get_mut(&id) {
            for chunk in p.set_aside.pop().unwrap_or_default() {
                p.input.push_back(chunk);
            }
        }
    });
}

// __dom.htmlWrite(id, html, wellFormed) -> whether it went in: `document.write(html)` from a script with an insertion
// point puts its text there — at the end of the input the parse has not taken, before what is set aside. (`htmlRun`
// parses it, but for a pending parsing-blocking script.) Nothing goes into a parse that has ended.
fn html_write(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = parse_id(scope, &args);
    parser_op(scope, Some(id), |scope| {
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

// __dom.htmlDone(id): the parse is over (or abandoned); its state goes.
fn html_done(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = parse_id(scope, &args);
    parses(scope).live.remove(&id);
}
