// Module scripts (HTML §8.1.4): a document's module map — its entries keyed by (URL, module type), each being fetched, a
// module script, or none (a fetch that failed, which the map forgets: the next asker fetches again) — its import map and
// resolved module set (import_map.rs), and the fetch of a module script graph as "prepare the script element" begins it:
// the graph's entry fetched (or an inline one's source taken), then, as each module comes in, its requests validated
// and resolved all at once (HostLoadImportedModule's first-request check: a specifier that resolves to none, a `type`
// no module type is — a TypeError, the graph's error to rethrow, none of that module's descendants fetched) and the
// descendants it names fetched in parallel, each a script fetch's slot of the host's (browser.rb `module_fetch_start`)
// that lands as far after it began as its server took — the graph's script landing as its last module comes in
// (script_fetch.rs, script_lists.rs: the event loop runs on meanwhile, Chrome and Firefox `t100 x-ran m-ran` for a module
// whose import's server takes 300 ms, csim-bench mod8 `t_graph`, `t_par`).
//
// A module's record is the host's: the host compiles what came in (`H_MODULE_TAKE`, `H_MODULE_INLINE`) into a module
// record of the realm's, by a number the map keeps, and links and evaluates the graph as the script runs (v8_runtime.rb
// `eval_module_graph`) by the links the map hands it (`moduleGraphResult`). Its requests — each specifier and its
// `type` import attribute — the map reads off the source the host compiled, compiled again here (the isolate's
// compilation cache answers the second compile of one source under one name).

use std::collections::{HashMap, HashSet};

use crate::dom::{realm, realm_id, register};
use crate::font_files::Terminated;
use crate::import_map::{self, ImportMap, Resolved};
use crate::subresource_obtain::{call, next_slot, slept_ms, text};

// What the map asks of the host (subresource-host.js):
//   H_MODULE_START (url, plan, referrer, integrity, type, began, id)
//                                     a module's fetch begun at `began`, its request made now, filed as slot `id`: the
//                                     time its server took — null where none began (a URL that resolves to none)
//   H_MODULE_TAKE (id, type)          its answer as it lands, compiled: `[record, source, base URL]` — the record's number,
//                                     the source text a JavaScript one was compiled from, the response's URL — or a parse
//                                     error `[name, message, filename, lineno]`, null for none (a network error, a MIME
//                                     type no module of its type is, an integrity mismatch) — or how many milliseconds later
//                                     it lands (a controlling worker let it through to a server that took time)
//   H_MODULE_INLINE (source, base URL) an inline module script's source compiled, answered as `H_MODULE_TAKE` answers
pub(crate) const H_MODULE_START: u32 = 34;
pub(crate) const H_MODULE_TAKE: u32 = 35;
pub(crate) const H_MODULE_INLINE: u32 = 36;

// A module type (HTML "module type from module request").
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum ModuleType {
    JavaScript = 0,
    Json = 1,
    Css = 2,
    Text = 3,
}
impl ModuleType {
    // …a request's of its `type` attribute (none: a JavaScript one), as "module type allowed" allows it — none for a
    // `type` that names no module type ("javascript-or-wasm" itself is none), nor `css` where the realm has no
    // CSSStyleSheet (a worker's).
    pub(crate) fn of_request(type_attribute: Option<&str>, css: bool) -> Option<ModuleType> {
        match type_attribute {
            None => Some(ModuleType::JavaScript),
            Some("json") => Some(ModuleType::Json),
            Some("css") if css => Some(ModuleType::Css),
            Some("text") => Some(ModuleType::Text),
            Some(_) => None,
        }
    }
    // …a modulepreload's of the module preload destination its `as` names (HTML "fetch a modulepreload module script
    // graph": `json`, `style`, `text`; a script-like one JavaScript).
    fn of_destination(destination: &str) -> ModuleType {
        match destination {
            "json" => ModuleType::Json,
            "style" => ModuleType::Css,
            "text" => ModuleType::Text,
            _ => ModuleType::JavaScript,
        }
    }
    fn of_code(code: u32) -> ModuleType {
        match code {
            1 => ModuleType::Json,
            2 => ModuleType::Css,
            3 => ModuleType::Text,
            _ => ModuleType::JavaScript,
        }
    }
}
// The destination a module of the module type `code` is fetched with (HTML "fetch destination from module type").
pub(crate) fn destination(code: u32) -> &'static str {
    match ModuleType::of_code(code) {
        ModuleType::JavaScript => "script",
        ModuleType::Json => "json",
        ModuleType::Css => "style",
        ModuleType::Text => "text",
    }
}

