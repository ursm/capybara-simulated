// An XMLHttpRequest's state (XHR §3): its state (UNSENT, OPENED, HEADERS_RECEIVED, LOADING, DONE), its request — method,
// URL and the fragment kept apart from it, open()'s username and password, the synchronous flag, the timeout, the
// credentials mode — the send flag and the upload-complete flag's opposite (an upload in progress, of its body's size),
// when it was sent (the timeout's reference, on the virtual clock; the resource timing's start, on the timeline's),
// whether the fetch in flight was terminated, the response type and override MIME type, the response's status, status
// message and URL, and how often it was opened (a fetch, a delivery or a worker's answer of an earlier open() is
// stale). The steps that read and change them — open(), send(),
// abort()'s and the request error steps' state changes, the setters' checks — are here; the events they fire, the
// fetch, the response body and the objects made of it are the bindings' (xhr.js). An XHR's object holds a handle on V8's
// C++ heap (`__dom.XhrBase`, as a header list's does: headers.rs) that owns the state.

use std::cell::RefCell;

use v8::cppgc::{GarbageCollected, Visitor};

// The wrapper tag `Object::wrap` / `unwrap` file the handle under (a node's is 1, … a header list's 7, a drag data
// store's 8).
const TAG: u16 = 9;
// What marks an object as an XHR state's (its internal field 0).
static BRAND: u8 = 0;

const UNSENT: u32 = 0;
const OPENED: u32 = 1;
const HEADERS_RECEIVED: u32 = 2;
const LOADING: u32 = 3;
const DONE: u32 = 4;

// The response types, as the bindings and the IDL enum name them.
const RESPONSE_TYPES: [&str; 6] = ["", "arraybuffer", "blob", "document", "json", "text"];

#[derive(Default)]
struct XhrState {
    ready: u32,
    method: Vec<u16>,
    url: Vec<u16>,
    fragment: Vec<u16>,
    username: Option<Vec<u16>>,
    password: Option<Vec<u16>>,
    synchronous: bool,
    timeout: u32,
    with_credentials: bool,
    send: bool,
    upload_active: bool,
    upload_total: f64,
    send_start: Option<f64>,
    timing_start: f64,
    aborted: bool,
    response_type: usize,
    override_mime: Option<(Vec<u16>, Option<Vec<u16>>)>,
    status: u32,
    status_text: Vec<u16>,
    response_url: Vec<u16>,
    generation: u32,
}

impl XhrState {
    // The network error's response: status 0, no status message (the bindings drop its body and headers).
    fn clear_response(&mut self) {
        self.status = 0;
        self.status_text.clear();
    }
}

pub(crate) struct XhrHandle {
    state: RefCell<XhrState>,
}

unsafe impl GarbageCollected for XhrHandle {
    fn trace(&self, _visitor: &mut Visitor) {}
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"XhrHandle"
    }
}

// The constructor an XHR's state is made with (`__dom.XhrBase()`): branded, a wrapper of a fresh state, UNSENT.
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let method = "GET".encode_utf16().collect();
    let handle = XhrHandle { state: RefCell::new(XhrState { method, ..XhrState::default() }) };
    let heap = scope.get_cpp_heap().expect("XhrBase is installed only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, XhrHandle>(scope, obj, &ptr);
    }
}

// The state `value` wraps, or None for anything that is no XHR state's object (the brand first: `unwrap` reads garbage
// from an object it never wrapped).
fn state<'h>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'h RefCell<XhrState>> {
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1)?;
    let field = obj.get_internal_field(scope, 0)?;
    let brand = v8::Local::<v8::Value>::try_from(field).ok().and_then(|v| v8::Local::<v8::External>::try_from(v).ok())?;
    if brand.value() as *const u8 != std::ptr::addr_of!(BRAND) {
        return None;
    }
    // SAFETY: a branded object was made by `construct`, which wrapped an XhrHandle under TAG; the handle lives while its
    // object, the argument, does — through this op.
    let handle = unsafe { v8::Object::unwrap::<TAG, XhrHandle>(scope, obj)? };
    Some(unsafe { &(*(handle.as_ref() as *const XhrHandle)).state })
}

