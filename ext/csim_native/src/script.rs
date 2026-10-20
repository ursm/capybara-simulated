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
    // HTML "prepare the script element" — for one no parser is preparing (its children changed, it was connected, its
    // `src` set), and for the parser's import maps — as far as the element decides it: an "already started" one, one with
    // neither a `src` nor child text, one not connected, and one whose type runs as nothing here (a data block,
    // speculation rules) do nothing; any other is "already started" from here (and run by the after-parse pass's
    // reckoning), and does nothing as a classic script marked `nomodule`, fires `error` with an empty `src` — an import
    // map with any, there being no external import maps — and else runs, or registers its import map.
    // (…and, `scripting` false — its node document has no browsing context — "already started" and nothing more: step 19)
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
        let src = n.plain_attr("src").map(str::is_empty);
        // (…one out of the lists its text as its end tag found it: HTML takes the source text there)
        let listed = if by == BY_PARSER_LIST { self.realm_state(n.realm).and_then(|s| s.parser_sources.get(&id)) } else { None };
        let has_text = match listed {
            Some(text) => !text.is_empty(),
            None => n.children.iter().any(|&c| self.get(c).is_some_and(|t| t.kind == NodeKind::Text && !t.data.is_empty())),
        };
        if (src.is_none() && !has_text) || (by != BY_PARSER_LIST && !self.is_connected(id)) {
            return PREPARE_NONE;
        }
        let Some(n) = self.get(id) else { return PREPARE_NONE };
        let ty = script_type(n);
        if ty != CLASSIC && ty != MODULE && ty != IMPORT_MAP {
            return PREPARE_NONE;
        }
        let nomodule = ty == CLASSIC && n.plain_attr("nomodule").is_some();
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
}

// Whether a script element blocks the parser (HTML "prepare the script element" step 31): a classic script, inline or
// neither `defer` nor `async` — which take effect on an external one alone; a module is deferred always, and an import
// map or a data block runs nothing.
fn blocks_parser(n: &crate::dom::NodeData) -> bool {
    let deferred = n.plain_attr("src").is_some() && (n.plain_attr("defer").is_some() || n.plain_attr("async").is_some());
    script_type(n) == CLASSIC && !deferred
}