// Capybara::Simulated::Native.module_body(source, type) -> the JavaScript module the host compiles a module script of the
// module type `type` as — None for a JSON one whose source is no JSON (its parse error a SyntaxError): a JavaScript
// one's source itself; a JSON one's value its default export (HTML "create a JSON module script", ParseJSONModule); a CSS
// one's a constructed sheet its source's rules replace (HTML "create a CSS module script"); a text one's its text.
// KNOWN GAP (rusty_racer): HTML makes the three a synthetic module (CreateDefaultExportSyntheticModule), which the engine's
// API cannot; a CSS module's sheet is constructed by the realm's `CSSStyleSheet` as the module evaluates, which a page that
// replaced the global replaces — and a JSON one nested past `JSON_LITERAL_DEPTH` is parsed by the realm's `JSON.parse` as
// it evaluates, so JSON that is none throws then, an evaluation error, not a parse error that keeps its graph from running.
pub(crate) fn module_body(source: String, code: u32) -> Option<String> {
    let literal = |text: &str| serde_json::to_string(text).unwrap_or_default();
    Some(match ModuleType::of_code(code) {
        ModuleType::JavaScript => source,
        ModuleType::Json => match json_literal(&source) {
            Some(value) => format!("export default {value};"),
            // (…one nested past what a literal of it compiles to: parsed by JSON.parse as it evaluates — a JSON text that
            // is none then thrown as it does, a SyntaxError)
            None if nested_past(&source, JSON_LITERAL_DEPTH) => format!("export default JSON.parse({});", literal(&source)),
            None => return None,
        },
        ModuleType::Css => format!("const sheet = new CSSStyleSheet();\nsheet.replaceSync({});\nexport default sheet;", literal(&source)),
        ModuleType::Text => format!("export default {};", literal(&source)),
    })
}
// How deep a JSON text's arrays and objects nest at most for its literal: deeper, the literal no compile takes (V8's
// parser recurses), and none of the walk below's recursion either.
const JSON_LITERAL_DEPTH: usize = 512;
// Whether `text`'s brackets, outside its strings, nest past `depth`.
fn nested_past(text: &str, depth: usize) -> bool {
    let (mut level, mut in_string, mut escaped) = (0usize, false, false);
    for b in text.bytes() {
        match (in_string, b) {
            (true, _) if escaped => escaped = false,
            (true, b'\\') => escaped = true,
            (true, b'"') => in_string = false,
            (true, _) => {}
            (false, b'"') => in_string = true,
            (false, b'[' | b'{') => {
                level += 1;
                if level > depth {
                    return true;
                }
            }
            (false, b']' | b'}') => level = level.saturating_sub(1),
            _ => {}
        }
    }
    false
}
// A JSON text as a JavaScript expression of the value JSON.parse makes of it — None for one that is no JSON text (ECMA-404,
// whitespace around it), or one nested past `JSON_LITERAL_DEPTH`: the text itself, each member name made a computed property name, as JSON.parse defines every
// member as an own data property (`"__proto__"` too, which a literal's plain name would make the object's prototype).
fn json_literal(text: &str) -> Option<String> {
    struct Copy<'t> {
        bytes: &'t [u8],
        at: usize,
        out: String,
    }
    impl Copy<'_> {
        fn ws(&mut self) {
            while matches!(self.bytes.get(self.at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
                self.at += 1;
            }
        }
        fn take(&mut self, n: usize) {
            let text = std::str::from_utf8(&self.bytes[self.at..self.at + n]).unwrap_or_default();
            self.out.push_str(text);
            self.at += n;
        }
        fn value(&mut self, depth: usize) -> Option<()> {
            if depth > JSON_LITERAL_DEPTH {
                return None;
            }
            self.ws();
            match *self.bytes.get(self.at)? {
                b'{' => {
                    self.take(1);
                    self.ws();
                    if self.bytes.get(self.at) == Some(&b'}') {
                        self.take(1);
                        return Some(());
                    }
                    loop {
                        self.ws();
                        self.out.push('[');
                        self.string()?;
                        self.out.push(']');
                        self.ws();
                        (self.bytes.get(self.at) == Some(&b':')).then(|| self.take(1))?;
                        self.value(depth + 1)?;
                        self.ws();
                        match self.bytes.get(self.at)? {
                            b',' => self.take(1),
                            b'}' => return Some(self.take(1)),
                            _ => return None,
                        }
                    }
                }
                b'[' => {
                    self.take(1);
                    self.ws();
                    if self.bytes.get(self.at) == Some(&b']') {
                        self.take(1);
                        return Some(());
                    }
                    loop {
                        self.value(depth + 1)?;
                        self.ws();
                        match self.bytes.get(self.at)? {
                            b',' => self.take(1),
                            b']' => return Some(self.take(1)),
                            _ => return None,
                        }
                    }
                }
                b'"' => self.string(),
                b't' | b'f' | b'n' => {
                    let rest = &self.bytes[self.at..];
                    let word = [&b"true"[..], b"false", b"null"].into_iter().find(|w| rest.starts_with(w))?;
                    self.take(word.len());
                    Some(())
                }
                _ => self.number(),
            }
        }
        fn string(&mut self) -> Option<()> {
            (self.bytes.get(self.at) == Some(&b'"')).then_some(())?;
            let start = self.at;
            self.at += 1;
            loop {
                match *self.bytes.get(self.at)? {
                    b'"' => break,
                    b'\\' => {
                        match *self.bytes.get(self.at + 1)? {
                            b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => self.at += 2,
                            b'u' if self.bytes.get(self.at + 2..self.at + 6)?.iter().all(u8::is_ascii_hexdigit) => self.at += 6,
                            _ => return None,
                        }
                    }
                    c if c < 0x20 => return None,
                    _ => self.at += 1,
                }
            }
            self.at += 1;
            let end = self.at;
            self.at = start;
            self.take(end - start);
            Some(())
        }
        fn number(&mut self) -> Option<()> {
            let start = self.at;
            let digits = |c: &mut Self| {
                let from = c.at;
                while c.bytes.get(c.at).is_some_and(u8::is_ascii_digit) {
                    c.at += 1;
                }
                (c.at > from).then_some(())
            };
            if self.bytes.get(self.at) == Some(&b'-') {
                self.at += 1;
            }
            match self.bytes.get(self.at)? {
                b'0' => self.at += 1,
                b'1'..=b'9' => digits(self)?,
                _ => return None,
            }
            if self.bytes.get(self.at) == Some(&b'.') {
                self.at += 1;
                digits(self)?;
            }
            if matches!(self.bytes.get(self.at), Some(b'e' | b'E')) {
                self.at += 1;
                if matches!(self.bytes.get(self.at), Some(b'+' | b'-')) {
                    self.at += 1;
                }
                digits(self)?;
            }
            let end = self.at;
            self.at = start;
            // (…parenthesized: `-0` stays negative zero, and a member access after none can follow it)
            self.out.push('(');
            self.take(end - start);
            self.out.push(')');
            Some(())
        }
    }
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut copy = Copy { bytes: text.as_bytes(), at: 0, out: String::with_capacity(text.len() + 16) };
    copy.value(0)?;
    copy.ws();
    (copy.at == copy.bytes.len()).then_some(copy.out)
}
type Key = (String, ModuleType);

// The global's module map, import map and resolved module set (`RealmState::modules`), and the graphs it fetches.
#[derive(Default)]
pub(crate) struct ModuleMap {
    import_map: ImportMap,
    resolved: Vec<Resolved>,
    resolved_set: HashSet<Resolved>,
    entries: HashMap<Key, Entry>,
    graphs: Vec<Graph>,
    next_graph: u32,
    // The fetch options of the scripts an `import()` may name as its referrer that are no entry of the map — a classic
    // script's (by its name: its URL, an inline one's `inline://…`), an inline module script's (by its base URL, its
    // document's) — None where two of one name have different ones: their `import()`s take the defaults (KNOWN GAP,
    // rusty_racer: the engine's dynamic-import hook names a script by its resource name alone, no host-defined options).
    referring: HashMap<String, Option<u32>>,
    // The realm's host steps (subresource-host.js), which a graph's fetches go on through as they are asked about.
    host: Option<v8::Global<v8::Function>>,
}

enum Entry {
    // Its fetch under way: the host's slot, landing at `due` on the event loop's clock, made with the fetch options `plan`
    // (the referring module's, or its graph's), which its own imports are fetched with.
    Fetching { slot: u32, due: f64, plan: u32 },
    // None to be had: what a graph waiting on it reads as a failure; the next one to ask fetches again.
    Failed,
    // A module script, which came in at `at`.
    Ready(Script, f64),
}

// A module script (HTML "module script").
struct Script {
    // The host's record of it, 0 for one with a parse error.
    record: u32,
    parse_error: Option<Rethrow>,
    // Its base URL: its response's URL (a redirect's end), an inline one's its document's base URL.
    base: String,
    // Its module requests, in source order as its record has them (V8 GetModuleRequests): the specifier and the module
    // type its `type` attribute names, None for one no module type is.
    requests: Vec<(String, Option<ModuleType>)>,
    // Its fetch options (the request plan its graph's fetches are made with, subresource_plan.rs).
    plan: u32,
    // What its requests resolved to, as a graph first came to it — each module once: the resolved module set keeps
    // resolution stable.
    resolved: Option<Vec<Key>>,
    // Whether the host has its links (`moduleGraphResult`).
    linked: bool,
}

// An error to rethrow, as the host reports it: its kind, its message, and where V8 found it.
#[derive(Clone)]
struct Rethrow {
    name: String,
    message: String,
    filename: Option<String>,
    lineno: Option<i32>,
}
impl Rethrow {
    fn type_error(message: String) -> Rethrow {
        Rethrow { name: "TypeError".to_owned(), message, filename: None, lineno: None }
    }
}