// `__dom.XhrBase`: the constructor of the isolate's template, made once per isolate.
fn base_function<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    scope.get_cpp_heap()?;
    let kept = crate::dom::dom(scope).xhr_template.clone();
    let template = match kept {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::FunctionTemplate::new(scope, construct);
            t.set_class_name(v8::String::new(scope, "XhrBase")?);
            t.instance_template(scope).set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).xhr_template = Some(global);
            t
        }
    };
    template.get_function(scope)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    if let (Some(base), Some(name)) = (base_function(scope), v8::String::new(scope, "XhrBase")) {
        ns.set(scope, name.into(), base.into());
    }
    crate::dom::register(scope, ns, "xhrGet", get_op, context_id);
    crate::dom::register(scope, ns, "xhrSet", set_op, context_id);
    crate::dom::register(scope, ns, "xhrOpen", open_op, context_id);
    crate::dom::register(scope, ns, "xhrCredentials", credentials_op, context_id);
    crate::dom::register(scope, ns, "xhrFinal", final_op, context_id);
    crate::dom::register(scope, ns, "xhrSend", send_op, context_id);
    crate::dom::register(scope, ns, "xhrCurrent", current_op, context_id);
    crate::dom::register(scope, ns, "xhrInFlight", in_flight_op, context_id);
    crate::dom::register(scope, ns, "xhrTerminate", terminate_op, context_id);
    crate::dom::register(scope, ns, "xhrUnsend", unsend_op, context_id);
    crate::dom::register(scope, ns, "xhrTakeUpload", take_upload_op, context_id);
    crate::dom::register(scope, ns, "xhrSetTimeout", set_timeout_op, context_id);
    crate::dom::register(scope, ns, "xhrSetWithCredentials", set_with_credentials_op, context_id);
    crate::dom::register(scope, ns, "xhrSetResponseType", set_response_type_op, context_id);
    crate::dom::register(scope, ns, "xhrOverrideMimeType", override_mime_type_op, context_id);
}

// The fields `xhrGet` / `xhrSet` read and write, as the bindings number them (xhr.js `X_*`).
const READY: u32 = 0;
const STATUS: u32 = 1;
const STATUS_TEXT: u32 = 2;
const RESPONSE_URL: u32 = 3;
const TIMEOUT: u32 = 4;
const WITH_CREDENTIALS: u32 = 5;
const RESPONSE_TYPE: u32 = 6;
const GENERATION: u32 = 7;
const ASYNC: u32 = 8;
const SEND: u32 = 9;
const UPLOAD_ACTIVE: u32 = 10;
const METHOD: u32 = 11;
const URL: u32 = 12;
const FRAGMENT: u32 = 13;
const SEND_START: u32 = 18;
const UPLOAD_TOTAL: u32 = 19;
const TIMING_START: u32 = 20;

fn units<'s>(scope: &mut v8::PinScope<'s, '_>, units: &[u16]) -> v8::Local<'s, v8::Value> {
    crate::dom::utf16_value(scope, units)
}

// __dom.xhrGet(state, field) -> the field (`X_*`): a number, a boolean or a string — the response type its index in
// `RESPONSE_TYPES` (xhr.js names them alike), when it was sent null for none. (14–17 were the override MIME type's essence
// and charset and open()'s username and password, which `xhrFinal` and `xhrCredentials` answer.)
fn get_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let field = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let Some(s) = state(scope, args.get(0)) else { return rv.set_undefined() };
    let s = s.borrow();
    match field {
        READY => rv.set_uint32(s.ready),
        STATUS => rv.set_uint32(s.status),
        TIMEOUT => rv.set_uint32(s.timeout),
        GENERATION => rv.set_uint32(s.generation),
        WITH_CREDENTIALS => rv.set_bool(s.with_credentials),
        ASYNC => rv.set_bool(!s.synchronous),
        SEND => rv.set_bool(s.send),
        UPLOAD_ACTIVE => rv.set_bool(s.upload_active),
        RESPONSE_TYPE => rv.set_uint32(s.response_type as u32),
        UPLOAD_TOTAL => rv.set_double(s.upload_total),
        TIMING_START => rv.set_double(s.timing_start),
        SEND_START => match s.send_start {
            Some(at) => rv.set_double(at),
            None => rv.set_null(),
        },
        STATUS_TEXT => rv.set(units(scope, &s.status_text)),
        RESPONSE_URL => rv.set(units(scope, &s.response_url)),
        METHOD => rv.set(units(scope, &s.method)),
        URL => rv.set(units(scope, &s.url)),
        FRAGMENT => rv.set(units(scope, &s.fragment)),
        _ => rv.set_undefined(),
    }
}

