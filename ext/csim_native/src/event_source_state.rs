// An EventSource object's connection as the page sees it (HTML §9.2): its URL and the origin its messages carry — its
// URL's until a response announces the connection, then the URL's that response came from — whether it sends
// credentials, its ready state, the host's id for its connection, and what reestablishing it takes: its last event ID
// string and its reconnection time — on a handle the bindings' object wraps
// (`__dom.EventSourceStateBase`). The constructor's URL, `close()`, what each event the host delivers does to it, and
// which response a controlling service worker may answer it with are here; the stream, its reading (event_stream.rs)
// and the socket are the host's, and the events' objects the bindings'.

use std::cell::RefCell;

use v8::cppgc::{GarbageCollected, Visitor};

// The wrapper tag `Object::wrap` / `unwrap` file the handle under (ws_state.rs' 14).
const TAG: u16 = 15;

// What marks an object as a source's (its internal field 0).
static BRAND: u8 = 0;

const CONNECTING: u32 = 0;
const OPEN: u32 = 1;
const CLOSED: u32 = 2;

// The reconnection time a source starts with (HTML: "an implementation-defined value, probably in the region of a few
// seconds" — Chrome's).
const DEFAULT_RECONNECTION_MS: u64 = 3000;
// …and the longest it waits: the longest a timer can (HTML "timer initialization steps": a timeout past 2^31 - 1 ms is
// none at all), so a stream's `retry` of more waits as long as any wait may, never not at all.
const MAX_RECONNECTION_MS: u64 = i32::MAX as u64;

struct Source {
    url: String,
    origin: String,
    with_credentials: bool,
    ready_state: u32,
    id: i32,
    last_event_id: String,
    reconnection_ms: u64,
}

pub(crate) struct SourceHandle {
    source: RefCell<Source>,
}

unsafe impl GarbageCollected for SourceHandle {
    fn trace(&self, _visitor: &mut Visitor) {}
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"SourceHandle"
    }
}

// `new __dom.EventSourceStateBase(url, base, encoding, withCredentials)` — the constructor steps (HTML §9.2.2): `url`
// encoding-parsed relative to the settings object (its API base URL `base` and its encoding) — a failure a SyntaxError —
// the source connecting, its messages' origin the URL's.
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let url = args.get(0).to_rust_string_lossy(scope);
    let text = |scope: &mut v8::PinScope<'_, '_>, i: i32| (!args.get(i).is_null_or_undefined()).then(|| args.get(i).to_rust_string_lossy(scope));
    let (base, encoding) = (text(scope, 1), text(scope, 2));
    let Some(parsed) = crate::url_ops::encoding_parse(&url, base.as_deref(), encoding.as_deref()) else {
        let message = format!("Failed to construct 'EventSource': Cannot open an EventSource to '{url}'. The URL is invalid.");
        if let Some(message) = v8::String::new(scope, &message) {
            crate::clone::throw_dom_exception(scope, message, "SyntaxError");
        }
        return;
    };
    let source = Source {
        url: parsed.href().to_owned(),
        origin: parsed.origin().to_owned(),
        with_credentials: args.get(3).is_true(),
        ready_state: CONNECTING,
        id: 0,
        last_event_id: String::new(),
        reconnection_ms: DEFAULT_RECONNECTION_MS,
    };
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let handle = SourceHandle { source: RefCell::new(source) };
    let heap = scope.get_cpp_heap().expect("EventSourceStateBase is installed only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, SourceHandle>(scope, obj, &ptr);
    }
}

// The source `value` wraps, or None for anything that is no source's object (the brand first: `unwrap` reads garbage
// from an object it never wrapped).
fn source<'h>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'h RefCell<Source>> {
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1)?;
    let field = obj.get_internal_field(scope, 0)?;
    let brand = v8::Local::<v8::Value>::try_from(field).ok().and_then(|v| v8::Local::<v8::External>::try_from(v).ok())?;
    if brand.value() as *const u8 != std::ptr::addr_of!(BRAND) {
        return None;
    }
    // SAFETY: a branded object was made by `construct`, which wrapped a SourceHandle under TAG; the handle lives while its
    // object, the argument, does — through this op.
    let handle = unsafe { v8::Object::unwrap::<TAG, SourceHandle>(scope, obj)? };
    Some(unsafe { &(*(handle.as_ref() as *const SourceHandle)).source })
}