// A graph being fetched (HTML "fetch the descendants of and link"): its root — an entry of the map, or an inline module
// script of its own — its fetch options, the entries it waits on (each with the time it came to it), and those it has
// come to.
struct Graph {
    id: u32,
    root: Root,
    plan: u32,
    waiting: Vec<(Key, f64)>,
    visited: HashSet<Key>,
    // A modulepreload's: its entry alone, none of its descendants fetched (HTML "fetch a modulepreload module script
    // graph" leaves them optional).
    single: bool,
    // What failed it first, in the order its modules came in (HTML "fetch the descendants of and link": the first parse,
    // resolution or type error its loading met its error to rethrow; a fetch that failed while none had, the graph null).
    failed: Option<Outcome>,
}
enum Root {
    Entry(Key),
    Inline(Script),
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "importMapRegister", import_map_register_op, context_id);
    register(scope, ns, "moduleResolve", module_resolve_op, context_id);
    register(scope, ns, "moduleScriptFetch", module_script_fetch_op, context_id);
    register(scope, ns, "moduleGraphResult", module_graph_result_op, context_id);
    register(scope, ns, "moduleImport", module_import_op, context_id);
    register(scope, ns, "noteReferringScript", note_referring_script_op, context_id);
    register(scope, ns, "moduleGraphBegin", module_graph_begin_op, context_id);
    register(scope, ns, "moduleGraphDue", module_graph_due_op, context_id);
    register(scope, ns, "modulePreloadBegin", module_preload_begin_op, context_id);
    register(scope, ns, "modulePreloadLoaded", module_preload_loaded_op, context_id);
    register(scope, ns, "modulePreloadsAbort", module_preloads_abort_op, context_id);
}

fn map_of<'s>(scope: &'s mut v8::PinScope<'_, '_>, cid: i32) -> Option<&'s mut ModuleMap> {
    realm(scope, cid).realm_state_mut(cid).map(|s| &mut s.modules)
}
fn string_arg(scope: &mut v8::PinScope<'_, '_>, v: v8::Local<'_, v8::Value>) -> Option<String> {
    v.is_string().then(|| v.to_rust_string_lossy(scope))
}

// ── the import map ──

// __dom.importMapRegister(text, base) — HTML "register an import map": the map `text` parses to against `base` merged
// into the document's ("merge existing and new import maps", its resolved module set heeded); where `text` is no import
// map, the SyntaxError or TypeError parsing it throws.
fn import_map_register_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (map_text, base) = (args.get(0).to_rust_string_lossy(scope), args.get(1).to_rust_string_lossy(scope));
    let new = match import_map::parse(&map_text, &base) {
        Ok(new) => new,
        Err(error) => {
            let message = v8::String::new(scope, "Failed to parse import map").unwrap();
            let exception = match error {
                import_map::ParseError::Syntax => v8::Exception::syntax_error(scope, message),
                import_map::ParseError::Type => v8::Exception::type_error(scope, message),
            };
            scope.throw_exception(exception);
            return;
        }
    };
    let cid = realm_id(scope, &args);
    if let Some(map) = map_of(scope, cid) {
        import_map::merge(&mut map.import_map, new, &map.resolved);
    }
}

impl ModuleMap {
    // HTML "resolve a module specifier" against `base` through the import map: the URL, the resolution added to the
    // resolved module set — None for a TypeError.
    fn resolve(&mut self, specifier: &str, base: &str) -> Option<String> {
        let (url, record) = import_map::resolve(&self.import_map, specifier, base)?;
        if self.resolved_set.insert(record.clone()) {
            self.resolved.push(record);
        }
        Some(url)
    }
    // …and "resolve a module integrity metadata".
    fn integrity(&self, url: &str) -> &str {
        import_map::integrity(&self.import_map, url)
    }
}
// What a specifier that resolves to none throws.
fn unresolved(specifier: &str) -> Rethrow {
    Rethrow::type_error(format!("Failed to resolve module specifier \"{specifier}\". Relative references must start with either \"/\", \"./\", or \"../\"."))
}

// __dom.moduleResolve(specifier, base) -> the URL `specifier` resolves to against `base` (`ModuleMap::resolve`), null for
// a TypeError.
fn module_resolve_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (specifier, base) = (args.get(0).to_rust_string_lossy(scope), args.get(1).to_rust_string_lossy(scope));
    let cid = realm_id(scope, &args);
    match map_of(scope, cid).and_then(|map| map.resolve(&specifier, &base)) {
        Some(url) => rv.set(text(scope, &url)),
        None => rv.set_null(),
    }
}

// ── fetching a graph ──

// __dom.moduleScriptFetch(el, url, source, host, scanned) -> the number of the script fetch (script_fetch.rs) of the
// module script `el`'s graph, begun as "prepare the script element" begins it: "fetch an external module script graph"
// from `url` (resolved; null for one that is not, which fetches nothing — 0) — its entry's request the element's plan
// of it, its integrity metadata its `integrity` attribute's or, of none, the import map's — or "fetch an inline module
// script graph" of `source`, its base URL its document's. One a preload scanner saw (`scanned`) is dated as its parse
// began.
fn module_script_fetch_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_uint32(0);
    let Some(el) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let (url, source) = (string_arg(scope, args.get(1)), string_arg(scope, args.get(2)));
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(3)) else { return };
    let scanned = args.get(4).is_true();
    let cid = realm_id(scope, &args);
    rv.set_uint32(begin_script(scope, cid, el, url, source, host, scanned).unwrap_or(0));
}
// …begun (`moduleScriptFetch`): the number of its script fetch, 0 for none.
pub(crate) fn begin_script(scope: &mut v8::PinScope<'_, '_>, cid: i32, el: crate::dom::NodeId, url: Option<String>, source: Option<String>, host: v8::Local<'_, v8::Function>, scanned: bool) -> Result<u32, Terminated> {
    let Some(doc) = crate::node_handle::node_document_of(scope, el) else { return Ok(0) };
    keep_host(scope, cid, host);
    let arena = realm(scope, cid);
    let plan = crate::subresource_plan::plan_in(arena, crate::subresource_plan::J_MODULE_SCRIPT, Some(el), Some(doc), None);
    let began = crate::script_fetch::began_at(arena, cid, scanned);
    let gid = match (url, source) {
        (Some(url), _) => {
            let integrity = arena.get(el).and_then(|n| n.plain_attr("integrity")).map(str::to_owned);
            begin_external(scope, cid, url, plan, integrity, began)?
        }
        (None, Some(source)) => {
            let base = arena.document_base_url(doc);
            begin_inline(scope, cid, source, base, plan, began)?
        }
        (None, None) => None,
    };
    Ok(gid.map_or(0, |gid| crate::script_fetch::file_module(scope, cid, el, began, gid)))
}
// __dom.moduleGraphBegin(url, host) -> the number of a graph of the realm's begun from `url`, of no element: a worker's
// (HTML "fetch a module worker script graph"), its fetch options the defaults; 0 for none.
fn module_graph_begin_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_uint32(0);
    let url = args.get(0).to_rust_string_lossy(scope);
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return };
    let cid = realm_id(scope, &args);
    keep_host(scope, cid, host);
    let arena = realm(scope, cid);
    let plan = crate::subresource_plan::plan_in(arena, crate::subresource_plan::J_MODULE_SCRIPT, None, None, None);
    let began = arena.event_loop.clock;
    if let Ok(Some(gid)) = begin_external(scope, cid, url, plan, None, began) {
        rv.set_uint32(gid);
    }
}
// __dom.moduleGraphDue(gid) -> how many milliseconds after now the graph `gid` next goes on (`advance`, as far as the event
// loop's clock has come), 0 for one whose every module is in, -1 for none: what a worker's graph waits on with a timer.
fn module_graph_due_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let gid = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    match advance_due(scope, cid, gid) {
        Ok(due) => rv.set_double(due.unwrap_or(-1.0)),
        Err(_) => rv.set_double(-1.0),
    }
}
fn keep_host(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>) {
    let kept = map_of(scope, cid).is_some_and(|map| map.host.is_some());
    if !kept {
        let host = v8::Global::new(scope, host);
        if let Some(map) = map_of(scope, cid) {
            map.host = Some(host);
        }
    }
}
fn host_of<'s>(scope: &mut v8::PinScope<'s, '_>, cid: i32) -> Option<v8::Local<'s, v8::Function>> {
    let host = map_of(scope, cid)?.host.clone()?;
    Some(v8::Local::new(scope, host))
}