// __dom.xhrSet(state, field, value) — what the send's and the response's steps write: when it was sent, an upload in
// progress or no more and its size, its state as the response arrives (HEADERS_RECEIVED, LOADING, DONE), its status,
// status message and URL, the request URL its credentials were taken out of.
fn set_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    enum Value {
        Number(f64),
        Text(Vec<u16>),
        Flag(bool),
    }
    let field = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let value = args.get(2);
    // (…converted as the field takes it, before the state is borrowed)
    let value = match field {
        STATUS_TEXT | RESPONSE_URL | URL => Value::Text(crate::dom::utf16_arg(scope, value)),
        UPLOAD_ACTIVE => Value::Flag(value.is_true()),
        _ => Value::Number(value.number_value(scope).unwrap_or(0.0)),
    };
    let Some(s) = state(scope, args.get(0)) else { return };
    let mut s = s.borrow_mut();
    let whole = |n: f64| if n.is_finite() && n > 0.0 { n.min(f64::from(u32::MAX)) as u32 } else { 0 };
    match (field, value) {
        (READY, Value::Number(n)) => s.ready = whole(n).min(DONE),
        (STATUS, Value::Number(n)) => s.status = whole(n),
        (SEND_START, Value::Number(n)) => s.send_start = Some(n),
        (UPLOAD_TOTAL, Value::Number(n)) => s.upload_total = n,
        (TIMING_START, Value::Number(n)) => s.timing_start = n,
        (STATUS_TEXT, Value::Text(t)) => s.status_text = t,
        (RESPONSE_URL, Value::Text(t)) => s.response_url = t,
        (URL, Value::Text(t)) => s.url = t,
        (UPLOAD_ACTIVE, Value::Flag(on)) => s.upload_active = on,
        _ => {}
    }
}

// XHR "open()"'s checks of its method and URL, in order, each before any state changes (a bad open() leaves the object
// as it was): a method that is no token a SyntaxError, a forbidden one a SecurityError — then the method normalized
// (uppercased only where it case-insensitively is one of the six: `patCH` keeps its case); a URL that parses neither
// against `base` nor against any http(s) base a SyntaxError (a malformed URL never reaches the network — url/failure). The
// request URL is resolved against the API base URL `api_base` AT OPEN TIME — a `<base>` inserted later does not apply —
// its query in the document's encoding `encoding` (`?ß` is `%DF` under windows-1252), its fragment kept apart: never
// sent, and no part of `responseURL`, but a document response's URL has it. Only an http(s) base resolves it: an
// about:blank or srcdoc frame's is opaque, its path left RELATIVE for the fetch to resolve, the query alone re-encoded
// (a `?` kept for an empty one). The method, the URL and its fragment; or the DOMException's message and name.
fn opened(method: &str, bytes: &[u8], url: &str, base: Option<&str>, api_base: &str, encoding: Option<&str>) -> Result<(String, String, String), (String, &'static str)> {
    if !crate::fetch_rules::is_token(bytes) {
        return Err((format!("'{method}' is not a valid HTTP method."), "SyntaxError"));
    }
    if crate::fetch_rules::forbidden_method(bytes) {
        return Err((format!("'{method}' HTTP method is unsupported."), "SecurityError"));
    }
    let method = crate::fetch_rules::normalized_method(bytes).map_or_else(|| method.to_owned(), str::to_owned);
    let parse = |b: Option<&str>, e: Option<&str>| crate::url_ops::encoding_parse(url, b, e);
    if parse(base, None).is_none() && parse(Some("http://csim-fallback.invalid/"), None).is_none() {
        return Err(("Invalid URL".into(), "SyntaxError"));
    }
    let special = api_base.get(..5).is_some_and(|p| p.eq_ignore_ascii_case("http:")) || api_base.get(..6).is_some_and(|p| p.eq_ignore_ascii_case("https:"));
    if let Some(parsed) = parse(Some(api_base), encoding).filter(|_| special) {
        let href = parsed.href();
        return Ok(match href.split_once('#') {
            Some((url, fragment)) => (method, url.to_owned(), format!("#{fragment}")),
            None => (method, href.to_owned(), String::new()),
        });
    }
    let request = match (url.find('?'), parse(base, encoding)) {
        (Some(q), Some(parsed)) => {
            let search = parsed.search();
            format!("{}{}", &url[..q], if search.is_empty() { "?" } else { search })
        }
        _ => url.to_owned(),
    };
    Ok((method, request, String::new()))
}