// `__dom.EventSourceStateBase`: the constructor of the isolate's template, made once per isolate.
fn base_function<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    scope.get_cpp_heap()?;
    let kept = crate::dom::dom(scope).event_source_state_template.clone();
    let template = match kept {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::FunctionTemplate::new(scope, construct);
            t.set_class_name(v8::String::new(scope, "EventSourceStateBase")?);
            t.instance_template(scope).set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).event_source_state_template = Some(global);
            t
        }
    };
    template.get_function(scope)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    if let (Some(base), Some(name)) = (base_function(scope), v8::String::new(scope, "EventSourceStateBase")) {
        ns.set(scope, name.into(), base.into());
    }
    crate::dom::register(scope, ns, "esField", field_op, context_id);
    crate::dom::register(scope, ns, "esSetId", set_id_op, context_id);
    crate::dom::register(scope, ns, "esClose", close_op, context_id);
    crate::dom::register(scope, ns, "esDeliver", deliver_op, context_id);
    crate::dom::register(scope, ns, "esServed", served_op, context_id);
    crate::dom::register(scope, ns, "esReconnect", reconnect_op, context_id);
}

// The fields `esField` reads, by number (event-source.js names them).
const URL: u32 = 0;
const ORIGIN: u32 = 1;
const WITH_CREDENTIALS: u32 = 2;
const READY_STATE: u32 = 3;
const LAST_EVENT_ID: u32 = 4;

// __dom.esField(state, field) -> the source's `field`.
fn field_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(source) = source(scope, args.get(0)) else { return };
    let s = source.borrow();
    let text = match args.get(1).uint32_value(scope).unwrap_or(u32::MAX) {
        URL => s.url.as_str(),
        ORIGIN => &s.origin,
        WITH_CREDENTIALS => return rv.set_bool(s.with_credentials),
        READY_STATE => return rv.set_uint32(s.ready_state),
        LAST_EVENT_ID => &s.last_event_id,
        _ => return,
    };
    if let Some(t) = v8::String::new(scope, text) {
        rv.set(t.into());
    }
}

// __dom.esSetId(state, id) — the host's id for its connection.
fn set_id_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(source) = source(scope, args.get(0)) else { return };
    let id = args.get(1).int32_value(scope).unwrap_or(0);
    source.borrow_mut().id = id;
}

// __dom.esClose(state) -> the host's id for the connection `close()` (or the unloading document cleanup steps) closes,
// 0 for none: the source closed, where it was not already.
fn close_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(source) = source(scope, args.get(0)) else { return };
    let mut s = source.borrow_mut();
    if s.ready_state == CLOSED {
        return rv.set_int32(0);
    }
    s.ready_state = CLOSED;
    rv.set_int32(s.id);
}

// What a delivery fires (`esDeliver`): nothing, `open`, `error`, or a message.
const FIRE_NONE: u32 = 0;
const FIRE_OPEN: u32 = 1;
const FIRE_ERROR: u32 = 2;
const FIRE_MESSAGE: u32 = 3;

// What one event the host delivered (or the bindings, a service worker's answer) does to a source of `ready_state`, its
// ready state after and the event it fires (`FIRE_*`):
//   "__open": "announce the connection" — while connecting, open, an `open`; nothing otherwise;
//   "__error" / "__fail": "fail the connection" — closed, an `error` (a simple event; no reconnect) — a fail of one
//     closed already nothing (a service worker's answer after `close()`);
//   any other: a message, its type the kind.
fn delivered(ready_state: u32, kind: &str) -> (u32, u32) {
    match kind {
        "__open" if ready_state == CONNECTING => (OPEN, FIRE_OPEN),
        "__open" => (ready_state, FIRE_NONE),
        "__fail" if ready_state == CLOSED => (CLOSED, FIRE_NONE),
        "__error" | "__fail" => (CLOSED, FIRE_ERROR),
        _ => (ready_state, FIRE_MESSAGE),
    }
}
// Whether a response of `status` and `content_type` announces a source's connection (HTML "process the event source
// response"): a 200 of a MIME type whose essence is `text/event-stream` — any other fails it. The host's reading of a
// live connection's response and a service worker's answer's.
fn response_ok(status: u32, content_type: &str) -> bool {
    status == 200 && crate::mime::extract(content_type).is_some_and(|m| m.essence == "text/event-stream")
}
// Capybara::Simulated::Native.event_stream_response_ok(status, content_type)
pub(crate) fn response_ok_for_ruby(status: u32, content_type: String) -> bool {
    response_ok(status, &content_type)
}
// …and what a controlling service worker's response does to a source: nothing for one closed already; one that does not
// announce it fails it — an `error`; any other announces it — open, an `open` — its body's events read after.
fn served(ready_state: u32, status: u32, content_type: &str) -> (u32, u32) {
    if ready_state == CLOSED {
        return (CLOSED, FIRE_NONE);
    }
    if response_ok(status, content_type) { delivered(ready_state, "__open") } else { delivered(ready_state, "__fail") }
}

// What an event that opened a source makes of the origin its messages carry: the origin of `url`, the URL of the response
// that announced the connection — where a redirect led — where it names one (HTML: "the serialization of the origin of
// the event stream's final URL").
fn opened_at(s: &mut Source, fire: u32, url: Option<String>) {
    if let Some(parsed) = url.filter(|_| fire == FIRE_OPEN).and_then(|u| ada_url::Url::parse(&u, None).ok()) {
        s.origin = parsed.origin();
    }
}
// (…the argument `i` as text, where it is a string)
fn text_arg(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, i: i32) -> Option<String> {
    args.get(i).is_string().then(|| args.get(i).to_rust_string_lossy(scope))
}

