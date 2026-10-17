// A Request object's request (Fetch §2.2.5) — what its getters read and a fetch of it sends: its URL, method, mode,
// credentials, cache and redirect modes, referrer and its policy, integrity metadata, keepalive, destination and a
// navigation's flags — on a handle the bindings' object wraps (`__dom.RequestStateBase`), made by the Request
// constructor's steps here (Fetch "new Request(input, init)", §5.4). What is the page's objects stays the bindings':
// the request's signal, its Headers object, its body and the blob its URL named.

use std::cell::RefCell;

use v8::cppgc::{GarbageCollected, Visitor};

// The wrapper tag `Object::wrap` / `unwrap` file the handle under (search_params.rs' 10).
const TAG: u16 = 11;

// What marks an object as a request's (its internal field 0).
static BRAND: u8 = 0;

#[derive(Clone)]
pub(crate) struct Request {
    url: String,
    method: String,
    mode: String,
    credentials: String,
    cache: String,
    redirect: String,
    // "about:client", the empty string for no referrer, or a URL.
    referrer: String,
    referrer_policy: String,
    integrity: String,
    keepalive: bool,
    destination: String,
    reload_navigation: bool,
    history_navigation: bool,
    // A navigation's: the navigating document's origin (none for an opaque one), the redirect chain's latched
    // Sec-Fetch-Site seed and Origin taint, and the cookie verdict of the frame it commits into (RFC 6265bis
    // site-for-cookies) — a property of the TARGET frame, which a non-empty init does not reset.
    initiator: Option<String>,
    site_seed: Option<String>,
    origin_null: bool,
    cookie_cross_site: bool,
}

impl Request {
    // A new request of `url`, as "new Request" makes one from a string (before its mode falls back to "cors").
    fn new(url: String) -> Self {
        Request {
            url,
            method: "GET".into(),
            mode: String::new(),
            credentials: "same-origin".into(),
            cache: "default".into(),
            redirect: "follow".into(),
            referrer: "about:client".into(),
            referrer_policy: String::new(),
            integrity: String::new(),
            keepalive: false,
            destination: String::new(),
            reload_navigation: false,
            history_navigation: false,
            initiator: None,
            site_seed: None,
            origin_null: false,
            cookie_cross_site: false,
        }
    }
}

pub(crate) struct RequestHandle {
    request: RefCell<Request>,
}

unsafe impl GarbageCollected for RequestHandle {
    fn trace(&self, _visitor: &mut Visitor) {}
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"RequestHandle"
    }
}

fn throw_type_error(scope: &mut v8::PinScope<'_, '_>, message: &str) {
    if let Some(message) = v8::String::new(scope, message) {
        let error = v8::Exception::type_error(scope, message);
        scope.throw_exception(error);
    }
}

// The member `key` of the converted RequestInit `init`, None where it is not given (a dictionary member left out).
fn member<'s>(scope: &mut v8::PinScope<'s, '_>, init: v8::Local<'_, v8::Object>, key: &str) -> Option<v8::Local<'s, v8::Value>> {
    let k = v8::String::new(scope, key)?;
    init.get(scope, k.into()).filter(|v| !v.is_undefined())
}


// Fetch's Request-constructor referrer processing: the empty string is no referrer; any other value is parsed against
// the API base URL — a failure a TypeError — and one that is `about:client`, or of another origin than the document's
// (an opaque document's every one), collapses to `about:client`, leaking no cross-origin referrer; a same-origin URL
// is kept as its serialization.
fn processed_referrer(referrer: &str, base: &str, origin: &str) -> Result<String, String> {
    if referrer.is_empty() {
        return Ok(String::new());
    }
    let Some(url) = crate::url_ops::encoding_parse(referrer, Some(base), None) else {
        return Err(format!("Referrer '{referrer}' is not a valid URL."));
    };
    if (url.protocol() == "about:" && url.pathname() == "client") || origin == "null" || url.origin() != origin {
        return Ok("about:client".into());
    }
    Ok(url.href().to_owned())
}

