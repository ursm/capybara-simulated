// The script element (HTML §4.12.1): what its type is — "prepare the script element" steps 8-12, which decide whether
// and as what it runs — the engine's to say from its attributes, and its flags the engine's to keep. Running it, fetching
// it, the bindings'.

use crate::dom::{dom, nid_arg, NodeData, NodeId, NodeKind, RealmArena};

// What a script element's type is: none it runs as (a data block), a classic script, a module script, an import map,
// speculation rules.
pub(crate) const DATA_BLOCK: u32 = 0;
pub(crate) const CLASSIC: u32 = 1;
pub(crate) const MODULE: u32 = 2;
pub(crate) const IMPORT_MAP: u32 = 3;
pub(crate) const SPECULATION_RULES: u32 = 4;

// A script element's flags (`NodeData::script_flags`): HTML's "already started", its parser document (parser-inserted),
// "force async" — which it is made with, so the bit says it is not — and whether the driver's after-parse pass has run it.
pub(crate) const SCRIPT_ALREADY_STARTED: u8 = 1;
pub(crate) const SCRIPT_PARSER_INSERTED: u8 = 1 << 1;
pub(crate) const SCRIPT_NOT_FORCE_ASYNC: u8 = 1 << 2;
pub(crate) const SCRIPT_RUN: u8 = 1 << 3;
// …and that the parser reached its end tag — or the XML parser's after-parse pass, which stands in for it — and decided
// it then: run it, put it on the list of scripts to execute after parsing (`list_parser_script`), or neither.
pub(crate) const SCRIPT_END_TAG: u8 = 1 << 4;

// The JavaScript MIME type essences (MIME Sniffing §4.6), each matched ASCII case-insensitively.
const JAVASCRIPT_MIME_TYPES: [&str; 16] = [
    "application/ecmascript",
    "application/javascript",
    "application/x-ecmascript",
    "application/x-javascript",
    "text/ecmascript",
    "text/javascript",
    "text/javascript1.0",
    "text/javascript1.1",
    "text/javascript1.2",
    "text/javascript1.3",
    "text/javascript1.4",
    "text/javascript1.5",
    "text/jscript",
    "text/livescript",
    "text/x-ecmascript",
    "text/x-javascript",
];

// Whether `essence` is a JavaScript MIME type's.
pub(crate) fn is_javascript_mime(essence: &str) -> bool {
    JAVASCRIPT_MIME_TYPES.iter().any(|m| m.eq_ignore_ascii_case(essence))
}

// HTML "prepare the script element" steps 8-12: the script block's type string — `text/javascript` for an empty `type`,
// or none with an empty or no `language`; the `type`, else `text/` and the `language` — its ASCII whitespace stripped,
// then what it is.
pub(crate) fn script_type(n: &NodeData) -> u32 {
    let given = match (n.plain_attr("type"), n.plain_attr("language")) {
        (Some(""), _) | (None, None | Some("")) => return CLASSIC,
        (Some(t), _) => t.to_owned(),
        (None, Some(l)) => format!("text/{l}"),
    };
    let ty = given.trim_matches(|c: char| matches!(c, '\t' | '\n' | '\x0c' | '\r' | ' '));
    if is_javascript_mime(ty) {
        CLASSIC
    } else if ty.eq_ignore_ascii_case("module") {
        MODULE
    } else if ty.eq_ignore_ascii_case("importmap") {
        IMPORT_MAP
    } else if ty.eq_ignore_ascii_case("speculationrules") {
        SPECULATION_RULES
    } else {
        DATA_BLOCK
    }
}

// What preparing a script element (`prepare`) found it is to do: nothing; fire `error` (an empty `src`, an import map's
// any `src`); run as a classic script; run as a module script — inline, or from its `src`, which the bindings fetch;
// register its import map.
pub(crate) const PREPARE_NONE: u32 = 0;
pub(crate) const PREPARE_ERROR: u32 = 1;
pub(crate) const PREPARE_CLASSIC: u32 = 2;
pub(crate) const PREPARE_MODULE: u32 = 3;
pub(crate) const PREPARE_IMPORT_MAP: u32 = 4;

// Who prepares it: a script no parser is preparing; the parser, at its end tag (or the XML parser's after-parse pass,
// in its place); and the after-parse pass, a deferred, async or module script out of the lists "the end" runs.
pub(crate) const BY_SCRIPT: u32 = 0;
pub(crate) const BY_PARSER: u32 = 1;
pub(crate) const BY_PARSER_LIST: u32 = 2;