// __dom.xhrOpen(state, method, url, async, inDocument, username, password, base, apiBase, encoding) -> -1 where a
// synchronous request from a document set a response type or a timeout (InvalidAccessError), else whether its
// readystatechange fires — none where it was OPENED already (open-open-send / open-send-open): the open() steps
// (`opened`'s checks a DOMException thrown). The request is the one opened, its username and password (null for none
// given); the response reset, the send flag unset, the fetch terminated — what is still queued for it made stale, as
// the count moves on.
fn open_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = |scope: &mut v8::PinScope<'_, '_>, i: i32| args.get(i).to_rust_string_lossy(scope);
    let (method, url) = (text(scope, 1), text(scope, 2));
    let bytes = crate::fetch_rules::byte_string(scope, args.get(1));
    let base = (!args.get(7).is_null_or_undefined()).then(|| text(scope, 7));
    let api_base = text(scope, 8);
    let encoding = (!args.get(9).is_null_or_undefined()).then(|| text(scope, 9));
    let (method, url, fragment) = match opened(&method, &bytes, &url, base.as_deref(), &api_base, encoding.as_deref()) {
        Ok(opened) => opened,
        Err((message, name)) => {
            if let Some(message) = v8::String::new(scope, &format!("Failed to execute 'open' on 'XMLHttpRequest': {message}")) {
                crate::clone::throw_dom_exception(scope, message, name);
            }
            return;
        }
    };
    let (method, url, fragment) = (method.encode_utf16().collect(), url.encode_utf16().collect(), fragment.encode_utf16().collect());
    let asynchronous = args.get(3).is_true();
    let in_document = args.get(4).is_true();
    let username = Some(args.get(5)).filter(|u| u.is_string()).map(|u| crate::dom::utf16_arg(scope, u));
    let password = Some(args.get(6)).filter(|p| p.is_string()).map(|p| crate::dom::utf16_arg(scope, p));
    let Some(s) = state(scope, args.get(0)) else { return rv.set_int32(0) };
    let mut s = s.borrow_mut();
    if !asynchronous && in_document && (s.response_type != 0 || s.timeout != 0) {
        return rv.set_int32(-1);
    }
    s.generation = s.generation.wrapping_add(1);
    s.method = method;
    s.url = url;
    s.fragment = fragment;
    s.username = username;
    s.password = password;
    s.synchronous = !asynchronous;
    s.aborted = false;
    s.send = false;
    s.clear_response();
    s.response_url.clear();
    let was_opened = s.ready == OPENED;
    s.ready = OPENED;
    rv.set_int32(i32::from(!was_opened));
}