// The Request constructor's steps over the request (Fetch "new Request(input, init)"), the bindings' objects aside:
// `source` the input Request's request (none for a URL string `input`, parsed against `base`), `init` the converted
// RequestInit, `origin` the document's — every refusal a TypeError's message, the caller's prefix before it.
// (`navigation`: a navigation's request, its URL the navigate algorithm's, which no credentials check refuses.)
fn construct_request(
    scope: &mut v8::PinScope<'_, '_>,
    source: Option<Request>,
    input: &str,
    init: v8::Local<'_, v8::Object>,
    navigation: bool,
    base: &str,
    origin: &str,
) -> Result<Request, String> {
    let (mut request, fallback_mode) = match source {
        Some(source) => (source, None),
        None => {
            // (…a string parsed against the API base URL — an unparseable one, or one with credentials, a TypeError)
            let Some(url) = crate::url_ops::encoding_parse(input, Some(base), None) else {
                return Err(format!("Failed to parse URL from {input}"));
            };
            if !navigation && (!url.username().is_empty() || !url.password().is_empty()) {
                return Err(format!("Request cannot be constructed from a URL that includes credentials: {input}"));
            }
            (Request::new(url.href().to_owned()), Some("cors"))
        }
    };
    if member(scope, init, "window").is_some_and(|w| !w.is_null()) {
        return Err("'window' must be null".into());
    }
    // A NON-EMPTY init detaches the request from a source Request's navigation: mode "navigate" is "same-origin", the
    // reload and history flags unset, its origin and referrer reset to the client's, its referrer policy cleared, its
    // URL list collapsed (the redirect chain's seed and taint dropped). So a service worker's `new Request(event.request,
    // {mode})` derives everything from its own global again, where `fetch(event.request)` and `clone()` keep the
    // navigation's request as it is. (The origin is reset only where the source WAS a navigation: it had an initiator.)
    let non_empty = init.get_own_property_names(scope, v8::GetPropertyNamesArgs::default()).is_some_and(|names| names.length() > 0);
    if non_empty {
        if request.mode == "navigate" {
            request.mode = "same-origin".into();
        }
        request.reload_navigation = false;
        request.history_navigation = false;
        if request.initiator.is_some() {
            request.initiator = (origin != "null" && !origin.is_empty()).then(|| origin.to_owned());
        }
        request.site_seed = None;
        request.origin_null = false;
        request.referrer = "about:client".into();
        request.referrer_policy = String::new();
    }
    let text = |scope: &mut v8::PinScope<'_, '_>, key: &str| member(scope, init, key).map(|v| v.to_rust_string_lossy(scope));
    if let Some(referrer) = text(scope, "referrer") {
        request.referrer = processed_referrer(&referrer, base, origin)?;
    }
    if let Some(policy) = text(scope, "referrerPolicy") {
        request.referrer_policy = policy;
    }
    let mode = text(scope, "mode").or_else(|| fallback_mode.map(str::to_owned));
    if mode.as_deref() == Some("navigate") {
        return Err("Cannot construct a Request with a RequestInit whose mode member is set as 'navigate'.".into());
    }
    if let Some(mode) = mode {
        request.mode = mode;
    }
    if let Some(credentials) = text(scope, "credentials") {
        request.credentials = credentials;
    }
    if let Some(cache) = text(scope, "cache") {
        request.cache = cache;
    }
    if request.cache == "only-if-cached" && request.mode != "same-origin" {
        return Err("'only-if-cached' can be set only with 'same-origin' mode".into());
    }
    if let Some(redirect) = text(scope, "redirect") {
        request.redirect = redirect;
    }
    if let Some(integrity) = text(scope, "integrity") {
        request.integrity = integrity;
    }
    if let Some(keepalive) = member(scope, init, "keepalive") {
        request.keepalive = keepalive.boolean_value(scope);
    }
    if let Some(method) = member(scope, init, "method") {
        let bytes = crate::fetch_rules::byte_string(scope, method);
        let shown = method.to_rust_string_lossy(scope);
        if !crate::fetch_rules::is_token(&bytes) {
            return Err(format!("'{shown}' is not a valid HTTP method."));
        }
        if crate::fetch_rules::forbidden_method(&bytes) {
            return Err(format!("'{shown}' HTTP method is unsupported."));
        }
        request.method = crate::fetch_rules::normalized_method(&bytes).map_or(shown, str::to_owned);
    }
    // (…a no-cors request takes a CORS-safelisted method alone)
    if request.mode == "no-cors" && !crate::fetch_rules::cors_safelisted_method(request.method.as_bytes()) {
        return Err(format!("'{}' is unsupported in no-cors mode.", request.method));
    }
    Ok(request)
}