impl RealmArena {
    // Whether realm `realm`'s document is sandboxed against scripts (its sandboxed scripts browsing context flag, HTML
    // §7.6.5), which disables scripting in it: no script of its runs, no event handler content attribute of its
    // compiles, no `javascript:` URL of its is evaluated.
    pub(crate) fn scripts_sandboxed(&self, realm: i32) -> bool {
        self.sandboxed(realm, crate::sandbox::SCRIPTS)
    }
    // HTML "prepare the script element" — for one no parser is preparing (its children changed, it was connected, its
    // `src` set), and for the parser's import maps — as far as the element decides it: an "already started" one, one with
    // neither a `src` nor child text, one not connected, and one whose type runs as nothing here (a data block,
    // speculation rules) do nothing; any other is "already started" from here (and run by the after-parse pass's
    // reckoning), and does nothing as a classic script marked `nomodule`, fires `error` with an empty `src` — an import
    // map with any, there being no external import maps — and else runs, or registers its import map.
    // (…and, `scripting` false — its node document has no browsing context — or its document sandboxed against scripts,
    // "already started" and nothing more: step 19, "scripting is disabled")
    // (…the parser's script — `by` it, not `BY_SCRIPT` — is "already started" here from its creation, as the insertion
    // the parser makes prepares nothing, so what says it has been prepared is its having run; and one of the lists runs
    // connected or not: the parser prepared it at its end tag, connected, and one an earlier script removed since is
    // still in the list of scripts to execute after parsing, which "execute the script element" checks against its
    // preparation-time document alone — where at its end tag one the parser put in a removed subtree is not connected)
    pub(crate) fn prepare_script(&mut self, id: NodeId, scripting: bool, by: u32) -> u32 {
        if by == BY_PARSER {
            if let Some(n) = self.get_mut_quietly(id) {
                n.script_flags |= SCRIPT_END_TAG;
            }
        }
        let Some(n) = self.get(id) else { return PREPARE_NONE };
        if n.script_flags & if by == BY_SCRIPT { SCRIPT_ALREADY_STARTED } else { SCRIPT_RUN } != 0 {
            return PREPARE_NONE;
        }
        // (…and one no parser is preparing runs no text of the parser's: the line of its document the parser made it on
        // is no line of what it runs, which is counted from its own first, as an inserted script's — Chrome)
        if by == BY_SCRIPT && !self.script_lines.is_empty() {
            self.script_lines.remove(&id);
        }
        if !self.ready_to_start(id, by) {
            if by == BY_PARSER {
                self.leave_preparable(id);
            }
            return PREPARE_NONE;
        }
        let Some(n) = self.get(id) else { return PREPARE_NONE };
        let ty = script_type(n);
        let nomodule = ty == CLASSIC && n.plain_attr("nomodule").is_some();
        let src = n.plain_attr("src").map(str::is_empty);
        let scripting = scripting && !self.scripts_sandboxed(n.realm);
        if let Some(n) = self.get_mut_quietly(id) {
            n.script_flags |= SCRIPT_ALREADY_STARTED | SCRIPT_RUN;
        }
        match (nomodule || !scripting, src, ty) {
            (true, _, _) => PREPARE_NONE,
            (_, Some(true), _) | (_, Some(false), IMPORT_MAP) => PREPARE_ERROR,
            (_, _, MODULE) => PREPARE_MODULE,
            (_, _, IMPORT_MAP) => PREPARE_IMPORT_MAP,
            _ => PREPARE_CLASSIC,
        }
    }
    // The parser's script at its end tag that preparing returns from before it is "already started" — no text yet, not
    // connected, a type that runs nothing: the flag its creation set, in place of HTML's parser document, taken back, so
    // a later change prepares it, as one no parser made.
    fn leave_preparable(&mut self, id: NodeId) {
        if let Some(n) = self.get_mut_quietly(id) {
            n.script_flags &= !SCRIPT_ALREADY_STARTED;
        }
    }
    // Whether preparing the script element `id` goes on to set it "already started": it has a `src` or child text (one
    // out of the lists its text as its end tag found it), is connected — where it is not out of the lists — and its type
    // runs as something here.
    fn ready_to_start(&self, id: NodeId, by: u32) -> bool {
        let Some(n) = self.get(id) else { return false };
        let src = n.plain_attr("src").map(str::is_empty);
        // (…one out of the lists its text as its end tag found it: HTML takes the source text there)
        let listed = if by == BY_PARSER_LIST { self.realm_state(n.realm).and_then(|s| s.parser_sources.get(&id)) } else { None };
        let has_text = match listed {
            Some(text) => !text.is_empty(),
            None => n.children.iter().any(|&c| self.get(c).is_some_and(|t| t.kind == NodeKind::Text && !t.data.is_empty())),
        };
        if (src.is_none() && !has_text) || (by != BY_PARSER_LIST && !self.is_connected(id)) {
            return false;
        }
        matches!(script_type(n), CLASSIC | MODULE | IMPORT_MAP)
    }
}

// Whether a script element blocks the parser (HTML "prepare the script element" step 31): a classic script, inline or
// neither `defer` nor `async` — which take effect on an external one alone; a module is deferred always, and an import
// map or a data block runs nothing.
fn blocks_parser(n: &crate::dom::NodeData) -> bool {
    let deferred = n.plain_attr("src").is_some() && (n.plain_attr("defer").is_some() || n.plain_attr("async").is_some());
    script_type(n) == CLASSIC && !deferred
}

impl RealmArena {
    // The parser at the end tag of a script it does not run there — a deferred, async or module one, or one whose type
    // runs nothing (`listParserScript`): one connected then goes on the list of scripts to execute after parsing — where
    // "the end" finds it, whatever an earlier script did to it since (HTML §13.2.7: the lists are kept, not the tree
    // walked again), an inline one with the source text it has now — and one in a subtree a script removed does not;
    // one preparing returns from before it is "already started" is left preparable (`leave_preparable`).
    pub(crate) fn list_parser_script(&mut self, cid: i32, id: NodeId) {
        let Some(n) = self.get_mut_quietly(id) else { return };
        n.script_flags |= SCRIPT_END_TAG;
        if n.script_flags & SCRIPT_RUN != 0 {
            return;
        }
        if !self.ready_to_start(id, BY_PARSER) {
            return self.leave_preparable(id);
        }
        let Some(n) = self.get(id) else { return };
        if !matches!(script_type(n), CLASSIC | MODULE) {
            return;
        }
        let inline = n.plain_attr("src").is_none();
        let text = inline.then(|| self.child_text(id));
        if let Some(state) = self.realm_state_mut(cid) {
            state.parser_list.push(id);
            if let Some(text) = text {
                state.parser_sources.insert(id, text);
            }
        }
    }
    // The scripts of `root`'s tree (not a shadow tree's, nor a template's contents) its parser inserted and no end tag
    // decided — none of a parse that stopped at each (HTML's), every one of one that stopped at none (the XML parser's),
    // which the after-parse pass then decides as their end tags would, in tree order (HTML §13.2.7).
    pub(crate) fn parser_scripts(&self, root: NodeId) -> Vec<NodeId> {
        let mut found = Vec::new();
        let mut stack: Vec<NodeId> = self.get(root).map_or_else(Vec::new, |n| n.children.iter().rev().copied().collect());
        while let Some(id) = stack.pop() {
            let Some(n) = self.get(id) else { continue };
            if n.kind == NodeKind::Element && &*n.local_name == "script"
                && n.script_flags & (SCRIPT_PARSER_INSERTED | SCRIPT_RUN | SCRIPT_END_TAG) == SCRIPT_PARSER_INSERTED
            {
                found.push(id);
            }
            stack.extend(n.children.iter().rev());
        }
        found
    }
}