// __dom.xhrCredentials(state, base) -> `[username, password]` the request answers a server's "Basic" challenge with
// (each null for none): open()'s, which override the URL's userinfo, else the URL's, percent-decoded (a malformed escape
// kept as it is) — the URL's stripped from it either way, as the URL setters set them empty, so the request never sends
// them in its URL (transparent HTTP auth, send-authentication).
fn credentials_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let base = (!args.get(1).is_null_or_undefined()).then(|| args.get(1).to_rust_string_lossy(scope));
    let Some(s) = state(scope, args.get(0)) else { return };
    let mut s = s.borrow_mut();
    let url = String::from_utf16_lossy(&s.url);
    let decode = |text: &str| -> Vec<u16> {
        let units: Vec<u16> = match percent_encoding::percent_decode_str(text).decode_utf8() {
            Ok(decoded) => decoded.encode_utf16().collect(),
            Err(_) => text.encode_utf16().collect(),
        };
        units
    };
    let (mut user, mut pass) = (None, None);
    if let Some(mut parsed) = crate::url_ops::encoding_parse(&url, base.as_deref(), None) {
        if !parsed.username().is_empty() {
            user = Some(decode(parsed.username()));
        }
        if !parsed.password().is_empty() {
            pass = Some(decode(parsed.password()));
        }
        if user.is_some() || pass.is_some() {
            let _ = parsed.set_username(Some(""));
            let _ = parsed.set_password(Some(""));
            s.url = parsed.href().encode_utf16().collect();
        }
    }
    let user = s.username.clone().or(user);
    let pass = s.password.clone().or(pass);
    drop(s);
    let mut items: Vec<v8::Local<'_, v8::Value>> = Vec::with_capacity(2);
    for value in [user, pass] {
        items.push(match value {
            Some(units) => crate::dom::utf16_value(scope, &units),
            None => v8::null(scope).into(),
        });
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.xhrFinal(state, contentType) -> `[mime, isXml, label]`: XHR "get a final MIME type" and "get a final encoding",
// as the body is first read (from LOADING, when overrideMimeType() can no longer change them) — the override's type
// over the one the response's `Content-Type` gives (Fetch "extract a MIME type"), `text/xml` where it gives none (an
// empty one, `bogus`, `application`), so it parses as XML (responsexml-media-type); whether that is an XML MIME type;
// and the final encoding's label, the override's charset over the response's — null for none.
fn final_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let content_type = args.get(1).to_rust_string_lossy(scope);
    let Some(s) = state(scope, args.get(0)) else { return };
    let response = crate::mime::extract(&content_type);
    let (overridden, override_charset) = match &s.borrow().override_mime {
        Some((essence, charset)) => (Some(String::from_utf16_lossy(essence)), charset.as_ref().map(|c| String::from_utf16_lossy(c))),
        None => (None, None),
    };
    let mime = overridden.or_else(|| response.as_ref().map(|r| r.essence.clone())).unwrap_or_else(|| "text/xml".into());
    let is_xml = crate::mime::is_xml(&mime);
    let label = override_charset
        .filter(|c| !c.is_empty())
        .or_else(|| response.as_ref().and_then(|r| r.parameters.iter().find(|(n, _)| n == "charset").map(|(_, v)| v.clone())));
    let mime_value = v8::String::new(scope, &mime).map_or_else(|| v8::undefined(scope).into(), Into::into);
    let label_value: v8::Local<'_, v8::Value> = match label.and_then(|l| v8::String::new(scope, &l)) {
        Some(l) => l.into(),
        None => v8::null(scope).into(),
    };
    let is_xml = v8::Boolean::new(scope, is_xml).into();
    rv.set(v8::Array::new_with_elements(scope, &[mime_value, is_xml, label_value]).into());
}

// __dom.xhrSend(state) -> the open() this send is of (its count, which `xhrCurrent` checks against), or -1 where the
// request is not OPENED or is sent already (InvalidStateError): the send flag set.
fn send_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(s) = state(scope, args.get(0)) else { return rv.set_int32(-1) };
    let mut s = s.borrow_mut();
    if s.ready != OPENED || s.send {
        return rv.set_int32(-1);
    }
    s.send = true;
    rv.set_double(f64::from(s.generation));
}

// __dom.xhrCurrent(state, generation) -> whether the send of the open() counted `generation` is still the request's: not
// terminated, nor the request opened again — from a handler of its own events too, after which it fires none.
fn current_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let generation = args.get(1).uint32_value(scope);
    let Some(s) = state(scope, args.get(0)) else { return rv.set_bool(false) };
    let s = s.borrow();
    rv.set_bool(!s.aborted && generation == Some(s.generation));
}

// __dom.xhrInFlight(state) -> whether abort() runs the request error steps: OPENED with the send flag set,
// HEADERS_RECEIVED or LOADING (before the send flag it changes no state: send-data-unexpected-tostring).
fn in_flight_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(s) = state(scope, args.get(0)) else { return rv.set_bool(false) };
    let s = s.borrow();
    rv.set_bool((s.ready == OPENED && s.send) || s.ready == HEADERS_RECEIVED || s.ready == LOADING);
}

