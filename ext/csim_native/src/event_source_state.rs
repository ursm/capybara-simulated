// An EventSource object's connection as the page sees it (HTML §9.2): its URL and the origin its messages carry, whether
// it sends credentials, its ready state, and the host's id for its connection — on a handle the bindings' object wraps
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

struct Source {
    url: String,
    origin: String,
    with_credentials: bool,
    ready_state: u32,
    id: i32,
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
}

// The fields `esField` reads, by number (event-source.js names them).
const URL: u32 = 0;
const ORIGIN: u32 = 1;
const WITH_CREDENTIALS: u32 = 2;
const READY_STATE: u32 = 3;
const ID: u32 = 4;

// __dom.esField(state, field) -> the source's `field`.
fn field_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(source) = source(scope, args.get(0)) else { return };
    let s = source.borrow();
    let text = match args.get(1).uint32_value(scope).unwrap_or(u32::MAX) {
        URL => s.url.as_str(),
        ORIGIN => &s.origin,
        WITH_CREDENTIALS => return rv.set_bool(s.with_credentials),
        READY_STATE => return rv.set_uint32(s.ready_state),
        ID => return rv.set_int32(s.id),
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

// __dom.esDeliver(state, kind) -> what one event the host delivered (or the bindings, a service worker's answer) does
// to the source, and the event it fires (`FIRE_*`):
//   "__open": "announce the connection" — while connecting, open, an `open`; nothing otherwise;
//   "__error" / "__fail": "fail the connection" — closed, an `error` (a simple event; no reconnect) — a fail of one
//     closed already nothing (a service worker's answer after `close()`);
//   any other: a message, its type the kind.
fn deliver_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(source) = source(scope, args.get(0)) else { return };
    let kind = args.get(1).to_rust_string_lossy(scope);
    let mut s = source.borrow_mut();
    let fire = match kind.as_str() {
        "__open" if s.ready_state == CONNECTING => {
            s.ready_state = OPEN;
            FIRE_OPEN
        }
        "__open" => FIRE_NONE,
        "__fail" if s.ready_state == CLOSED => FIRE_NONE,
        "__error" | "__fail" => {
            s.ready_state = CLOSED;
            FIRE_ERROR
        }
        _ => FIRE_MESSAGE,
    };
    rv.set_uint32(fire);
}

// __dom.esServed(state, status, contentType) -> what a controlling service worker's response does to the source (HTML
// "process the event source response"), the event it fires: none for one closed already; a status other than 200, or
// a MIME type whose essence is not `text/event-stream`, fails it — `error`; any other announces it — `open` — the
// bindings to read its body's events.
fn served_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(source) = source(scope, args.get(0)) else { return };
    let status = args.get(1).uint32_value(scope).unwrap_or(0);
    let content_type = args.get(2).to_rust_string_lossy(scope);
    let mut s = source.borrow_mut();
    if s.ready_state == CLOSED {
        return rv.set_uint32(FIRE_NONE);
    }
    let accepted = status == 200 && crate::mime::extract(&content_type).is_some_and(|m| m.essence == "text/event-stream");
    s.ready_state = if accepted { OPEN } else { CLOSED };
    rv.set_uint32(if accepted { FIRE_OPEN } else { FIRE_ERROR });
}