// Whether code compiled under the script name `url` is the page's — None for the driver's own: the snapshot's, the
// host's `<eval>` its script runners are compiled under, none at all — and, where it is, whether it is code the page's
// document compiled (an inline script, a handler content attribute, a string timer: `inline://…`, `csim-eval…`), whose
// URL is the document's.
fn page_script(url: &str) -> Option<bool> {
    if url.is_empty() || url.contains(char::is_whitespace) || url == "<snapshot>" || url == "<eval>" {
        return None;
    }
    Some(url.starts_with("inline://") || url.starts_with("csim-eval"))
}

// Where an exception was thrown, by its V8 `stack`: its top frame of the page's (`at f (url:line:col)` / `at
// url:line:col`) — the driver's own skipped (`page_script`), as a browser's bindings are no frame of a stack — as
// `(document, url, line, column)`, `document` where the frame is code the page's document compiled, whose URL is the
// document's: `new Function` and `eval` too (V8's `eval at f (url:L:C), <anonymous>:L:C`), its `url` that of the script
// that evaluated it, where a script of the page's from a URL did ("" otherwise). None for a stack of no such frame.
pub(crate) fn stack_location(stack: &str) -> Option<(bool, String, u32, u32)> {
    fn number(s: &str) -> Option<u32> {
        s.bytes().all(|b| b.is_ascii_digit()).then(|| s.parse().ok()).flatten()
    }
    fn line_col(s: &str) -> Option<(&str, u32, u32)> {
        let (rest, col) = s.rsplit_once(':')?;
        let (rest, line) = rest.rsplit_once(':')?;
        Some((rest, number(line)?, number(col)?))
    }
    // (…the place of a frame — after the function's name, which a page may make anything (`foo (bar)`): the last ` (`, as
    // no script URL has a space)
    fn place(frame: &str) -> Option<(&str, u32, u32)> {
        let place = frame.rsplit_once(" (").map_or(frame, |(_, p)| p);
        line_col(place.strip_suffix(')').unwrap_or(place))
    }
    for line in stack.lines() {
        let Some(frame) = line.trim_start().strip_prefix("at ").filter(|_| line.starts_with(char::is_whitespace)) else { continue };
        let evaluated = frame.contains("(eval at ").then(|| frame.strip_suffix(')')?.rsplit_once(", <anonymous>:")).flatten();
        let at = evaluated.and_then(|(origin, lc)| Some((origin, lc.split_once(':')?))).and_then(|(origin, (l, c))| Some((origin, number(l)?, number(c)?)));
        if let Some((origin, l, c)) = at {
            // (…the innermost `eval at` of a chain of them: the script whose code the first evaluation was)
            let outer = origin.rsplit_once("eval at ").map_or(origin, |(_, o)| o);
            let outer = outer.split_once(", <anonymous>").map_or(outer, |(o, _)| o);
            let url = place(outer).map(|(u, _, _)| u).filter(|u| page_script(u) == Some(false)).unwrap_or("");
            return Some((true, url.to_owned(), l, c));
        }
        let Some((url, l, c)) = place(frame) else { continue };
        let Some(document) = page_script(url) else { continue };
        return Some((document, url.to_owned(), l, c));
    }
    None
}

// Where V8 says the exception `e` was thrown — the location of the message it makes of it (an Error's, of where it was
// made, from the frames it keeps of its own, which neither `Error.prepareStackTrace` nor a written `stack` reaches; a
// SyntaxError's, of the place in its text that did not compile) — as `stack_location` says it, None where that is the
// driver's code or none.
fn thrown_at(scope: &mut v8::PinScope<'_, '_>, e: v8::Local<'_, v8::Value>) -> Option<(bool, String, u32, u32)> {
    let message = v8::Exception::create_message(scope, e);
    let url = message.get_script_resource_name(scope).filter(|n| n.is_string())?.to_rust_string_lossy(scope);
    let document = page_script(&url)?;
    let line = message.get_line_number(scope)? as u32;
    Some((document, url, line, message.get_start_column() as u32 + 1))
}

// The line of its document a `line` of the code named `url` is: an inline script's counted from the line its text begins
// on (`inline://…@N`: bridge.entry.js `executeClassicScript`, where the parser made it), any other's its own.
fn document_line(url: &str, line: u32) -> u32 {
    let start = url.strip_prefix("inline://").and_then(|r| r.split_once('@')).and_then(|(_, n)| n.split('~').next()?.parse::<u32>().ok());
    start.map_or(line, |s| line + s.saturating_sub(1))
}

// __dom.takeScriptLine(nid) -> the line of its document the script the parser made begins on (`script_lines`), 0 for a
// script it did not make — taken, as it runs once.
fn take_script_line_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_uint32(0) };
    let cid = crate::dom::realm_id(scope, &args);
    rv.set_uint32(crate::dom::realm(scope, cid).script_lines.remove(&id).unwrap_or(0));
}