impl ModuleMap {
    // …a script named `name`, of the fetch options `plan`, that an `import()` may name as its referrer.
    fn note_referring(&mut self, name: &str, plan: u32) {
        let kept = self.referring.entry(name.to_owned()).or_insert(Some(plan));
        if *kept != Some(plan) {
            *kept = None;
        }
    }
}
// __dom.noteReferringScript(name, el) — the classic script `el`, named `name`, about to run: its fetch options (HTML
// "script fetch options": its `crossorigin`'s credentials mode, its `referrerpolicy`) kept for an `import()` it makes.
fn note_referring_script_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let name = args.get(0).to_rust_string_lossy(scope);
    let Some(el) = crate::dom::nid_arg(scope, &args, 1) else { return };
    let cid = realm_id(scope, &args);
    let doc = crate::node_handle::node_document_of(scope, el);
    let plan = crate::subresource_plan::plan_in(realm(scope, cid), crate::subresource_plan::J_MODULE_SCRIPT, Some(el), doc, None);
    if let Some(map) = map_of(scope, cid) {
        map.note_referring(&name, plan);
    }
}

fn new_graph(scope: &mut v8::PinScope<'_, '_>, cid: i32, root: Root, plan: u32, waiting: Vec<(Key, f64)>) -> Option<u32> {
    let map = map_of(scope, cid)?;
    map.next_graph += 1;
    let id = map.next_graph;
    let visited = waiting.iter().map(|(k, _)| k.clone()).collect();
    map.graphs.push(Graph { id, root, plan, waiting, visited, single: false, failed: None });
    Some(id)
}
// …an external one's: its entry's, as the map has it or as its fetch begins (`integrity` the element's, none of one with
// no `integrity` attribute: the import map's).
fn begin_external(scope: &mut v8::PinScope<'_, '_>, cid: i32, url: String, plan: u32, integrity: Option<String>, began: f64) -> Result<Option<u32>, Terminated> {
    let key = (url, ModuleType::JavaScript);
    ensure_fetch(scope, cid, &key, plan, None, integrity, began, 0)?;
    Ok(new_graph(scope, cid, Root::Entry(key.clone()), plan, vec![(key, began)]))
}
// …an inline one's: its source compiled now, its descendants' fetches begun.
fn begin_inline(scope: &mut v8::PinScope<'_, '_>, cid: i32, source: String, base: String, plan: u32, began: f64) -> Result<Option<u32>, Terminated> {
    let Some(host) = host_of(scope, cid) else { return Ok(None) };
    let (source_value, base_value) = (text(scope, &source), text(scope, &base));
    let answer = call(scope, host, H_MODULE_INLINE, &[source_value, base_value])?;
    let Some(script) = script_of(scope, cid, answer, ModuleType::JavaScript, &base, plan) else { return Ok(None) };
    if let Some(map) = map_of(scope, cid) {
        map.note_referring(&base, plan);
    }
    let Some(gid) = new_graph(scope, cid, Root::Inline(script), plan, Vec::new()) else { return Ok(None) };
    walk(scope, cid, gid, None, began)?;
    Ok(Some(gid))
}

// The entry `key` being fetched, or had: its fetch begun at `began` where the map has none — or one that failed (HTML
// "fetch a single module script": the map forgets a failure) — its request `plan`'s, referred by `referrer` (the
// referring script's base URL; none: its client), with `integrity` (none: the import map's).
// (…`initiator` the consumer kind its Resource Timing entry is filed as, a link's for a modulepreload's — 0: a module
// script's)
fn ensure_fetch(scope: &mut v8::PinScope<'_, '_>, cid: i32, key: &Key, plan: u32, referrer: Option<&str>, integrity: Option<String>, began: f64, initiator: u32) -> Result<(), Terminated> {
    let Some(map) = map_of(scope, cid) else { return Ok(()) };
    if matches!(map.entries.get(key), Some(Entry::Fetching { .. } | Entry::Ready(..))) {
        return Ok(());
    }
    let integrity = integrity.unwrap_or_else(|| map.integrity(&key.0).to_owned());
    let Some(host) = host_of(scope, cid) else { return Ok(()) };
    let id = next_slot();
    let args = [
        text(scope, &key.0),
        v8::Integer::new_from_unsigned(scope, plan).into(),
        crate::subresource_obtain::text_or_null(scope, referrer),
        text(scope, &integrity),
        v8::Integer::new_from_unsigned(scope, key.1 as u32 | initiator << 8).into(),
        v8::Number::new(scope, began).into(),
        v8::Integer::new_from_unsigned(scope, id).into(),
    ];
    let started = call(scope, host, H_MODULE_START, &args)?.map(|s| v8::Local::new(scope, s)).filter(|s| s.is_number());
    let entry = match started {
        Some(slept) => Entry::Fetching { slot: id, due: began + slept_ms(scope, slept), plan },
        None => Entry::Failed,
    };
    if let Some(map) = map_of(scope, cid) {
        map.entries.insert(key.clone(), entry);
    }
    Ok(())
}

