// A WebSocket object's connection as the page sees it (WebSockets §3): its URL and the origin a message carries, its
// ready state, the bytes `send` queued — those sent while it was open, which the event loop's next turn sees gone, and
// those given it once closing, which never go — the subprotocol the server chose among those offered, its binary type,
// whether `close()` came while it was still connecting, and the host's id for its connection — on a handle the
// bindings' object wraps (`__dom.WebSocketStateBase`). The constructor's checks, `close()`'s, and what each event the
// host delivers does to it — the events it fires, in order — are here; the frames, the handshake and the socket are the
// host's, and the events' objects and the messages' data the bindings'.

use std::cell::RefCell;

use v8::cppgc::{GarbageCollected, Visitor};

// The wrapper tag `Object::wrap` / `unwrap` file the handle under (response_state.rs' 13).
const TAG: u16 = 14;

// What marks an object as a socket's (its internal field 0).
static BRAND: u8 = 0;

const CONNECTING: u32 = 0;
const OPEN: u32 = 1;
const CLOSING: u32 = 2;
const CLOSED: u32 = 3;

const CONSTRUCT: &str = "Failed to construct 'WebSocket': ";

struct Socket {
    url: String,
    origin: String,
    ready_state: u32,
    queued: f64,
    unsent: f64,
    draining: bool,
    protocol: String,
    binary_type: String,
    protocols: Vec<String>,
    fail_connecting: bool,
    id: i32,
    bad_port: bool,
}

pub(crate) struct SocketHandle {
    socket: RefCell<Socket>,
}

unsafe impl GarbageCollected for SocketHandle {
    fn trace(&self, _visitor: &mut Visitor) {}
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"SocketHandle"
    }
}

fn throw(scope: &mut v8::PinScope<'_, '_>, message: &str, name: &str) {
    if let Some(message) = v8::String::new(scope, message) {
        crate::clone::throw_dom_exception(scope, message, name);
    }
}

// The constructor steps: `url` parsed against the API base URL `base` (no encoding-parse: WebSockets §3.1) — a failure a
// SyntaxError — an http(s) scheme made ws(s), any other but ws(s) refused, a fragment refused; each subprotocol a token,
// none twice — ASCII case-insensitively (websockets/Create-protocols-repeated-case-insensitive; Chrome takes `['a',
// 'A']`). A port no request goes to is noted (`bad_port`): its connection is failed, not attempted.
fn opened(url: &str, offered: Vec<(String, Vec<u8>)>, base: Option<&str>) -> Result<Socket, String> {
    let Some(parsed) = crate::url_ops::encoding_parse(url, base, None) else {
        return Err(format!("The URL '{url}' is invalid."));
    };
    let (scheme, href) = match parsed.protocol() {
        "http:" => ("ws:", format!("ws:{}", &parsed.href()[5..])),
        "https:" => ("wss:", format!("wss:{}", &parsed.href()[6..])),
        other => (other, parsed.href().to_owned()),
    };
    if scheme != "ws:" && scheme != "wss:" {
        let shown = scheme.strip_suffix(':').unwrap_or(scheme);
        return Err(format!("The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. '{shown}' is not allowed."));
    }
    if !parsed.hash().is_empty() {
        let fragment = &parsed.hash()[1..];
        return Err(format!("The URL contains a fragment identifier ('{fragment}'). Fragment identifiers are not allowed in WebSocket URLs."));
    }
    let mut seen = std::collections::HashSet::new();
    for (p, bytes) in &offered {
        if !crate::fetch_rules::is_token(bytes) {
            return Err(format!("The subprotocol '{p}' is invalid."));
        }
        if !seen.insert(p.to_ascii_lowercase()) {
            return Err(format!("The subprotocol '{p}' is duplicated."));
        }
    }
    let bad_port = parsed.port().parse::<u32>().is_ok_and(crate::fetch_rules::bad_port);
    let protocols = offered.into_iter().map(|(p, _)| p).collect();
    Ok(Socket {
        url: href,
        origin: format!("{scheme}//{}", parsed.host()),
        ready_state: CONNECTING,
        queued: 0.0,
        unsent: 0.0,
        draining: false,
        protocol: String::new(),
        binary_type: "blob".into(),
        protocols,
        fail_connecting: false,
        id: 0,
        bad_port,
    })
}