// __dom.xhrTerminate(state) — the request error steps' state: the fetch terminated, DONE with the network error's
// response — set BEFORE the DONE readystatechange, whose handler must see it (abort-during-loading). Whether an upload
// is in progress the bindings ask after that handler (`xhrTakeUpload`), which may have opened and sent again.
fn terminate_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(s) = state(scope, args.get(0)) else { return };
    let mut s = s.borrow_mut();
    s.aborted = true;
    s.ready = DONE;
    s.clear_response();
}

// __dom.xhrUnsend(state) -> whether a DONE request went back to UNSENT, its response the network error's — abort()'s
// last step, unless an abort / loadend handler opened it again (open-during-abort).
fn unsend_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(s) = state(scope, args.get(0)) else { return rv.set_bool(false) };
    let mut s = s.borrow_mut();
    if s.ready != DONE {
        return rv.set_bool(false);
    }
    s.ready = UNSENT;
    s.clear_response();
    rv.set_bool(true);
}

// __dom.xhrTakeUpload(state) -> whether an upload was in progress, which is complete now: its terminal events the
// bindings' to fire, once (a later abort / timeout fires none: abort-during-loading).
fn take_upload_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(s) = state(scope, args.get(0)) else { return rv.set_bool(false) };
    rv.set_bool(std::mem::replace(&mut s.borrow_mut().upload_active, false));
}

// __dom.xhrSetTimeout(state, ms, inDocument) -> whether the timeout was set: not for a synchronous request from a
// document once opened (InvalidAccessError).
fn set_timeout_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let ms = args.get(1).uint32_value(scope).unwrap_or(0);
    let in_document = args.get(2).is_true();
    let Some(s) = state(scope, args.get(0)) else { return rv.set_bool(false) };
    let mut s = s.borrow_mut();
    if s.synchronous && in_document && s.ready != UNSENT {
        return rv.set_bool(false);
    }
    s.timeout = ms;
    rv.set_bool(true);
}

// __dom.xhrSetWithCredentials(state, on) -> whether it was set: only while UNSENT or OPENED with the send flag unset
// (InvalidStateError) — loadstart-and-state sets it during loadstart.
fn set_with_credentials_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let on = args.get(1).is_true();
    let Some(s) = state(scope, args.get(0)) else { return rv.set_bool(false) };
    let mut s = s.borrow_mut();
    if (s.ready != UNSENT && s.ready != OPENED) || s.send {
        return rv.set_bool(false);
    }
    s.with_credentials = on;
    rv.set_bool(true);
}

// __dom.xhrSetResponseType(state, type, inDocument) -> 0 where it was set — or ignored: 'document' where the global is
// no Window, which has no document response — 1 once the response is LOADING or DONE (InvalidStateError), 2 for a
// synchronous request from a document (InvalidAccessError).
fn set_response_type_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = args.get(1).to_rust_string_lossy(scope);
    let in_document = args.get(2).is_true();
    let Some(s) = state(scope, args.get(0)) else { return rv.set_uint32(0) };
    let Some(kind) = RESPONSE_TYPES.iter().position(|t| *t == name) else { return rv.set_uint32(0) };
    if name == "document" && !in_document {
        return rv.set_uint32(0);
    }
    let mut s = s.borrow_mut();
    if s.ready == LOADING || s.ready == DONE {
        return rv.set_uint32(1);
    }
    if in_document && s.synchronous {
        return rv.set_uint32(2);
    }
    s.response_type = kind;
    rv.set_uint32(0);
}

// __dom.xhrOverrideMimeType(state, essence, charset) -> whether the override MIME type was set — the final MIME type's
// essence and, given, the final encoding's charset (parsed by the bindings: application/octet-stream with none for one
// that does not parse) — which it is not once the response is LOADING or DONE (InvalidStateError). It survives open().
fn override_mime_type_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let essence = crate::dom::utf16_arg(scope, args.get(1));
    let charset = Some(args.get(2)).filter(|c| c.is_string()).map(|c| crate::dom::utf16_arg(scope, c));
    let Some(s) = state(scope, args.get(0)) else { return rv.set_bool(false) };
    let mut s = s.borrow_mut();
    if s.ready == LOADING || s.ready == DONE {
        return rv.set_bool(false);
    }
    s.override_mime = Some((essence, charset));
    rv.set_bool(true);
}