// A module script of what the host answered compiling one of `ty` (`H_MODULE_TAKE`) — its parse error where that is what
// it answered, its requests read off a JavaScript one's source — None for none.
fn script_of(scope: &mut v8::PinScope<'_, '_>, cid: i32, answer: Option<v8::Global<v8::Value>>, ty: ModuleType, url: &str, plan: u32) -> Option<Script> {
    let answer = answer.map(|a| v8::Local::new(scope, a))?;
    let answer = v8::Local::<v8::Array>::try_from(answer).ok()?;
    let first = answer.get_index(scope, 0)?;
    let script = |record, parse_error, base: String, requests| Script { record, parse_error, base, requests, plan, resolved: None, linked: false };
    if !first.is_number() {
        let name = first.to_rust_string_lossy(scope);
        let message = answer.get_index(scope, 1).map(|m| m.to_rust_string_lossy(scope)).unwrap_or_default();
        let filename = answer.get_index(scope, 2).filter(|f| f.is_string()).map(|f| f.to_rust_string_lossy(scope));
        let lineno = answer.get_index(scope, 3).filter(|l| l.is_number()).and_then(|l| l.int32_value(scope));
        return Some(script(0, Some(Rethrow { name, message, filename, lineno }), url.to_owned(), Vec::new()));
    }
    let record = first.uint32_value(scope).unwrap_or(0);
    let base = answer.get_index(scope, 2).filter(|b| b.is_string()).map_or_else(|| url.to_owned(), |b| b.to_rust_string_lossy(scope));
    let requests = match answer.get_index(scope, 1).and_then(|s| v8::Local::<v8::String>::try_from(s).ok()) {
        // (…a CSS module's type allowed where the realm has CSSStyleSheet: a window's, no worker's)
        Some(source) if ty == ModuleType::JavaScript => {
            let css = realm(scope, cid).realm_document(cid).is_some();
            module_requests(scope, source, &base, css)
        }
        _ => Vec::new(),
    };
    Some(script(record, None, base, requests))
}

// A JavaScript module's requests, compiled from its `source` under its name `name` as the host compiled it — the
// isolate's compilation cache answers — each its specifier and the module type its import attributes name: V8 has
// refused, as a SyntaxError of the host's compile, any attribute but `type` (HTML HostGetSupportedImportAttributes).
fn module_requests(scope: &mut v8::PinScope<'_, '_>, source: v8::Local<'_, v8::String>, name: &str, css: bool) -> Vec<(String, Option<ModuleType>)> {
    let Some(name) = v8::String::new(scope, name) else { return Vec::new() };
    let origin = v8::ScriptOrigin::new(scope, name.into(), 0, 0, false, -1, None, false, false, true, None);
    let mut compiled = v8::script_compiler::Source::new(source, Some(&origin));
    v8::tc_scope!(let tc, scope);
    let Some(module) = v8::script_compiler::compile_module(tc, &mut compiled) else { return Vec::new() };
    let requests = module.get_module_requests();
    let mut out = Vec::with_capacity(requests.length());
    for i in 0..requests.length() {
        let Some(request) = requests.get(tc, i).and_then(|r| v8::Local::<v8::ModuleRequest>::try_from(r).ok()) else { continue };
        let specifier = request.get_specifier().to_rust_string_lossy(tc);
        let attributes = request.get_import_attributes();
        let mut type_attribute = None;
        for at in (0..attributes.length()).step_by(3) {
            let key = attributes.get(tc, at).and_then(|k| v8::Local::<v8::String>::try_from(k).ok());
            if key.is_some_and(|k| k.to_rust_string_lossy(tc) == "type") {
                type_attribute = attributes.get(tc, at + 1).and_then(|v| v8::Local::<v8::String>::try_from(v).ok()).map(|v| v.to_rust_string_lossy(tc));
            }
        }
        out.push((specifier, ModuleType::of_request(type_attribute.as_deref(), css)));
    }
    out
}