// `new __dom.WebSocketStateBase(url, protocols, base)` — the constructor steps (`opened`): a SyntaxError where they refuse.
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let url = args.get(0).to_rust_string_lossy(scope);
    let mut protocols = Vec::new();
    if let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(1)) {
        for i in 0..list.length() {
            if let Some(p) = list.get_index(scope, i) {
                let bytes = crate::fetch_rules::byte_string(scope, p);
                protocols.push((p.to_rust_string_lossy(scope), bytes));
            }
        }
    }
    let base = (!args.get(2).is_null_or_undefined()).then(|| args.get(2).to_rust_string_lossy(scope));
    let socket = match opened(&url, protocols, base.as_deref()) {
        Ok(socket) => socket,
        Err(message) => return throw(scope, &format!("{CONSTRUCT}{message}"), "SyntaxError"),
    };
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let handle = SocketHandle { socket: RefCell::new(socket) };
    let heap = scope.get_cpp_heap().expect("WebSocketStateBase is installed only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, SocketHandle>(scope, obj, &ptr);
    }
}

// The socket `value` wraps, or None for anything that is no socket's object (the brand first: `unwrap` reads garbage
// from an object it never wrapped).
fn socket<'h>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'h RefCell<Socket>> {
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1)?;
    let field = obj.get_internal_field(scope, 0)?;
    let brand = v8::Local::<v8::Value>::try_from(field).ok().and_then(|v| v8::Local::<v8::External>::try_from(v).ok())?;
    if brand.value() as *const u8 != std::ptr::addr_of!(BRAND) {
        return None;
    }
    // SAFETY: a branded object was made by `construct`, which wrapped a SocketHandle under TAG; the handle lives while its
    // object, the argument, does — through this op.
    let handle = unsafe { v8::Object::unwrap::<TAG, SocketHandle>(scope, obj)? };
    Some(unsafe { &(*(handle.as_ref() as *const SocketHandle)).socket })
}

// `__dom.WebSocketStateBase`: the constructor of the isolate's template, made once per isolate.
fn base_function<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    scope.get_cpp_heap()?;
    let kept = crate::dom::dom(scope).ws_state_template.clone();
    let template = match kept {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::FunctionTemplate::new(scope, construct);
            t.set_class_name(v8::String::new(scope, "WebSocketStateBase")?);
            t.instance_template(scope).set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).ws_state_template = Some(global);
            t
        }
    };
    template.get_function(scope)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    if let (Some(base), Some(name)) = (base_function(scope), v8::String::new(scope, "WebSocketStateBase")) {
        ns.set(scope, name.into(), base.into());
    }
    crate::dom::register(scope, ns, "wsField", field_op, context_id);
    crate::dom::register(scope, ns, "wsSetField", set_field_op, context_id);
    crate::dom::register(scope, ns, "wsSend", send_op, context_id);
    crate::dom::register(scope, ns, "wsDrained", drained_op, context_id);
    crate::dom::register(scope, ns, "wsClose", close_op, context_id);
    crate::dom::register(scope, ns, "wsDeliver", deliver_op, context_id);
}

// The fields `wsField` reads and `wsSetField` writes, by number (websocket.js names them).
const URL: u32 = 0;
const ORIGIN: u32 = 1;
const READY_STATE: u32 = 2;
const BUFFERED_AMOUNT: u32 = 3;
const PROTOCOL: u32 = 4;
const BINARY_TYPE: u32 = 5;
const ID: u32 = 6;
const BAD_PORT: u32 = 7;
const PROTOCOLS: u32 = 8;