// src/v8_shim.cc: the function a bound function calls.
unsafe extern "C" {
    fn csim_bound_target(f: *const v8::Function) -> *const v8::Function;
}
// The name of the script the function `f` was compiled in — a bound one's or a callable proxy's target's — where it is a
// page script's of a URL (`page_script`).
fn function_script(scope: &mut v8::PinScope<'_, '_>, f: v8::Local<'_, v8::Value>) -> Option<String> {
    let f = v8::Local::<v8::Function>::try_from(f).ok()?;
    // SAFETY: the shim answers a handle of this callback's scope (a `Local`'s representation), never a null one.
    let f: v8::Local<v8::Function> = unsafe { std::mem::transmute(csim_bound_target(&*f)) };
    let url = f.get_script_origin(scope).resource_name().filter(|n| n.is_string())?.to_rust_string_lossy(scope);
    (page_script(&url) == Some(false)).then_some(url)
}

// __dom.exceptionSite(e, error, where, callback) -> `[muted, document, url, line, column]` — HTML "report an exception"'s
// location of the exception `e` and whether its errors are muted — or `[muted]` where it says nowhere. Its location where
// V8 says it was thrown (`thrown_at`, which no page's `Error.prepareStackTrace` or written `stack` rewrites), else its
// `stack`'s top frame of the page's (`stack_location`: an Error the driver's own code made, a binding's DOMException) —
// read too where V8's place is the document's code, as an evaluation's names the script that made it; and only after V8
// was asked, as an Error's `stack` once made leaves it no frames of its own to make a message of — and only of an
// `error` (an Error or a DOMException of any realm, the bindings' brand checks), a getter's throw no stack: the report
// is made all the same, as a browser's consults no page getter. Muted where a
// script it came out of is a classic one whose errors are (`muted_scripts`), and, where V8 says nowhere (a thrown string,
// an evaluation's code, whose stack a page may have rewritten), where the script it was run as (`where`, its URL) or the
// callback that threw it is.
// KNOWN GAPS: an Error is judged by where it was MADE, as its report has only it to go by — one a muted script made and
// the page threw is muted, where Chrome reports it at the page's throw; and a script's verdict is its URL's, as last
// fetched (a no-cors and a CORS fetch of one URL share it).
fn exception_site_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let e = args.get(0);
    let thrown = thrown_at(scope, e);
    let mut stack = None;
    if thrown.as_ref().is_none_or(|t| t.0) && args.get(1).is_true() {
        v8::tc_scope!(let tc, scope);
        let key = v8::String::new(tc, "stack").unwrap();
        if let Some(text) = e.to_object(tc).and_then(|o| o.get(tc, key.into())).filter(|t| t.is_string()) {
            stack = stack_location(&text.to_rust_string_lossy(tc));
        }
    }
    let cid = crate::dom::realm_id(scope, &args);
    let mut muted = false;
    if !crate::dom::realm(scope, cid).muted_scripts.is_empty() {
        let mut scripts: Vec<String> = [&thrown, &stack].into_iter().flatten().map(|at| at.1.clone()).collect();
        if thrown.is_none() {
            scripts.push(args.get(2).to_rust_string_lossy(scope));
            scripts.extend(function_script(scope, args.get(3)));
        }
        let muted_scripts = &crate::dom::realm(scope, cid).muted_scripts;
        muted = scripts.iter().any(|url| !url.is_empty() && muted_scripts.contains(url));
    }
    let muted = v8::Boolean::new(scope, muted).into();
    let items = match thrown.or(stack) {
        Some((document, url, line, column)) => vec![
            muted,
            v8::Boolean::new(scope, document).into(),
            v8::String::new(scope, &url).map_or_else(|| v8::undefined(scope).into(), Into::into),
            v8::Integer::new_from_unsigned(scope, document_line(&url, line)).into(),
            v8::Integer::new_from_unsigned(scope, column).into(),
        ],
        None => vec![muted],
    };
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.isNativeError(v) -> whether `v` is an Error of any realm: its [[ErrorData]] — asked of no getter, trap or
// `Symbol.toStringTag` of the page's, as a thrown value's report runs none (a revoked proxy's would throw).
fn is_native_error_op(_: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(args.get(0).is_native_error());
}

// __dom.thrownText(v) -> the text V8 makes of the thrown value `v` for its message, running no code of the page's: what
// a report says of one whose own string conversion throws (a revoked proxy's).
fn thrown_text_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = v8::Exception::create_message(scope, args.get(0)).get(scope).to_rust_string_lossy(scope);
    let text = text.strip_prefix("Uncaught ").unwrap_or(&text);
    if let Some(text) = v8::String::new(scope, text) {
        rv.set(text.into());
    }
}

// __dom.runningScriptMuted() -> whether the script of the page's that is running — the top frame of the stack that is a
// page script's (`page_script`) — is a classic one whose errors are muted (`muted_scripts`): the script a promise it
// rejected was rejected by (HTML HostPromiseRejectionTracker). At once false where no script is muted, as a page's
// rejections are many and its muted scripts few.
fn running_script_muted_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(false);
    let cid = crate::dom::realm_id(scope, &args);
    if crate::dom::realm(scope, cid).muted_scripts.is_empty() {
        return;
    }
    let Some(trace) = v8::StackTrace::current_stack_trace(scope, RUNNING_SCRIPT_FRAMES) else { return };
    for i in 0..trace.get_frame_count() {
        let Some(name) = trace.get_frame(scope, i).and_then(|f| f.get_script_name_or_source_url(scope)) else { continue };
        let url = name.to_rust_string_lossy(scope);
        match page_script(&url) {
            Some(false) => return rv.set_bool(crate::dom::realm(scope, cid).muted_scripts.contains(&url)),
            Some(true) => return,
            None => {}
        }
    }
}
// (…as deep as the driver's own frames go beneath a promise rejected: the rejection tracker's call into the bindings)
const RUNNING_SCRIPT_FRAMES: usize = 16;