// The graph `gid` gone on with — as far as the event loop's clock has come (`sync`: every fetch it waits on taken now,
// whatever its server's time: a dynamic import's, which a script waits inside) — how long until it next goes on, 0 for
// a graph whose every module is in, or one a failure ended; None for none. The entries it waits on are come to in the order of the times they
// come in (each fetch's landing; one in already, as the graph reached it), so a module's imports are requested in that
// order — the host's slots, its server's view, the cookies its responses set — however many land by now.
// (…its waits held in a queue of this call's while it goes on, the graph's list empty meanwhile: no page script runs
// inside it to find them so. What it asks of the host as a module lands (`H_MODULE_TAKE`) is the response — its server's
// sleeps counted in its slot, never run on the event loop (browser.rb `script_fetch_make`; a passthrough's slot never
// joins a flight under way, whose wait would) — a controlling worker's answer, waited for in place with the window's
// event loop stopped (`await_worker_reply`'s follower: the jobs the worker waits on run there, what they tell the page
// told it at its next step, a message a client is posted delivered then), and the compile, which evaluates nothing.
// spec/module_map_spec.rb "runs none of the page's script inside a module's landing")
fn advance(scope: &mut v8::PinScope<'_, '_>, cid: i32, gid: u32, sync: bool) -> Result<Option<f64>, Terminated> {
    let now = realm(scope, cid).event_loop.clock;
    let Some(map) = map_of(scope, cid) else { return Ok(None) };
    let Some(graph) = map.graphs.iter_mut().find(|g| g.id == gid) else { return Ok(None) };
    if graph.failed.is_some() {
        return Ok(Some(0.0));
    }
    let mut queue = Queue::default();
    let waiting = std::mem::take(&mut graph.waiting);
    queue.add(&map.entries, waiting);
    let mut next = None;
    while let Some((at, key, reached)) = queue.pop() {
        if !sync && at > now + 1e-6 {
            next = Some(at);
            queue.put_back(at, key, reached);
            break;
        }
        if let Some(&Entry::Fetching { slot, due, plan }) = map_of(scope, cid).and_then(|map| map.entries.get(&key)) {
            land(scope, cid, &key, slot, due, plan)?;
            // (…one landing later than it was due: waited for again)
            if let Some(&Entry::Fetching { due, .. }) = map_of(scope, cid).and_then(|map| map.entries.get(&key)) {
                queue.put_back(due, key, reached);
                continue;
            }
        }
        walk(scope, cid, gid, Some(&key), reached)?;
        let Some(map) = map_of(scope, cid) else { return Ok(None) };
        let Some(graph) = map.graphs.iter_mut().find(|g| g.id == gid) else { return Ok(None) };
        let reached = std::mem::take(&mut graph.waiting);
        queue.add(&map.entries, reached);
        // (…a failure met: its loading rejected at once — onComplete run, none of its other descendants requested)
        if graph.failed.is_some() {
            next = None;
            break;
        }
    }
    let Some(map) = map_of(scope, cid) else { return Ok(None) };
    if let Some(graph) = map.graphs.iter_mut().find(|g| g.id == gid) {
        graph.waiting = queue.into_waiting();
    }
    Ok(Some(next.map_or(0.0, |at| (at - now).max(1e-3))))
}
// The entries a graph waits on, by the time each comes in: its fetch's landing, or — one in already, or failed — the
// time the graph reached it.
#[derive(Default)]
struct Queue {
    heap: std::collections::BinaryHeap<std::cmp::Reverse<(At, u64)>>,
    items: Vec<Option<(Key, f64)>>,
}
#[derive(PartialEq, PartialOrd)]
struct At(f64);
impl Eq for At {}
impl Ord for At {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&other.0)
    }
}
impl Queue {
    fn add(&mut self, entries: &HashMap<Key, Entry>, waiting: Vec<(Key, f64)>) {
        for (key, reached) in waiting {
            let at = match entries.get(&key) {
                Some(&Entry::Fetching { due, .. }) => due,
                _ => reached,
            };
            self.put_back(at, key, reached);
        }
    }
    fn put_back(&mut self, at: f64, key: Key, reached: f64) {
        self.heap.push(std::cmp::Reverse((At(at), self.items.len() as u64)));
        self.items.push(Some((key, reached)));
    }
    fn pop(&mut self) -> Option<(f64, Key, f64)> {
        let std::cmp::Reverse((At(at), i)) = self.heap.pop()?;
        let (key, reached) = self.items[i as usize].take()?;
        Some((at, key, reached))
    }
    fn into_waiting(self) -> Vec<(Key, f64)> {
        let mut order: Vec<_> = self.heap.into_iter().map(|std::cmp::Reverse((_, i))| i).collect();
        order.sort_unstable();
        let mut items = self.items;
        order.into_iter().filter_map(|i| items[i as usize].take()).collect()
    }
}
// The entry `key`'s fetch, slot `slot`, landed at `due`: taken, compiled — a module script of the fetch options `plan`
// (its fetch's), or none.
fn land(scope: &mut v8::PinScope<'_, '_>, cid: i32, key: &Key, slot: u32, due: f64, plan: u32) -> Result<(), Terminated> {
    let Some(host) = host_of(scope, cid) else { return Ok(()) };
    let (id, ty) = (v8::Integer::new_from_unsigned(scope, slot).into(), v8::Integer::new_from_unsigned(scope, key.1 as u32).into());
    let answer = call(scope, host, H_MODULE_TAKE, &[id, ty])?;
    // (…a controlling worker letting it through to a server that takes time: its fetch going on that much later)
    let later = answer.as_ref().map(|a| v8::Local::new(scope, a)).filter(|a| a.is_number());
    if let Some(later) = later {
        let due = due + slept_ms(scope, later);
        if let Some(map) = map_of(scope, cid) {
            map.entries.insert(key.clone(), Entry::Fetching { slot, due, plan });
        }
        return Ok(());
    }
    let entry = match script_of(scope, cid, answer, key.1, &key.0, plan) {
        Some(script) => Entry::Ready(script, due),
        None => Entry::Failed,
    };
    if let Some(map) = map_of(scope, cid) {
        map.entries.insert(key.clone(), entry);
    }
    Ok(())
}
// The graph `gid` come to its module script `key` (None: its inline root), which it reached at `reached`: its requests
// resolved — the first time any graph comes to it — and the fetches of those it has not come to begun, as it came in or
// as the graph reached it, whichever is later. (…a failed one nothing: the graph's result is null)
fn walk(scope: &mut v8::PinScope<'_, '_>, cid: i32, gid: u32, key: Option<&Key>, reached: f64) -> Result<(), Terminated> {
    let Some(map) = map_of(scope, cid) else { return Ok(()) };
    let Some(gi) = map.graphs.iter().position(|g| g.id == gid) else { return Ok(()) };
    let single = map.graphs[gi].single;
    let Some((script, at)) = script_in(map, gi, key) else {
        map.graphs[gi].failed.get_or_insert(Outcome::Null);
        return Ok(());
    };
    if let Some(error) = script.parse_error.clone() {
        map.graphs[gi].failed.get_or_insert(Outcome::Rethrow(error));
        return Ok(());
    }
    if single {
        return Ok(());
    }
    // (…its imports fetched with its own fetch options: HostLoadImportedModule's descendant script fetch options)
    let (base, plan, began) = (script.base.clone(), script.plan, at.max(reached));
    let resolved = match script.resolved.clone() {
        Some(resolved) => Ok(resolved),
        None => {
            let requests = script.requests.clone();
            let resolved = resolve_all(map, &requests, &base);
            // (…a failure resolved again by the next graph to come to it: an import map registered meanwhile may map it)
            if let (Ok(keys), Some((script, _))) = (&resolved, script_in(map, gi, key)) {
                script.resolved = Some(keys.clone());
            }
            resolved
        }
    };
    let children = match resolved {
        Ok(children) => children,
        Err(error) => {
            map.graphs[gi].failed.get_or_insert(Outcome::Rethrow(error));
            return Ok(());
        }
    };
    for child in children {
        let Some(graph) = map_of(scope, cid).and_then(|map| map.graphs.iter_mut().find(|g| g.id == gid)) else { return Ok(()) };
        if !graph.visited.insert(child.clone()) {
            continue;
        }
        graph.waiting.push((child.clone(), began));
        ensure_fetch(scope, cid, &child, plan, Some(&base), None, began, 0)?;
    }
    Ok(())
}
// The module script the graph at `gi` has at `key` (None: its inline root), and when it came in.
fn script_in<'m>(map: &'m mut ModuleMap, gi: usize, key: Option<&Key>) -> Option<(&'m mut Script, f64)> {
    match key {
        Some(key) => match map.entries.get_mut(key) {
            Some(Entry::Ready(script, at)) => Some((script, *at)),
            _ => None,
        },
        None => match &mut map.graphs[gi].root {
            Root::Inline(script) => Some((script, f64::NEG_INFINITY)),
            Root::Entry(_) => None,
        },
    }
}
// HostLoadImportedModule's check of a module's requests as its first is loaded: each resolved against its base URL and
// its module type allowed — the first that is not the error to rethrow.
fn resolve_all(map: &mut ModuleMap, requests: &[(String, Option<ModuleType>)], base: &str) -> Result<Vec<Key>, Rethrow> {
    let mut keys = Vec::with_capacity(requests.len());
    for (specifier, ty) in requests {
        let url = map.resolve(specifier, base).ok_or_else(|| unresolved(specifier))?;
        let ty = ty.ok_or_else(|| Rethrow::type_error(format!("\"{specifier}\" is imported with a type that is no module type")))?;
        keys.push((url, ty));
    }
    Ok(keys)
}
// How long until the graph `gid` of realm `cid` next goes on, its fetches gone on as far as the event loop's clock has
// come (`advance`: modules land, compile, their responses' cookies stored) — 0 for a graph whose every module is in, or
// one a failure ended; None for none.
pub(crate) fn advance_due(scope: &mut v8::PinScope<'_, '_>, cid: i32, gid: u32) -> Result<Option<f64>, Terminated> {
    advance(scope, cid, gid, false)
}
// …as far as it can be told without going on — nothing landed, no host asked: what a reckoning of when the event loop is
// next due asks (frame_navigation.rs `load_due_at`, a spin's wait) — the earliest landing it waits on, 0 where one is due
// or in already (its going on its landing task's: script_lists.rs).
pub(crate) fn due_in(scope: &mut v8::PinScope<'_, '_>, cid: i32, gid: u32) -> Option<f64> {
    let now = realm(scope, cid).event_loop.clock;
    let map = map_of(scope, cid)?;
    let graph = map.graphs.iter().find(|g| g.id == gid)?;
    if graph.failed.is_some() {
        return Some(0.0);
    }
    let mut next: Option<f64> = None;
    for (key, _) in &graph.waiting {
        let at = match map.entries.get(key) {
            Some(&Entry::Fetching { due, .. }) => due,
            _ => now,
        };
        next = Some(next.map_or(at, |n: f64| n.min(at)));
    }
    Some(next.map_or(0.0, |at| (at - now).max(0.0)))
}
// The graph let go of: run — the fetches it still waits on, a failure having ended it, left to land in the map, whatever
// asks for their modules next — or, `cancelled`, its script's fetch cancelled with it (its document aborted, it moved
// to another): the fetches no other graph waits on cancelled too, their slots let go of.
pub(crate) fn drop_graph(scope: &mut v8::PinScope<'_, '_>, cid: i32, gid: u32, cancelled: bool) {
    let Some(map) = map_of(scope, cid) else { return };
    let Some(at) = map.graphs.iter().position(|g| g.id == gid) else { return };
    let graph = map.graphs.remove(at);
    if !cancelled {
        return;
    }
    let mut slots = Vec::new();
    for (key, _) in graph.waiting {
        let waited = map.graphs.iter().any(|g| g.waiting.iter().any(|(k, _)| *k == key));
        if let (false, Some(&Entry::Fetching { slot, .. })) = (waited, map.entries.get(&key)) {
            map.entries.remove(&key);
            slots.push(slot);
        }
    }
    let Some(host) = host_of(scope, cid) else { return };
    for slot in slots {
        let slot = v8::Integer::new_from_unsigned(scope, slot).into();
        if call(scope, host, crate::subresource_obtain::H_SCRIPT_FORGET, &[slot]).is_err() {
            return;
        }
    }
}