// __dom.wsField(state, field) -> the socket's `field`: `BUFFERED_AMOUNT` what `send` queued and what it was given once
// closing, `PROTOCOLS` those it offered.
fn field_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(socket) = socket(scope, args.get(0)) else { return };
    let s = socket.borrow();
    let text = match args.get(1).uint32_value(scope).unwrap_or(u32::MAX) {
        URL => s.url.as_str(),
        ORIGIN => &s.origin,
        PROTOCOL => &s.protocol,
        BINARY_TYPE => &s.binary_type,
        READY_STATE => return rv.set_uint32(s.ready_state),
        BUFFERED_AMOUNT => return rv.set_double(s.queued + s.unsent),
        ID => return rv.set_int32(s.id),
        BAD_PORT => return rv.set_bool(s.bad_port),
        PROTOCOLS => {
            let items: Vec<v8::Local<'_, v8::Value>> =
                s.protocols.iter().filter_map(|p| v8::String::new(scope, p)).map(Into::into).collect();
            return rv.set(v8::Array::new_with_elements(scope, &items).into());
        }
        _ => return,
    };
    if let Some(t) = v8::String::new(scope, text) {
        rv.set(t.into());
    }
}

// __dom.wsSetField(state, field, value) — its binary type, or the host's id for its connection.
fn set_field_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(socket) = socket(scope, args.get(0)) else { return };
    let field = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let value = args.get(2);
    let mut s = socket.borrow_mut();
    match field {
        BINARY_TYPE => s.binary_type = value.to_rust_string_lossy(scope),
        ID => s.id = value.int32_value(scope).unwrap_or(0),
        _ => {}
    }
}

// __dom.wsSend(state, bytes, sent) -> what `send` does: an InvalidStateError while connecting; once closing or closed
// nothing is sent, and the `bytes` it was given count all the same, as they never leave (WebSockets §3 "must increase
// the bufferedAmount") — 0; on an open connection 1 for the bindings to send the frame, then called again with `sent`
// its size, which counts until the event loop next turns (the transport writes at once: the queue is notional) — 2
// where that is the first since it last turned, whose microtask `wsDrained` is.
fn send_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(socket) = socket(scope, args.get(0)) else { return };
    let bytes = args.get(1).number_value(scope).unwrap_or(0.0);
    let sent = args.get(2).boolean_value(scope);
    let mut s = socket.borrow_mut();
    if s.ready_state == CONNECTING {
        drop(s);
        return throw(scope, "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", "InvalidStateError");
    }
    if s.ready_state != OPEN {
        s.unsent += bytes;
        return rv.set_uint32(0);
    }
    if !sent {
        return rv.set_uint32(1);
    }
    s.queued += bytes;
    if s.draining {
        return rv.set_uint32(1);
    }
    s.draining = true;
    rv.set_uint32(2);
}
// __dom.wsDrained(state) — the event loop turned: what was sent is gone.
fn drained_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if let Some(socket) = socket(scope, args.get(0)) {
        let mut s = socket.borrow_mut();
        s.draining = false;
        s.queued = 0.0;
    }
}

// __dom.wsClose(state, code, reasonBytes, goingAway) -> the code to close the connection with (null for none: a bodyless
// close frame, which the peer echoes as 1005), or undefined where nothing is sent. `close()`'s checks: a code 1000 or
// 3000–4999 (InvalidAccessError — after [Clamp], so `close(2 ** 16 + 1000)` reports 65535), a reason of at most 123
// UTF-8 bytes (SyntaxError); nothing more once closing; while connecting, the connection fails — its close abnormal
// (1006) whatever the server's handshake says. A reason with no code goes with 1000 (the spec's "set code to 1000").
// With `goingAway`, the "unloading document cleanup steps": one connecting or open closes as Going Away (1001).
fn close_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(socket) = socket(scope, args.get(0)) else { return };
    let code = (!args.get(1).is_undefined()).then(|| args.get(1).uint32_value(scope).unwrap_or(0));
    let reason_bytes = (!args.get(2).is_undefined()).then(|| args.get(2).number_value(scope).unwrap_or(0.0));
    let going_away = args.get(3).boolean_value(scope);
    if !going_away {
        if let Some(code) = code.filter(|&c| c != 1000 && !(3000..=4999).contains(&c)) {
            let message = format!(
                "Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. {code} is neither."
            );
            return throw(scope, &message, "InvalidAccessError");
        }
        if reason_bytes.is_some_and(|n| n > 123.0) {
            return throw(scope, "Failed to execute 'close' on 'WebSocket': The close reason must not be greater than 123 UTF-8 bytes.", "SyntaxError");
        }
    }
    let mut s = socket.borrow_mut();
    if s.ready_state == CLOSING || s.ready_state == CLOSED {
        return;
    }
    if s.ready_state == CONNECTING && !going_away {
        s.fail_connecting = true;
    }
    s.ready_state = CLOSING;
    let code = if going_away { Some(1001) } else { code.or(reason_bytes.map(|_| 1000)) };
    match code {
        Some(code) => rv.set_uint32(code),
        None => rv.set_null(),
    }
}