impl RealmArena {
    // The parser at a deferred, async or module script's end tag (`listParserScript`): one connected then goes on the
    // list of scripts to execute after parsing — where "the end" finds it, whatever an earlier script did to it since
    // (HTML §13.2.7: the lists are kept, not the tree walked again), an inline one with the source text it has now —
    // and one in a subtree a script removed does not.
    pub(crate) fn list_parser_script(&mut self, cid: i32, id: NodeId) {
        let Some(n) = self.get_mut_quietly(id) else { return };
        n.script_flags |= SCRIPT_END_TAG;
        let runs = n.script_flags & SCRIPT_RUN == 0 && matches!(script_type(n), CLASSIC | MODULE);
        let inline = n.plain_attr("src").is_none();
        if !runs || !self.is_connected(id) {
            return;
        }
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

// Where an exception was thrown, by its V8 `stack`: its top frame of the page's (`at f (url:line:col)` / `at
// url:line:col`) — the driver's own snapshot's skipped, as a browser's bindings are no frame of a stack — as `(document,
// url, line, column)`, `document` where the frame is code the page's document compiled (an inline script, a handler
// content attribute, a string timer, `new Function`, `eval`: V8's `eval at …, <anonymous>:L:C`), whose URL is the
// document's. None for a stack of no such frame.
pub(crate) fn stack_location(stack: &str) -> Option<(bool, String, u32, u32)> {
    fn number(s: &str) -> Option<u32> {
        s.bytes().all(|b| b.is_ascii_digit()).then(|| s.parse().ok()).flatten()
    }
    fn line_col(s: &str) -> Option<(&str, u32, u32)> {
        let (rest, col) = s.rsplit_once(':')?;
        let (rest, line) = rest.rsplit_once(':')?;
        Some((rest, number(line)?, number(col)?))
    }
    for line in stack.lines() {
        let Some(frame) = line.trim_start().strip_prefix("at ").filter(|_| line.starts_with(char::is_whitespace)) else { continue };
        let evaluated = frame.contains("(eval at ").then(|| frame.strip_suffix(')')?.rsplit_once(", <anonymous>:")).flatten();
        if let Some((l, c)) = evaluated.and_then(|(_, lc)| lc.split_once(':')).and_then(|(l, c)| Some((number(l)?, number(c)?))) {
            return Some((true, String::new(), l, c));
        }
        // (…after the function's name, which a page may make anything — `foo (bar)` — the last ` (`: no script URL has a
        // space)
        let place = frame.rsplit_once(" (").map_or(frame, |(_, p)| p);
        let place = place.strip_suffix(')').unwrap_or(place);
        let Some((url, l, c)) = line_col(place) else { continue };
        // (…the driver's own frames: the snapshot's, and the host's `<eval>` its script runners are compiled under)
        if url.is_empty() || url.contains(char::is_whitespace) || url == "<snapshot>" || url == "<eval>" {
            continue;
        }
        let document = url.starts_with("inline://") || url.starts_with("csim-eval");
        return Some((document, url.to_owned(), l, c));
    }
    None
}
// __dom.stackLocation(stack) -> `[document, url, line, column]` of `stack_location`, or null.
fn stack_location_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let stack = args.get(0).to_rust_string_lossy(scope);
    let Some((document, url, line, column)) = stack_location(&stack) else { return rv.set_null() };
    let items: [v8::Local<v8::Value>; 4] = [
        v8::Boolean::new(scope, document).into(),
        v8::String::new(scope, &url).map_or_else(|| v8::undefined(scope).into(), Into::into),
        v8::Integer::new_from_unsigned(scope, line).into(),
        v8::Integer::new_from_unsigned(scope, column).into(),
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "stackLocation", stack_location_op, context_id);
    crate::dom::register(scope, ns, "parserScripts", parser_scripts_op, context_id);
    crate::dom::register(scope, ns, "listParserScript", list_parser_script_op, context_id);
    crate::dom::register(scope, ns, "takeParserList", take_parser_list_op, context_id);
    crate::dom::register(scope, ns, "takeParserSource", take_parser_source_op, context_id);
    crate::dom::register(scope, ns, "scriptBlocksParser", script_blocks_parser_op, context_id);
    crate::dom::register(scope, ns, "scriptType", script_type_op, context_id);
    crate::dom::register(scope, ns, "scriptSupports", script_supports_op, context_id);
    crate::dom::register(scope, ns, "javaScriptContent", javascript_content_op, context_id);
    crate::dom::register(scope, ns, "moduleContent", module_content_op, context_id);
    crate::dom::register(scope, ns, "modulepreloadDestination", modulepreload_destination_op, context_id);
    crate::dom::register(scope, ns, "preloadDestination", preload_destination_op, context_id);
    crate::dom::register(scope, ns, "scriptResponseRefused", script_response_refused_op, context_id);
    crate::dom::register(scope, ns, "classicScriptEncoding", classic_script_encoding_op, context_id);
    crate::dom::register(scope, ns, "scriptFlags", script_flags_op, context_id);
    crate::dom::register(scope, ns, "setScriptFlags", set_script_flags_op, context_id);
    crate::dom::register(scope, ns, "prepareScript", prepare_script_op, context_id);
}
// Capybara::Simulated::Native.javascript_content(content_type) -> the same, for the host's worker and service worker
// scripts.
pub(crate) fn javascript_content_for_ruby(content_type: String) -> bool {
    crate::mime::extract(&content_type).is_some_and(|m| is_javascript_mime(&m.essence))
}
// Whether a module script's response may be one of its `kind` — the destination its module type fetches with (HTML
// "fetch a single module script"): a JSON module's (`json`) a JSON MIME type (`application/json`, `text/json`, any
// `+json`), a CSS module's (`style`) `text/css`, a text module's (`text`) any, any other a JavaScript MIME type.
fn module_content(content_type: &str, kind: &str) -> bool {
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
// __dom.javaScriptContent(contentType) -> whether a response's `Content-Type` (Fetch "extract a MIME type") is a
// JavaScript MIME type: what a classic worker-imported script must be served as.
fn javascript_content_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let header = args.get(0).to_rust_string_lossy(scope);
    rv.set_bool(crate::mime::extract(&header).is_some_and(|m| is_javascript_mime(&m.essence)));
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
fn modulepreload_destination(as_value: &str) -> Option<&'static str> {
    let Some(named) = as_keyword(as_value) else { return Some("script") };
    MODULE_PRELOAD_DESTINATIONS.contains(&named).then_some(named)
}
// The destination a `<link rel=preload>` fetches with (HTML "translate a preload destination"): the preload destination
// its `as` names, `fetch` the empty one — None for any other (missing, empty, no keyword, a module's alone: `json`,
// `worker`), which fetches nothing (Chrome and Firefox: no request, no event).
fn preload_destination(as_value: &str) -> Option<&'static str> {
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
// JavaScript MIME type; or it failing the request's `integrity` metadata (SRI), as an opaque response — a cross-origin
// no-cors one — fails any it knows an algorithm of.
pub(crate) fn script_response_refused(content_type: &str, nosniff: &str, integrity: &str, body: &[u8], opaque: bool) -> bool {
    let essence = crate::mime::extract(content_type).map(|m| m.essence);
    let never = essence.as_deref().is_some_and(|e| {
        ["audio/", "image/", "video/"].iter().any(|p| e.starts_with(p)) || e == "text/csv"
    });
    let sniffed = crate::fetch_rules::blocked_by_nosniff("script", content_type, nosniff);
    let integrity_fails = !crate::integrity::response_matches(body, integrity, !opaque);
    never || sniffed || integrity_fails
}
// __dom.scriptResponseRefused(nid, url, contentType, nosniff, body) -> `script_response_refused` of the response the
// classic script element `nid` fetched from `url` — by its `integrity`, the body its bytes (a Uint8Array) or a string
// whose UTF-8 is them, '' where it has none; opaque where it was fetched without `crossorigin` from another origin
// than the calling realm's document's (an about:blank or srcdoc one's its creator's) — any, for an opaque one — but for
// a `data:` URL, which Fetch taints basic.
fn script_response_refused_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let [url, content_type, nosniff] = [1, 2, 3].map(|i| args.get(i).to_rust_string_lossy(scope));
    let body = match v8::Local::<v8::ArrayBufferView>::try_from(args.get(4)) {
        Ok(view) => {
            let mut bytes = vec![0u8; view.byte_length()];
            view.copy_contents(&mut bytes);
            bytes
        }
        Err(_) => args.get(4).to_rust_string_lossy(scope).into_bytes(),
    };
    let cid = crate::dom::realm_id(scope, &args);
    let origin = crate::dom::realm(scope, cid).location.origin().to_owned();
    let element = nid_arg(scope, &args, 0).and_then(|id| dom(scope).arena.get(id));
    let integrity = element.and_then(|n| n.plain_attr("integrity")).unwrap_or("").to_owned();
    let cors = element.is_some_and(|n| n.plain_attr("crossorigin").is_some());
    // (…an opaque document origin the same as no URL's: two opaque origins are never the same)
    let opaque = !cors
        && ada_url::Url::parse(&url, None).is_ok_and(|u| u.protocol() != "data:" && (origin == "null" || u.origin() != origin));
    rv.set_bool(script_response_refused(&content_type, &nosniff, &integrity, &body, opaque));
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
        assert_eq!(stack_location("E\n    at inline://3:2:1"), Some((true, "inline://3".to_owned(), 2, 1)));
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
        let ok = |ct: &str, nosniff: &str| !script_response_refused(ct, nosniff, "", b"", false);
        assert!(ok("text/javascript", "") && ok("text/plain", "") && ok("", ""));
        assert!(!ok("image/png", "") && !ok("text/csv", "") && !ok("video/mp4; codecs=x", ""));
        assert!(!ok("text/plain", "nosniff") && !ok("", "NoSniff, x") && ok("application/javascript", "nosniff"));
        let body = b"alert(1)";
        let sha = "sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI=";
        assert!(!script_response_refused("text/javascript", "", sha, body, false));
        assert!(script_response_refused("text/javascript", "", "sha256-AAAA", body, false));
        assert!(script_response_refused("text/javascript", "", sha, body, true));
        assert!(!script_response_refused("text/javascript", "", "md5-xx", body, true));
    }
}
