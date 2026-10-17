// A Response object's response (Fetch §2.2.6) — what its getters read: its type, its URL (its last, the fragment
// excluded), status, status message and whether it was redirected — on a handle the bindings' object wraps
// (`__dom.ResponseStateBase`), made by the steps that make one here: Fetch "initialize a response" (the constructor's,
// `Response.json`'s), a response the network handed back, a network error, `Response.redirect`'s, a clone. What is the
// page's objects stays the bindings': its Headers object, its body, the network's raw answer and its fetch's signal.

use std::cell::RefCell;

use v8::cppgc::{GarbageCollected, Visitor};

// The wrapper tag `Object::wrap` / `unwrap` file the handle under (url_pattern.rs' 12).
const TAG: u16 = 13;

// What marks an object as a response's (its internal field 0).
static BRAND: u8 = 0;

#[derive(Clone)]
struct Response {
    kind: String,
    url: String,
    status: u32,
    status_text: String,
    redirected: bool,
    // (…a redirect's Location, `Response.redirect`'s URL parsed: what its headers carry)
    location: String,
}

impl Response {
    fn new(status: u32, status_text: String) -> Self {
        Response { kind: "default".into(), url: String::new(), status, status_text, redirected: false, location: String::new() }
    }
}

pub(crate) struct ResponseHandle {
    response: RefCell<Response>,
}

unsafe impl GarbageCollected for ResponseHandle {
    fn trace(&self, _visitor: &mut Visitor) {}
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"ResponseHandle"
    }
}

// A refusal: a TypeError's message, or a RangeError's.
enum Refusal {
    Type(String),
    Range(String),
}

// A response's URL, serialized with its fragment excluded (Fetch's "exclude fragment" flag) — parsed, so normalized
// (`host:8000#x` is `host:8000/`), and where it does not parse, cut at its first `#`.
fn url_without_fragment(url: &str) -> String {
    let href = crate::url_ops::encoding_parse(url, None, None).map_or_else(|| url.to_owned(), |u| u.href().to_owned());
    match href.find('#') {
        Some(i) => href[..i].to_owned(),
        None => href,
    }
}

// The response one of the ways a response is made makes, by `kind` (the arguments after it):
//   "init" (status, statusText) — Fetch "initialize a response": the status a RangeError outside 200–599, the status
//     message a TypeError where it is no reason-phrase;
//   "network" (type, url, status, statusText, redirected, requestURL) — one the network handed back, of `type` (basic
//     where none): an opaque one has no URL, any other its own URL, else the request's;
//   "error" — a network error: status 0;
//   "redirect" (url, status, base) — `Response.redirect`: `url` parsed against the API base URL (a TypeError where it
//     is none), of a redirect status (a RangeError otherwise), its Location that URL;
//   "clone" (source) — a copy of `source`'s response.
fn made(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> Result<Response, Refusal> {
    let text = |scope: &mut v8::PinScope<'_, '_>, i: i32| args.get(i).to_rust_string_lossy(scope);
    let number = |scope: &mut v8::PinScope<'_, '_>, i: i32| args.get(i).uint32_value(scope).unwrap_or(0);
    match text(scope, 0).as_str() {
        "init" => {
            let status = number(scope, 1);
            if !(200..=599).contains(&status) {
                return Err(Refusal::Range(format!("The status provided ({status}) is outside the range [200, 599].")));
            }
            let status_text = text(scope, 2);
            let bytes: Vec<u8> = status_text.chars().map(|c| u8::try_from(u32::from(c)).unwrap_or(0)).collect();
            if !crate::fetch_rules::is_reason_phrase(&bytes) {
                return Err(Refusal::Type("Invalid statusText".into()));
            }
            Ok(Response::new(status, status_text))
        }
        "network" => {
            let kind = Some(text(scope, 1)).filter(|k| !k.is_empty()).unwrap_or_else(|| "basic".into());
            let given = text(scope, 2);
            let url = if kind == "opaque" {
                String::new()
            } else {
                let url = if given.is_empty() { text(scope, 6) } else { given };
                if url.is_empty() { url } else { url_without_fragment(&url) }
            };
            let status_text = if args.get(4).is_null_or_undefined() { String::new() } else { text(scope, 4) };
            let redirected = args.get(5).boolean_value(scope);
            Ok(Response { kind, url, redirected, ..Response::new(number(scope, 3), status_text) })
        }
        "error" => Ok(Response { kind: "error".into(), ..Response::new(0, String::new()) }),
        "redirect" => {
            let (url, base) = (text(scope, 1), text(scope, 3));
            let Some(parsed) = crate::url_ops::encoding_parse(&url, Some(&base), None) else {
                return Err(Refusal::Type(format!("Failed to parse URL from {url}")));
            };
            let status = number(scope, 2);
            if !crate::fetch_rules::redirect_status(status) {
                return Err(Refusal::Range("Invalid status code".into()));
            }
            Ok(Response { location: parsed.href().to_owned(), ..Response::new(status, String::new()) })
        }
        _ => response(scope, args.get(1)).map(|r| r.borrow().clone()).ok_or_else(|| Refusal::Type(String::new())),
    }
}

// The constructor a Response object's response is made with — `new __dom.ResponseStateBase(kind, …, prefix)`, its
// last argument the messages' prefix (`made`).
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let response = match made(scope, &args) {
        Ok(response) => response,
        Err(refusal) => {
            let prefix = args.get(args.length() - 1).to_rust_string_lossy(scope);
            let (message, range) = match refusal {
                Refusal::Type(m) => (m, false),
                Refusal::Range(m) => (m, true),
            };
            let Some(message) = v8::String::new(scope, &format!("{prefix}{message}")) else { return };
            let error = if range { v8::Exception::range_error(scope, message) } else { v8::Exception::type_error(scope, message) };
            scope.throw_exception(error);
            return;
        }
    };
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let handle = ResponseHandle { response: RefCell::new(response) };
    let heap = scope.get_cpp_heap().expect("ResponseStateBase is installed only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, ResponseHandle>(scope, obj, &ptr);
    }
}