// __dom.scriptOnStack() -> whether script runs beneath the caller — HTML's JavaScript execution context stack not empty,
// as "clean up after running script" asks after a callback: a microtask running (its realm's queue: a checkpoint inside
// one does nothing), or a frame of the page's on the stack (`driver_frame`'s other) — code the page made with `eval` or
// `new Function` included, as a handler attribute's is. The driver's own frames are no script's: an event the host fires
// through the bindings has an empty stack beneath its listeners, one a page's `dispatchEvent` fires the page's. Where no
// stack can be had, script is taken to be running: no checkpoint is the one that cannot run a page's microtasks early.
// (…every realm's frames in the trace, as every realm of the isolate shares one security token — rusty_racer's; a trace
// leaves out the frames of another's, which would read as no script)
fn script_on_stack_op(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    if scope.get_current_context().get_microtask_queue().is_running_microtasks() {
        return rv.set_bool(true);
    }
    // (…asked of as many frames as the bindings' own go beneath a callback, and of more where they all were)
    let mut limit = STACK_FRAMES;
    loop {
        let Some(trace) = v8::StackTrace::current_stack_trace(scope, limit) else { return rv.set_bool(true) };
        let count = trace.get_frame_count();
        for i in 0..count {
            let Some(frame) = trace.get_frame(scope, i) else { continue };
            if !driver_frame(scope, &frame) {
                return rv.set_bool(true);
            }
        }
        if count < limit {
            return rv.set_bool(false);
        }
        limit *= 4;
    }
}
const STACK_FRAMES: usize = 16;
// Whether `frame` is the driver's own code: the snapshot's (`<snapshot>`), the host's script runners' (`<eval>`), or of
// no script name — never code evaluated, which is the page's. Any other name is a page's script, whatever it holds (a
// `data:` URL's spaces: `page_script` reads names out of a stack's text, which these come from V8 apart from).
fn driver_frame(scope: &mut v8::PinScope<'_, '_>, frame: &v8::StackFrame) -> bool {
    if frame.is_eval() {
        return false;
    }
    let Some(name) = frame.get_script_name_or_source_url(scope) else { return true };
    // (…told by its length before its text, which the page's are seldom of)
    match name.length() {
        0 => true,
        6 | 10 => matches!(name.to_rust_string_lossy(scope).as_str(), "<eval>" | "<snapshot>"),
        _ => false,
    }
}

// __dom.scriptMuted(url[, muted]) -> whether the classic script fetched from `url` has its errors muted (`muted_scripts`,
// the isolate's: a script of one realm calls another's); with `muted`, that set for it, as its fetch found.
fn script_muted_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let url = args.get(0).to_rust_string_lossy(scope);
    let muted = (args.length() > 1).then(|| args.get(1).boolean_value(scope));
    let cid = crate::dom::realm_id(scope, &args);
    let scripts = &mut crate::dom::realm(scope, cid).muted_scripts;
    if let Some(muted) = muted {
        if muted {
            scripts.insert(url.clone());
        } else {
            scripts.remove(&url);
        }
    }
    rv.set_bool(scripts.contains(&url));
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "exceptionSite", exception_site_op, context_id);
    crate::dom::register(scope, ns, "isNativeError", is_native_error_op, context_id);
    crate::dom::register(scope, ns, "thrownText", thrown_text_op, context_id);
    crate::dom::register(scope, ns, "takeScriptLine", take_script_line_op, context_id);
    crate::dom::register(scope, ns, "runningScriptMuted", running_script_muted_op, context_id);
    crate::dom::register(scope, ns, "scriptMuted", script_muted_op, context_id);
    crate::dom::register(scope, ns, "scriptOnStack", script_on_stack_op, context_id);
    crate::dom::register(scope, ns, "parserScripts", parser_scripts_op, context_id);
    crate::dom::register(scope, ns, "listParserScript", list_parser_script_op, context_id);
    crate::dom::register(scope, ns, "takeParserList", take_parser_list_op, context_id);
    crate::dom::register(scope, ns, "takeParserSource", take_parser_source_op, context_id);
    crate::dom::register(scope, ns, "scriptBlocksParser", script_blocks_parser_op, context_id);
    crate::dom::register(scope, ns, "scriptType", script_type_op, context_id);
    crate::dom::register(scope, ns, "scriptSupports", script_supports_op, context_id);
    crate::dom::register(scope, ns, "moduleContent", module_content_op, context_id);
    crate::dom::register(scope, ns, "modulepreloadDestination", modulepreload_destination_op, context_id);
    crate::dom::register(scope, ns, "preloadDestination", preload_destination_op, context_id);
    crate::dom::register(scope, ns, "classicScriptEncoding", classic_script_encoding_op, context_id);
    crate::dom::register(scope, ns, "scriptFlags", script_flags_op, context_id);
    crate::dom::register(scope, ns, "setScriptFlags", set_script_flags_op, context_id);
    crate::dom::register(scope, ns, "prepareScript", prepare_script_op, context_id);
}
// Capybara::Simulated::Native.javascript_content(content_type) -> whether a response's `Content-Type` (Fetch "extract a
// MIME type") is a JavaScript MIME type, for the host's worker and service worker scripts.
pub(crate) fn javascript_content_for_ruby(content_type: String) -> bool {
    crate::mime::extract(&content_type).is_some_and(|m| is_javascript_mime(&m.essence))
}
// Whether a module script's response may be one of its `kind` — the destination its module type fetches with (HTML
// "fetch a single module script"): a JSON module's (`json`) a JSON MIME type (`application/json`, `text/json`, any
// `+json`), a CSS module's (`style`) `text/css`, a text module's (`text`) any, any other a JavaScript MIME type.
pub(crate) fn module_content(content_type: &str, kind: &str) -> bool {
    match kind {
        "text" => true,
        "json" => crate::mime::extract(content_type).is_some_and(|m| crate::mime::is_json(&m.essence)),
        "style" => crate::mime::extract(content_type).is_some_and(|m| m.essence == "text/css"),
        _ => crate::mime::extract(content_type).is_some_and(|m| is_javascript_mime(&m.essence)),
    }
}
// Capybara::Simulated::Native.module_content(content_type, json) -> `module_content`, a script's — or, for a module the
// host takes for a JSON one (by its URL: no import attributes reach it yet), a JSON one's or a script's.
pub(crate) fn module_content_for_ruby(content_type: String, json: bool) -> bool {
    module_content(&content_type, "script") || (json && module_content(&content_type, "json"))
}
// __dom.moduleContent(contentType, kind) -> `module_content`.
fn module_content_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let header = args.get(0).to_rust_string_lossy(scope);
    let kind = args.get(1).to_rust_string_lossy(scope);
    rv.set_bool(module_content(&header, &kind));
}