// ── a modulepreload's entry ──

// __dom.modulePreloadBegin(el, url, plan, integrity, destination, kind, host) -> the number of the graph of a
// modulepreload of `url` (HTML "fetch a modulepreload module script graph"): its document's module map's entry of the
// URL and the module type its `as` names (`destination`), fetched as the link is processed — in parallel, a slot of the
// host's, landing as late as its server took — with its request plan `plan` and its `integrity` (none: the import
// map's), its Resource Timing entry the link's (`kind`); one the map has, or is fetching, taken as it is. Its link's
// event once it lands (`modulePreloadLoaded`): none of its descendants fetched, as HTML leaves them optional.
fn module_preload_begin_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_uint32(0);
    let url = args.get(1).to_rust_string_lossy(scope);
    let plan = args.get(2).uint32_value(scope).unwrap_or(0);
    let integrity = string_arg(scope, args.get(3));
    let destination = args.get(4).to_rust_string_lossy(scope);
    let kind = args.get(5).uint32_value(scope).unwrap_or(0);
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(6)) else { return };
    let cid = realm_id(scope, &args);
    keep_host(scope, cid, host);
    let key = (url, ModuleType::of_destination(&destination));
    let began = realm(scope, cid).event_loop.clock;
    if ensure_fetch(scope, cid, &key, plan, None, integrity, began, kind).is_err() {
        return;
    }
    let Some(gid) = new_graph(scope, cid, Root::Entry(key.clone()), plan, vec![(key, began)]) else { return };
    if let Some(graph) = map_of(scope, cid).and_then(|map| map.graphs.iter_mut().find(|g| g.id == gid)) {
        graph.single = true;
    }
    rv.set_uint32(gid);
}
// __dom.modulePreloadLoaded(gid) -> whether the modulepreload's module script was had (its link's `load`; else its
// `error`) — its graph let go of, its entry the map's.
fn module_preload_loaded_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let gid = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    let _ = advance(scope, cid, gid, false);
    let loaded = map_of(scope, cid).and_then(|map| {
        let graph = map.graphs.iter().find(|g| g.id == gid)?;
        let Root::Entry(key) = &graph.root else { return None };
        Some(graph.waiting.is_empty() && matches!(map.entries.get(key), Some(Entry::Ready(..))))
    });
    drop_graph(scope, cid, gid, false);
    rv.set_bool(loaded == Some(true));
}

// __dom.modulePreloadsAbort() -> the numbers of the realm's modulepreloads whose fetches its document's abort cancelled
// (HTML "abort a document": a network error at once) — each graph let go of, its fetch with it where no other graph waits
// on it; `modulePreloadLoaded` none of them.
fn module_preloads_abort_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let gids: Vec<u32> = map_of(scope, cid).map(|map| map.graphs.iter().filter(|g| g.single).map(|g| g.id).collect()).unwrap_or_default();
    for &gid in &gids {
        drop_graph(scope, cid, gid, true);
    }
    let items: Vec<v8::Local<v8::Value>> = gids.iter().map(|&gid| v8::Integer::new_from_unsigned(scope, gid).into()).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// ── its result ──

// What a graph came to (HTML "fetch the descendants of and link", onComplete): what failed it first (`Graph::failed`) —
// null for a module that could not be fetched, else its error to rethrow; else its root's record, and the links of each
// module the host is to link that it has not had yet — `[root, base, [specifier, record, …], base, […], …]`.
enum Outcome {
    Null,
    Rethrow(Rethrow),
    Linked(u32, Vec<(String, Vec<(String, u32)>)>),
}
fn outcome(map: &mut ModuleMap, gid: u32) -> Option<Outcome> {
    let gi = map.graphs.iter().position(|g| g.id == gid)?;
    if let Some(failed) = map.graphs[gi].failed.take() {
        return Some(failed);
    }
    let root = match &map.graphs[gi].root {
        Root::Entry(key) => Some(key.clone()),
        Root::Inline(_) => None,
    };
    let mut seen: HashSet<Key> = root.iter().cloned().collect();
    let mut pending = vec![root];
    let (mut root_record, mut links, mut marked) = (None, Vec::new(), Vec::new());
    // (…depth first from its root, each module once: a module's own error first, then its requests in turn)
    while let Some(key) = pending.pop() {
        let script = match &key {
            None => match &map.graphs[gi].root {
                Root::Inline(script) => script,
                Root::Entry(_) => return Some(Outcome::Null),
            },
            Some(key) => match map.entries.get(key) {
                Some(Entry::Ready(script, _)) => script,
                _ => return Some(Outcome::Null),
            },
        };
        if let Some(error) = &script.parse_error {
            return Some(Outcome::Rethrow(error.clone()));
        }
        root_record.get_or_insert(script.record);
        let children = script.resolved.clone().unwrap_or_default();
        // (…an inline root's links each time: every inline module of a document is named by its base URL)
        if key.is_none() || !script.linked {
            let requests = script.requests.iter().zip(&children).map(|((specifier, _), child)| {
                let record = match map.entries.get(child) {
                    Some(Entry::Ready(child, _)) => child.record,
                    _ => 0,
                };
                (specifier.clone(), record)
            });
            let requests: Vec<_> = requests.collect();
            if !requests.is_empty() {
                links.push((script.base.clone(), requests));
            }
            marked.extend(key.clone());
        }
        for child in children.into_iter().rev() {
            if seen.insert(child.clone()) {
                pending.push(Some(child));
            }
        }
    }
    for key in marked {
        if let Some(Entry::Ready(script, _)) = map.entries.get_mut(&key) {
            script.linked = true;
        }
    }
    Some(Outcome::Linked(root_record.unwrap_or(0), links))
}
fn outcome_value<'s>(scope: &mut v8::PinScope<'s, '_>, outcome: Outcome) -> v8::Local<'s, v8::Value> {
    match outcome {
        Outcome::Null => v8::null(scope).into(),
        Outcome::Rethrow(e) => {
            let items = [
                text(scope, &e.name),
                text(scope, &e.message),
                crate::subresource_obtain::text_or_null(scope, e.filename.as_deref()),
                e.lineno.map_or_else(|| v8::null(scope).into(), |l| v8::Integer::new(scope, l).into()),
            ];
            let error = v8::Array::new_with_elements(scope, &items);
            v8::Array::new_with_elements(scope, &[error.into()]).into()
        }
        Outcome::Linked(root, links) => {
            let mut items: Vec<v8::Local<v8::Value>> = vec![v8::Integer::new_from_unsigned(scope, root).into()];
            for (base, requests) in links {
                items.push(text(scope, &base));
                let mut pairs = Vec::with_capacity(requests.len() * 2);
                for (specifier, record) in requests {
                    pairs.push(text(scope, &specifier));
                    pairs.push(v8::Integer::new_from_unsigned(scope, record).into());
                }
                items.push(v8::Array::new_with_elements(scope, &pairs).into());
            }
            v8::Array::new_with_elements(scope, &items).into()
        }
    }
}