// The response `value` wraps, or None for anything that is no response's object (the brand first: `unwrap` reads
// garbage from an object it never wrapped).
fn response<'h>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'h RefCell<Response>> {
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1)?;
    let field = obj.get_internal_field(scope, 0)?;
    let brand = v8::Local::<v8::Value>::try_from(field).ok().and_then(|v| v8::Local::<v8::External>::try_from(v).ok())?;
    if brand.value() as *const u8 != std::ptr::addr_of!(BRAND) {
        return None;
    }
    // SAFETY: a branded object was made by `construct`, which wrapped a ResponseHandle under TAG; the handle lives while
    // its object, the argument, does — through this op.
    let handle = unsafe { v8::Object::unwrap::<TAG, ResponseHandle>(scope, obj)? };
    Some(unsafe { &(*(handle.as_ref() as *const ResponseHandle)).response })
}

// `__dom.ResponseStateBase`: the constructor of the isolate's template, made once per isolate.
fn base_function<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    scope.get_cpp_heap()?;
    let kept = crate::dom::dom(scope).response_state_template.clone();
    let template = match kept {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::FunctionTemplate::new(scope, construct);
            t.set_class_name(v8::String::new(scope, "ResponseStateBase")?);
            t.instance_template(scope).set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).response_state_template = Some(global);
            t
        }
    };
    template.get_function(scope)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    if let (Some(base), Some(name)) = (base_function(scope), v8::String::new(scope, "ResponseStateBase")) {
        ns.set(scope, name.into(), base.into());
    }
    crate::dom::register(scope, ns, "responseField", field_op, context_id);
}

// The fields `responseField` reads, by number (fetch.js `ResponseSlots` names them).
const TYPE: u32 = 0;
const URL: u32 = 1;
const STATUS: u32 = 2;
const STATUS_TEXT: u32 = 3;
const REDIRECTED: u32 = 4;
const OK: u32 = 5;
const LOCATION: u32 = 6;
const NULL_BODY_STATUS: u32 = 7;

// __dom.responseField(state, field) -> the response's `field`: `OK` whether its status is an ok one (200–299),
// `NULL_BODY_STATUS` whether it is one no body goes with (101, 103, 204, 205, 304).
fn field_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(response) = response(scope, args.get(0)) else { return };
    let r = response.borrow();
    let text = match args.get(1).uint32_value(scope).unwrap_or(u32::MAX) {
        TYPE => r.kind.as_str(),
        URL => &r.url,
        STATUS_TEXT => &r.status_text,
        LOCATION => &r.location,
        STATUS => return rv.set_uint32(r.status),
        REDIRECTED => return rv.set_bool(r.redirected),
        OK => return rv.set_bool((200..=299).contains(&r.status)),
        NULL_BODY_STATUS => return rv.set_bool(crate::fetch_rules::null_body_status(r.status)),
        _ => return,
    };
    if let Some(s) = v8::String::new(scope, text) {
        rv.set(s.into());
    }
}