// The keywords of a `<link>`'s `as` (HTML): the preload destinations — what a `rel=preload` fetches — and the module
// preload destinations — what a `rel=modulepreload` does (a script-like one, `json`, `style`, `text`).
const PRELOAD_DESTINATIONS: [&str; 6] = ["fetch", "font", "image", "script", "style", "track"];
const MODULE_PRELOAD_DESTINATIONS: [&str; 9] = ["audioworklet", "paintworklet", "script", "serviceworker", "sharedworker", "worker", "json", "style", "text"];
fn as_keyword(as_value: &str) -> Option<&'static str> {
    PRELOAD_DESTINATIONS.iter().chain(&MODULE_PRELOAD_DESTINATIONS).copied().find(|d| d.eq_ignore_ascii_case(as_value))
}
// The destination a `<link rel=modulepreload>` fetches with, by its `as` (HTML "fetch and process the linked resource",
// modulepreload): the module preload destination it names, `script` for an `as` in no state (missing, or no keyword:
// `as=audio` too); None for one naming a preload destination no module is (`image`, `fetch`), which fetches nothing and
// fails.
pub(crate) fn modulepreload_destination(as_value: &str) -> Option<&'static str> {
    let Some(named) = as_keyword(as_value) else { return Some("script") };
    MODULE_PRELOAD_DESTINATIONS.contains(&named).then_some(named)
}
// The destination a `<link rel=preload>` fetches with (HTML "translate a preload destination"): the preload destination
// its `as` names, `fetch` the empty one — None for any other (missing, empty, no keyword, a module's alone: `json`,
// `worker`), which fetches nothing (Chrome and Firefox: no request, no event).
pub(crate) fn preload_destination(as_value: &str) -> Option<&'static str> {
    let named = as_keyword(as_value).filter(|d| PRELOAD_DESTINATIONS.contains(d))?;
    Some(if named == "fetch" { "" } else { named })
}
// __dom.preloadDestination(as) -> `preload_destination`, null for none.
fn preload_destination_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let as_value = if args.get(0).is_null_or_undefined() { String::new() } else { args.get(0).to_rust_string_lossy(scope) };
    match preload_destination(&as_value).and_then(|d| v8::String::new(scope, d)) {
        Some(d) => rv.set(d.into()),
        None => rv.set_null(),
    }
}
// __dom.modulepreloadDestination(as) -> `modulepreload_destination`, null for none.
fn modulepreload_destination_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let as_value = if args.get(0).is_null_or_undefined() { String::new() } else { args.get(0).to_rust_string_lossy(scope) };
    match modulepreload_destination(&as_value).and_then(|d| v8::String::new(scope, d)) {
        Some(d) => rv.set(d.into()),
        None => rv.set_null(),
    }
}

// Whether a script's response is refused before it runs, its fetch a network error (Fetch "main fetch"): its MIME type
// one a script never is — "should response to request be blocked due to its MIME type?": `audio/*`, `image/*`,
// `video/*`, `text/csv` — or, with `X-Content-Type-Options: nosniff` (`nosniff`, the header's value), one that is no
// JavaScript MIME type. (Its `integrity`, any request's, is the judge's: subresource_judge.rs `judge`.)
pub(crate) fn script_response_refused(content_type: &str, nosniff: &str) -> bool {
    let essence = crate::mime::extract(content_type).map(|m| m.essence);
    let never = essence.as_deref().is_some_and(|e| {
        ["audio/", "image/", "video/"].iter().any(|p| e.starts_with(p)) || e == "text/csv"
    });
    let sniffed = crate::fetch_rules::blocked_by_nosniff("script", content_type, nosniff);
    never || sniffed
}
// The encoding a classic script's response decodes with (HTML "fetch a classic script"): its `Content-Type`'s charset
// where that names one ("legacy extract an encoding": a label of none as good as none), else its document's.
pub(crate) fn classic_script_encoding(content_type: &str, document_charset: &str) -> &'static str {
    let charset = crate::mime::extract(content_type).and_then(|m| m.parameters.into_iter().find(|(n, _)| n == "charset").map(|(_, v)| v));
    charset
        .and_then(|c| encoding_rs::Encoding::for_label(c.as_bytes()))
        .or_else(|| encoding_rs::Encoding::for_label(document_charset.as_bytes()))
        .map_or("UTF-8", |e| e.name())
}
// __dom.classicScriptEncoding(contentType, documentCharset) -> `classic_script_encoding`.
fn classic_script_encoding_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let [content_type, charset] = [0, 1].map(|i| args.get(i).to_rust_string_lossy(scope));
    let name = v8::String::new(scope, classic_script_encoding(&content_type, &charset)).map_or_else(|| v8::undefined(scope).into(), Into::into);
    rv.set(name);
}