// __dom.esDeliver(state, kind, url) -> the event one event the host delivered fires (`delivered`), the source changed as
// it says — an `__open` of the `url` its response came from (`opened_at`).
fn deliver_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(source) = source(scope, args.get(0)) else { return };
    let kind = args.get(1).to_rust_string_lossy(scope);
    let url = text_arg(scope, &args, 2);
    let mut s = source.borrow_mut();
    let (ready_state, fire) = delivered(s.ready_state, &kind);
    s.ready_state = ready_state;
    opened_at(&mut s, fire, url);
    rv.set_uint32(fire);
}

// __dom.esServed(state, status, contentType, url) -> the event a controlling service worker's response fires (`served`),
// the source changed as it says — opened of the `url` the response is of (`opened_at`).
fn served_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(source) = source(scope, args.get(0)) else { return };
    let status = args.get(1).uint32_value(scope).unwrap_or(0);
    let content_type = args.get(2).to_rust_string_lossy(scope);
    let url = text_arg(scope, &args, 3);
    let mut s = source.borrow_mut();
    let (ready_state, fire) = served(s.ready_state, status, &content_type);
    s.ready_state = ready_state;
    opened_at(&mut s, fire, url);
    rv.set_uint32(fire);
}

// HTML "reestablish the connection", its first task: a stream that ended — its body read to its end, or cut off — leaves
// the source connecting again, of the last event ID string and reconnection time the stream left it (`retry`, where the
// stream set one), the number of ms to wait before asking again; none (None) for one closed already, which no
// reconnection reopens.
fn reconnected(s: &mut Source, last_event_id: String, retry: Option<u64>) -> Option<u64> {
    if s.ready_state == CLOSED {
        return None;
    }
    s.ready_state = CONNECTING;
    s.last_event_id = last_event_id;
    if let Some(retry) = retry {
        s.reconnection_ms = retry.min(MAX_RECONNECTION_MS);
    }
    Some(s.reconnection_ms)
}

// __dom.esReconnect(state, lastEventId, retry) -> the ms to wait before the source asks again, -1 for none
// (`reconnected`; `retry` -1 where the stream set none).
fn reconnect_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(source) = source(scope, args.get(0)) else { return };
    let last_event_id = args.get(1).to_rust_string_lossy(scope);
    let retry = args.get(2).number_value(scope).filter(|r| *r >= 0.0).map(|r| r as u64);
    let wait = reconnected(&mut source.borrow_mut(), last_event_id, retry);
    rv.set_double(wait.map_or(-1.0, |w| w as f64));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_source_opens_once_fails_once_and_takes_messages() {
        assert_eq!(delivered(CONNECTING, "__open"), (OPEN, FIRE_OPEN));
        assert_eq!(delivered(OPEN, "__open"), (OPEN, FIRE_NONE));
        assert_eq!(delivered(OPEN, "__error"), (CLOSED, FIRE_ERROR));
        assert_eq!(delivered(CLOSED, "__fail"), (CLOSED, FIRE_NONE));
        assert_eq!(delivered(OPEN, "message"), (OPEN, FIRE_MESSAGE));
        assert_eq!(served(CONNECTING, 200, "text/event-stream; charset=utf-8"), (OPEN, FIRE_OPEN));
        assert_eq!(served(CONNECTING, 200, "text/plain"), (CLOSED, FIRE_ERROR));
        assert_eq!(served(CONNECTING, 404, "text/event-stream"), (CLOSED, FIRE_ERROR));
        assert_eq!(served(CLOSED, 200, "text/event-stream"), (CLOSED, FIRE_NONE));
    }

    #[test]
    fn a_source_reconnects_of_what_its_stream_left_it() {
        let mut s = Source { url: String::new(), origin: String::new(), with_credentials: false, ready_state: OPEN, id: 1, last_event_id: String::new(), reconnection_ms: DEFAULT_RECONNECTION_MS };
        assert_eq!(reconnected(&mut s, "7".into(), None), Some(DEFAULT_RECONNECTION_MS));
        assert_eq!((s.ready_state, s.last_event_id.as_str()), (CONNECTING, "7"));
        // (…a retry kept for every later reconnection, until another sets it)
        assert_eq!(reconnected(&mut s, "8".into(), Some(200)), Some(200));
        assert_eq!(reconnected(&mut s, "8".into(), None), Some(200));
        assert_eq!(reconnected(&mut s, "8".into(), Some(u64::MAX)), Some(MAX_RECONNECTION_MS));
        s.ready_state = CLOSED;
        assert_eq!(reconnected(&mut s, "9".into(), Some(1)), None);
        assert_eq!(s.last_event_id, "8");
    }
}