// The constructor a Request object's request is made with — `new __dom.RequestStateBase(source, input, init,
// navigation, base, origin, prefix)`, the constructor's steps (`construct_request`) against the calling realm's API base
// URL and document origin (the template is the isolate's, which knows no realm): a TypeError, its message after
// `prefix`, where they refuse. With no `init` at all, a copy of `source`'s request (Fetch "clone a request").
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let source = request(scope, args.get(0)).map(|r| r.borrow().clone());
    let made = match v8::Local::<v8::Object>::try_from(args.get(2)) {
        Err(_) => source.ok_or_else(String::new),
        Ok(init) => {
            let input = args.get(1).to_rust_string_lossy(scope);
            let navigation = args.get(3).boolean_value(scope);
            let base = args.get(4).to_rust_string_lossy(scope);
            let origin = args.get(5).to_rust_string_lossy(scope);
            construct_request(scope, source, &input, init, navigation, &base, &origin)
        }
    };
    let request = match made {
        Ok(request) => request,
        Err(message) => {
            let prefix = args.get(6).to_rust_string_lossy(scope);
            return throw_type_error(scope, &format!("{prefix}{message}"));
        }
    };
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let handle = RequestHandle { request: RefCell::new(request) };
    let heap = scope.get_cpp_heap().expect("RequestStateBase is installed only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, RequestHandle>(scope, obj, &ptr);
    }
}

// The request `value` wraps, or None for anything that is no request's object (the brand first: `unwrap` reads garbage
// from an object it never wrapped).
fn request<'h>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'h RefCell<Request>> {
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1)?;
    let field = obj.get_internal_field(scope, 0)?;
    let brand = v8::Local::<v8::Value>::try_from(field).ok().and_then(|v| v8::Local::<v8::External>::try_from(v).ok())?;
    if brand.value() as *const u8 != std::ptr::addr_of!(BRAND) {
        return None;
    }
    // SAFETY: a branded object was made by `construct`, which wrapped a RequestHandle under TAG; the handle lives while
    // its object, the argument, does — through this op.
    let handle = unsafe { v8::Object::unwrap::<TAG, RequestHandle>(scope, obj)? };
    Some(unsafe { &(*(handle.as_ref() as *const RequestHandle)).request })
}

// `__dom.RequestStateBase`: the constructor of the isolate's template, made once per isolate.
fn base_function<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    scope.get_cpp_heap()?;
    let kept = crate::dom::dom(scope).request_state_template.clone();
    let template = match kept {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::FunctionTemplate::new(scope, construct);
            t.set_class_name(v8::String::new(scope, "RequestStateBase")?);
            t.instance_template(scope).set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).request_state_template = Some(global);
            t
        }
    };
    template.get_function(scope)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    if let (Some(base), Some(name)) = (base_function(scope), v8::String::new(scope, "RequestStateBase")) {
        ns.set(scope, name.into(), base.into());
    }
    crate::dom::register(scope, ns, "requestField", field_op, context_id);
    crate::dom::register(scope, ns, "requestAdopt", adopt_op, context_id);
    crate::dom::register(scope, ns, "requestRefusesBody", refuses_body_op, context_id);
    crate::dom::register(scope, ns, "requestStreamRefusal", stream_refusal_op, context_id);
}

// The fields `requestField` reads, by number (fetch.js `RequestSlots` names them).
const URL: u32 = 0;
const METHOD: u32 = 1;
const MODE: u32 = 2;
const CREDENTIALS: u32 = 3;
const CACHE: u32 = 4;
const REDIRECT: u32 = 5;
const REFERRER: u32 = 6;
const REFERRER_POLICY: u32 = 7;
const INTEGRITY: u32 = 8;
const KEEPALIVE: u32 = 9;
const DESTINATION: u32 = 10;
const RELOAD_NAVIGATION: u32 = 11;
const HISTORY_NAVIGATION: u32 = 12;
const INITIATOR: u32 = 13;
const SITE_SEED: u32 = 14;
const ORIGIN_NULL: u32 = 15;
const COOKIE_CROSS_SITE: u32 = 16;
const HEADERS_GUARD: u32 = 17;