// `HTMLScriptElement.supports(type)` (HTML §4.12.1.1): whether `type` names a script type this UA runs — what
// `prepare_script` runs: a classic script, a module and an import map; speculation rules, a type it knows, it does not.
fn supports(ty: &str) -> bool {
    matches!(ty, "classic" | "module" | "importmap")
}
// __dom.scriptSupports(type) -> `supports`.
fn script_supports_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let ty = args.get(0).to_rust_string_lossy(scope);
    rv.set_bool(supports(&ty));
}

// __dom.scriptType(nid) -> what the script element's type is (`script_type`: `DATA_BLOCK`, `CLASSIC`, …).
fn script_type_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_uint32(DATA_BLOCK) };
    rv.set_uint32(dom(scope).arena.get(id).map_or(DATA_BLOCK, script_type));
}

// __dom.scriptFlags(nid) -> the script element's flags (`SCRIPT_*`).
fn script_flags_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_uint32(0) };
    rv.set_uint32(dom(scope).arena.get(id).map_or(0, |n| u32::from(n.script_flags)));
}

// __dom.setScriptFlags(nid, mask, bits) — the script element's flags under `mask` become `bits`.
fn set_script_flags_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let mask = args.get(1).uint32_value(scope).unwrap_or(0) as u8;
    let bits = args.get(2).uint32_value(scope).unwrap_or(0) as u8;
    // (…no input to any memo of the arena, nor to a layout: a write that moves none)
    if let Some(n) = dom(scope).arena.get_mut_quietly(id) {
        n.script_flags = (n.script_flags & !mask) | (bits & mask);
    }
}

// __dom.parserScripts(rootNid) -> the scripts `parser_scripts` finds, as `nodes_value` answers them.
fn parser_scripts_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = nid_arg(scope, &args, 0) else { return };
    let cid = crate::dom::realm_id(scope, &args);
    let found = crate::dom::dom(scope).arena.parser_scripts(root);
    rv.set(crate::dom::nodes_value(scope, cid, &found));
}

// __dom.listParserScript(nid) — the parser at the script's end tag, a deferred, async or module one (`list_parser_script`).
fn list_parser_script_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let cid = crate::dom::realm_id(scope, &args);
    crate::dom::realm(scope, cid).list_parser_script(cid, id);
}

// __dom.takeParserSource(nid) -> the source text a listed inline script had at its end tag, or null for none — taken.
fn take_parser_source_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_null() };
    let cid = crate::dom::realm_id(scope, &args);
    let text = crate::dom::realm(scope, cid).realm_state_mut(cid).and_then(|s| s.parser_sources.remove(&id));
    match text.and_then(|t| v8::String::new_from_two_byte(scope, &t, v8::NewStringType::Normal)) {
        Some(t) => rv.set(t.into()),
        None => rv.set_null(),
    }
}

// __dom.takeParserList() -> the realm's list of scripts to execute after parsing, in the order their end tags put them
// on it, as `nodes_value` answers them — the list emptied.
fn take_parser_list_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let list = crate::dom::realm(scope, cid).realm_state_mut(cid).map(|s| std::mem::take(&mut s.parser_list)).unwrap_or_default();
    rv.set(crate::dom::nodes_value(scope, cid, &list));
}

// __dom.scriptBlocksParser(nid) -> whether the script element blocks the parser (`blocks_parser`).
fn script_blocks_parser_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = nid_arg(scope, &args, 0);
    rv.set_bool(id.and_then(|id| crate::dom::dom(scope).arena.get(id)).is_some_and(blocks_parser));
}