// __dom.moduleGraphResult(gid) -> what the graph `gid` came to, its every module in — taken: null where a module could not
// be fetched (or there is no such graph); `[[name, message, filename, lineno]]`, its error to rethrow; else `[root, base,
// [specifier, record, …], …]`, its root's record and the links the host is to link it by (`outcome`).
fn module_graph_result_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let gid = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    let _ = advance(scope, cid, gid, true);
    let outcome = map_of(scope, cid).and_then(|map| outcome(map, gid)).unwrap_or(Outcome::Null);
    drop_graph(scope, cid, gid, false);
    let value = outcome_value(scope, outcome);
    rv.set(value);
}

// __dom.moduleImport(specifier, name, referrer, base, host) -> what an `import()` of `specifier` comes to
// (`moduleGraphResult`'s answer), made by the script named `name` (a module's base URL, a classic script's name), referred
// by `referrer` (the referring script's base URL; null: its client, where no script refers it) and resolved against `base`:
// HostLoadImportedModule — its graph fetched now, as the script waits inside the import, with the referring script's
// fetch options.
// KNOWN GAP (rusty_racer): the engine's dynamic-import hook hands the host no import attributes, so an `import()`'s module
// type is told by its URL's `.json` suffix — a JSON module of another URL, or a `type` naming none, is not told — and the
// import is answered as the script waits, with none of its servers' time on the clock.
fn module_import_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let specifier = args.get(0).to_rust_string_lossy(scope);
    let name = args.get(1).to_rust_string_lossy(scope);
    let referrer = string_arg(scope, args.get(2));
    let base = args.get(3).to_rust_string_lossy(scope);
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(4)) else { return };
    let cid = realm_id(scope, &args);
    keep_host(scope, cid, host);
    let Some(map) = map_of(scope, cid) else { return };
    let Some(url) = map.resolve(&specifier, &base) else {
        let value = outcome_value(scope, Outcome::Rethrow(unresolved(&specifier)));
        return rv.set(value);
    };
    // (…the referring module's fetch options; a classic script's, an inline module's, the defaults)
    // (…the referring script's fetch options — HostLoadImportedModule's originalFetchOptions: a fetched module's, an inline
    // module's or a classic script's as it ran — the defaults for none, an event handler's)
    let referring = match map.entries.get(&(name.clone(), ModuleType::JavaScript)) {
        Some(Entry::Ready(script, _)) => Some(script.plan),
        _ => map.referring.get(&name).copied().flatten().or_else(|| {
            // (…a redirected one's by its base URL, the name it was compiled under)
            map.entries.values().find_map(|e| match e {
                Entry::Ready(script, _) if script.base == name => Some(script.plan),
                _ => None,
            })
        }),
    };
    let arena = realm(scope, cid);
    let doc = arena.realm_document(cid);
    let plan = referring.unwrap_or_else(|| crate::subresource_plan::plan_in(arena, crate::subresource_plan::J_MODULE_SCRIPT, None, doc, None));
    let json = url.split(['?', '#']).next().is_some_and(|path| path.ends_with(".json"));
    let key = (url, if json { ModuleType::Json } else { ModuleType::JavaScript });
    let now = realm(scope, cid).event_loop.clock;
    if ensure_fetch(scope, cid, &key, plan, referrer.as_deref(), None, now, 0).is_err() {
        return;
    }
    let Some(gid) = new_graph(scope, cid, Root::Entry(key.clone()), plan, vec![(key, now)]) else { return };
    if advance(scope, cid, gid, true).is_err() {
        return;
    }
    let outcome = map_of(scope, cid).and_then(|map| outcome(map, gid)).unwrap_or(Outcome::Null);
    drop_graph(scope, cid, gid, false);
    let value = outcome_value(scope, outcome);
    rv.set(value);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_type_is_a_module_type_html_allows() {
        assert_eq!(ModuleType::of_request(None, true), Some(ModuleType::JavaScript));
        assert_eq!(ModuleType::of_request(Some("json"), true), Some(ModuleType::Json));
        assert_eq!(ModuleType::of_request(Some("css"), true), Some(ModuleType::Css));
        assert_eq!(ModuleType::of_request(Some("css"), false), None);
        assert_eq!(ModuleType::of_request(Some("text"), true), Some(ModuleType::Text));
        assert_eq!(ModuleType::of_request(Some("javascript-or-wasm"), true), None);
        assert_eq!(ModuleType::of_request(Some("JSON"), true), None);
        assert_eq!(ModuleType::of_code(1), ModuleType::Json);
    }

    #[test]
    fn a_json_module_is_its_value_as_json_parse_makes_it() {
        assert_eq!(json_literal(r#" {"__proto__": [1, -0, 2.5e3], "a": {}} "#).as_deref(), Some(r#"{["__proto__"]:[(1),(-0),(2.5e3)],["a"]:{}}"#));
        assert_eq!(json_literal(r#""\u2028\ud800""#).as_deref(), Some(r#""\u2028\ud800""#));
        assert_eq!(json_literal("true").as_deref(), Some("true"));
        for bad in [r#"{"x": 1,}"#, "[1 2]", "01", "1.", "'a'", "{x: 1}", "\"a\tb\"", "", "nul", "[1] x", "+1"] {
            assert_eq!(json_literal(bad), None, "{bad}");
        }
        assert!(module_body("x".into(), 3).unwrap().contains(r#"export default "x";"#));
        assert_eq!(module_body("{".into(), 1), None);
        let deep = format!("{}{}", "[".repeat(200_000), "]".repeat(200_000));
        assert!(module_body(deep, 1).unwrap().starts_with("export default JSON.parse("));
    }
}