// __dom.wsDeliver(state, type, protocol, code, reason) -> the events one the host delivered fires, in order — each
// `[type]`, a close's `[type, code, reason, wasClean]` — none where it does nothing to the socket:
//   "__open": while connecting, opened — unless the server chose a subprotocol it did not offer (exact, case-sensitive:
//     the connection failed, an error and an abnormal close, no open; none chosen is always one);
//   "__close" / "__error": closed, its ready state CLOSED before any event (an `error` / `close` handler sees it); an
//     error first for an error, or where `close()` failed it connecting; its close where it was not closed already — the
//     server's code (1000 by default) for a clean close, 1006 and not clean for an abnormal drop (an `__error`, a
//     `__close` with no code, a close that raced the opening handshake).
fn deliver_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(socket) = socket(scope, args.get(0)) else { return };
    let kind = args.get(1).to_rust_string_lossy(scope);
    let mut events: Vec<(&str, Option<(u32, String, bool)>)> = Vec::new();
    {
        let mut s = socket.borrow_mut();
        match kind.as_str() {
            "__open" if s.ready_state == CONNECTING => {
                let protocol = if args.get(2).is_null_or_undefined() { String::new() } else { args.get(2).to_rust_string_lossy(scope) };
                if !protocol.is_empty() && !s.protocols.contains(&protocol) {
                    s.ready_state = CLOSED;
                    events.push(("error", None));
                    events.push(("close", Some((1006, String::new(), false))));
                } else {
                    s.ready_state = OPEN;
                    s.protocol = protocol;
                    events.push(("open", None));
                }
            }
            "__close" | "__error" => {
                let fire_close = s.ready_state != CLOSED;
                s.ready_state = CLOSED;
                if kind == "__error" || (fire_close && s.fail_connecting) {
                    events.push(("error", None));
                }
                if fire_close {
                    let code = (!args.get(3).is_null_or_undefined()).then(|| args.get(3).uint32_value(scope).unwrap_or(0));
                    let abnormal = s.fail_connecting || code.is_none();
                    let reason = if s.fail_connecting || args.get(4).is_null_or_undefined() { String::new() } else { args.get(4).to_rust_string_lossy(scope) };
                    let clean = kind == "__close" && code.is_some() && !s.fail_connecting;
                    events.push(("close", Some((if abnormal { 1006 } else { code.unwrap_or(1006) }, reason, clean))));
                }
            }
            _ => {}
        }
    }
    let mut items: Vec<v8::Local<'_, v8::Value>> = Vec::with_capacity(events.len());
    for (name, close) in events {
        let mut fields: Vec<v8::Local<'_, v8::Value>> = vec![v8::String::new(scope, name).map_or_else(|| v8::undefined(scope).into(), Into::into)];
        if let Some((code, reason, clean)) = close {
            fields.push(v8::Integer::new_from_unsigned(scope, code).into());
            fields.push(v8::String::new(scope, &reason).map_or_else(|| v8::undefined(scope).into(), Into::into));
            fields.push(v8::Boolean::new(scope, clean).into());
        }
        items.push(v8::Array::new_with_elements(scope, &fields).into());
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