// __dom.prepareScript(nid, scripting, by) -> what preparing the script element found it is to do, prepared `by` whom
// (`prepare_script`: `PREPARE_NONE`, …; `BY_*`).
fn prepare_script_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_uint32(PREPARE_NONE) };
    let cid = crate::dom::realm_id(scope, &args);
    let (scripting, by) = (args.get(1).is_true(), args.get(2).uint32_value(scope).unwrap_or(BY_SCRIPT));
    rv.set_uint32(crate::dom::realm(scope, cid).prepare_script(id, scripting, by));
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::dom::{NodeData, NodeKind};

    // A modulepreload's `as`: a module preload destination as it names it, `script` for none or no keyword, nothing
    // for any other destination (`fetch` its own: none); and what a module of each kind takes.
    #[test]
    fn a_modulepreload_fetches_by_its_as_and_a_module_takes_its_kinds_type() {
        assert_eq!(modulepreload_destination(""), Some("script"));
        assert_eq!(modulepreload_destination("bogus"), Some("script"));
        assert_eq!(modulepreload_destination("Style"), Some("style"));
        assert_eq!(modulepreload_destination("worker"), Some("worker"));
        assert_eq!(modulepreload_destination("image"), None);
        assert_eq!(modulepreload_destination("fetch"), None);
        assert_eq!((preload_destination("Style"), preload_destination("fetch")), (Some("style"), Some("")));
        assert_eq!((preload_destination(""), preload_destination("bogus")), (None, None));
        assert_eq!((preload_destination("audio"), preload_destination("worker")), (None, None));
        assert_eq!((modulepreload_destination("audio"), modulepreload_destination("track")), (Some("script"), None));
        assert!(module_content("text/javascript; charset=utf-8", "script"));
        assert!(!module_content("text/javascript", "style") && !module_content("text/javascript", "json"));
        assert!(module_content("text/css", "style") && module_content("application/ld+json", "json"));
        assert!(module_content("text/plain", "text") && !module_content("text/plain", "script"));
        assert!(module_content_for_ruby("application/json".into(), true) && module_content_for_ruby("text/javascript".into(), true));
    }

    #[test]
    fn an_exception_is_located_at_its_pages_top_frame() {
        let stack = "Error: x\n    at f (<snapshot>:1:2)\n    at g (http://a/s.js:10:5)\n    at http://a/t.js:3:4";
        assert_eq!(stack_location(stack), Some((false, "http://a/s.js".to_owned(), 10, 5)));
        assert_eq!(stack_location("E\n    at http://a/t.js:3:4"), Some((false, "http://a/t.js".to_owned(), 3, 4)));
        assert_eq!(stack_location("E\n    at h (eval at run (<snapshot>:1:1), <anonymous>:7:9)"), Some((true, String::new(), 7, 9)));
        // (…an evaluation's code named by the script of a URL that evaluated it, the innermost of a chain)
        assert_eq!(stack_location("E\n    at h (eval at f (http://a/s.js:1:2), <anonymous>:7:9)"), Some((true, "http://a/s.js".to_owned(), 7, 9)));
        assert_eq!(stack_location("E\n    at eval (eval at g (eval at f (http://a/s.js:1:2), <anonymous>:3:4), <anonymous>:1:7)"), Some((true, "http://a/s.js".to_owned(), 1, 7)));
        assert_eq!(stack_location("E\n    at eval (eval at http://a/s.js:1:5, <anonymous>:2:3)"), Some((true, "http://a/s.js".to_owned(), 2, 3)));
        assert_eq!(stack_location("E\n    at inline://3:2:1"), Some((true, "inline://3".to_owned(), 2, 1)));
        assert_eq!(stack_location("E\n    at inline://3@12~1:2:1"), Some((true, "inline://3@12~1".to_owned(), 2, 1)));
        assert_eq!((super::document_line("inline://3@12~1", 2), super::document_line("inline://3", 2), super::document_line("http://a/s.js", 2)), (13, 2, 2));
        assert_eq!(stack_location("no frames"), None);
        // (…a function name of parentheses its own, the location after the last ` (`; a URL of them kept)
        assert_eq!(stack_location("E\n    at foo (bar) (http://a/s.js:3:22)"), Some((false, "http://a/s.js".to_owned(), 3, 22)));
        assert_eq!(stack_location("E\n    at a(b (http://a/s.js:6:31)"), Some((false, "http://a/s.js".to_owned(), 6, 31)));
        assert_eq!(stack_location("E\n    at f (http://a/x(1).js:3:4)"), Some((false, "http://a/x(1).js".to_owned(), 3, 4)));
        assert_eq!(stack_location("E\n    at Promise.all (index 0)\n    at http://a/s.js:1:2"), Some((false, "http://a/s.js".to_owned(), 1, 2)));
        assert_eq!(stack_location("E\n    at http://a/s.js:+1:2"), None);
        assert_eq!(stack_location("E\n    at globalThis.__csim_runScript (<eval>:34:99)\n    at http://a/s.js:1:2"), Some((false, "http://a/s.js".to_owned(), 1, 2)));
    }

    fn script(attrs: &[(&str, &str)]) -> NodeData {
        let mut n = NodeData::of_kind(NodeKind::Element, Vec::new());
        n.local_name = "script".into();
        n.attributes = attrs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        n
    }

    #[test]
    fn types_a_script_as_prepare_the_script_element_does() {
        assert_eq!(script_type(&script(&[])), CLASSIC);
        assert_eq!(script_type(&script(&[("type", "")])), CLASSIC);
        assert_eq!(script_type(&script(&[("language", "")])), CLASSIC);
        assert_eq!(script_type(&script(&[("type", " Text/JavaScript\\n")])), DATA_BLOCK);
        assert_eq!(script_type(&script(&[("type", " Text/JavaScript\n")])), CLASSIC);
        assert_eq!(script_type(&script(&[("type", "text/jscript")])), CLASSIC);
        assert_eq!(script_type(&script(&[("type", "text/javascript; charset=utf-8")])), DATA_BLOCK);
        assert_eq!(script_type(&script(&[("language", "JavaScript1.5")])), CLASSIC);
        assert_eq!(script_type(&script(&[("language", "vbscript")])), DATA_BLOCK);
        assert_eq!(script_type(&script(&[("type", "MODULE")])), MODULE);
        assert_eq!(script_type(&script(&[("type", "importmap")])), IMPORT_MAP);
        assert_eq!(script_type(&script(&[("type", "speculationrules")])), SPECULATION_RULES);
        assert_eq!(script_type(&script(&[("type", "text/template")])), DATA_BLOCK);
    }

    #[test]
    fn a_script_response_is_refused_as_fetch_says() {
        let ok = |ct: &str, nosniff: &str| !script_response_refused(ct, nosniff);
        assert!(ok("text/javascript", "") && ok("text/plain", "") && ok("", ""));
        assert!(!ok("image/png", "") && !ok("text/csv", "") && !ok("video/mp4; codecs=x", ""));
        assert!(!ok("text/plain", "nosniff") && !ok("", "NoSniff, x") && ok("application/javascript", "nosniff"));
    }
}