// __dom.requestField(state, field) -> the request's `field` (a string, a boolean, or null for an absent origin or
// seed) — `HEADERS_GUARD` the guard its Headers object takes: a no-cors request's drops the headers no no-cors request
// may carry.
fn field_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(request) = request(scope, args.get(0)) else { return };
    let r = request.borrow();
    let field = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let text = match field {
        URL => r.url.as_str(),
        METHOD => &r.method,
        MODE => &r.mode,
        CREDENTIALS => &r.credentials,
        CACHE => &r.cache,
        REDIRECT => &r.redirect,
        REFERRER => &r.referrer,
        REFERRER_POLICY => &r.referrer_policy,
        INTEGRITY => &r.integrity,
        DESTINATION => &r.destination,
        HEADERS_GUARD => if r.mode == "no-cors" { "request-no-cors" } else { "request" },
        KEEPALIVE | RELOAD_NAVIGATION | HISTORY_NAVIGATION | ORIGIN_NULL | COOKIE_CROSS_SITE => {
            let flag = match field {
                KEEPALIVE => r.keepalive,
                RELOAD_NAVIGATION => r.reload_navigation,
                HISTORY_NAVIGATION => r.history_navigation,
                ORIGIN_NULL => r.origin_null,
                _ => r.cookie_cross_site,
            };
            return rv.set_bool(flag);
        }
        INITIATOR | SITE_SEED => match if field == INITIATOR { &r.initiator } else { &r.site_seed } {
            Some(text) => text,
            None => return rv.set_null(),
        },
        _ => return,
    };
    if let Some(s) = v8::String::new(scope, text) {
        rv.set(s.into());
    }
}

// __dom.requestAdopt(state, record): the request takes what `record` gives of a request no Request constructor makes —
// a navigation's, crossing to a service worker's fetch event (a mode "navigate", its destination, reload and history
// flags, its initiator, seed, taint and cookie verdict) or stored in a cache — and the modes and referrer the client's
// request had: each member a value that is given (a flag that is true), the rest kept. A navigation given no
// credentials mode takes "include" (Fetch "create a navigation request").
fn adopt_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(request) = request(scope, args.get(0)) else { return };
    let Ok(record) = v8::Local::<v8::Object>::try_from(args.get(1)) else { return };
    let given = |scope: &mut v8::PinScope<'_, '_>, key: &str| {
        member(scope, record, key).filter(|v| !v.is_null()).map(|v| (v.to_rust_string_lossy(scope), v.boolean_value(scope)))
    };
    let text = |scope: &mut v8::PinScope<'_, '_>, key: &str| given(scope, key).map(|(t, _)| t).filter(|t| !t.is_empty());
    let flag = |scope: &mut v8::PinScope<'_, '_>, key: &str| given(scope, key).is_some_and(|(_, b)| b);
    let r = &mut *request.borrow_mut();
    for (key, slot) in [
        ("mode", &mut r.mode),
        ("destination", &mut r.destination),
        ("redirect", &mut r.redirect),
        ("credentials", &mut r.credentials),
        ("cache", &mut r.cache),
        ("integrity", &mut r.integrity),
        ("referrerPolicy", &mut r.referrer_policy),
    ] {
        if let Some(value) = text(scope, key) {
            *slot = value;
        }
    }
    // (…a referrer given is the request's, the empty one — no referrer — too)
    if let Some((referrer, _)) = given(scope, "referrer") {
        r.referrer = referrer;
    }
    if let Some((initiator, _)) = given(scope, "initiator") {
        r.initiator = Some(initiator);
    }
    if let Some((seed, _)) = given(scope, "siteSeed") {
        r.site_seed = Some(seed);
    }
    for (key, slot) in [
        ("keepalive", &mut r.keepalive),
        ("isReloadNavigation", &mut r.reload_navigation),
        ("isHistoryNavigation", &mut r.history_navigation),
        ("originNull", &mut r.origin_null),
        ("cookieCrossSite", &mut r.cookie_cross_site),
    ] {
        if flag(scope, key) {
            *slot = true;
        }
    }
    if r.mode == "navigate" && text(scope, "credentials").is_none() {
        r.credentials = "include".into();
    }
}

// __dom.requestRefusesBody(state) -> whether the request may have no body: a GET's or a HEAD's.
fn refuses_body_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(request) = request(scope, args.get(0)) else { return };
    let method = &request.borrow().method;
    rv.set_bool(method == "GET" || method == "HEAD");
}

// __dom.requestStreamRefusal(state, duplexGiven) -> why the request may not have a STREAM body, or null where it may:
// only with an explicit duplex "half" — RequestDuplex has no other value — and only in mode "same-origin" or "cors",
// which a stream body's CORS preflight needs (Chrome's message, its missing space and all).
fn stream_refusal_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(request) = request(scope, args.get(0)) else { return };
    let message = if !args.get(1).boolean_value(scope) {
        "The `duplex` member must be specified for a request with a streaming body"
    } else if !matches!(request.borrow().mode.as_str(), "same-origin" | "cors") {
        "If request is made from ReadableStream, mode should be\"same-origin\" or \"cors\""
    } else {
        return rv.set_null();
    };
    if let Some(s) = v8::String::new(scope, message) {
        rv.set(s.into());
    }
}
