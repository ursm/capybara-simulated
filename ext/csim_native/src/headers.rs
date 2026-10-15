// A Headers object's header list (Fetch §5.2): the values of each name combined — but `set-cookie`'s, which stay one per
// header — the name each header was first given (the casing it goes on the wire in), in the order the names were
// appended, and its guard, which decides what a script may write to it. A Headers object holds a handle on V8's C++
// heap (`__dom.HeadersBase`, as a canvas state's does: canvas_state.rs) that owns the list; the bindings convert the
// arguments, throw what a refused write is, and keep the sorted pairs an iteration reads until the list next changes.

use std::cell::RefCell;

use v8::cppgc::{GarbageCollected, Visitor};

use crate::fetch_rules::{forbidden_request_header, forbidden_response_header, is_token, no_cors_safelisted_request_header};

// The wrapper tag `Object::wrap` / `unwrap` file the handle under (a node's is 1, a range's 2, an iterator's 3, a canvas
// state's 4, a canvas paint's 5, a selection's 6).
const TAG: u16 = 7;

// What marks an object as a header list's (its internal field 0).
static BRAND: u8 = 0;

// The guards, by the code the bindings name each with (headers.js `GUARDS`).
pub(crate) const GUARD_NONE: u32 = 0;
pub(crate) const GUARD_REQUEST: u32 = 1;
pub(crate) const GUARD_REQUEST_NO_CORS: u32 = 2;
pub(crate) const GUARD_RESPONSE: u32 = 3;
pub(crate) const GUARD_IMMUTABLE: u32 = 4;

// What a write came to: done (or dropped, as a guard drops a forbidden header silently), or refused — the name is no
// header name, the value no header value, the list immutable.
pub(crate) const WRITTEN: u32 = 0;
pub(crate) const BAD_NAME: u32 = 1;
pub(crate) const BAD_VALUE: u32 = 2;
pub(crate) const IMMUTABLE: u32 = 3;

struct Header {
    // Its name lowercased, the name it was first given, and its values combined.
    key: Vec<u8>,
    name: Vec<u8>,
    value: Vec<u8>,
}

#[derive(Default)]
pub(crate) struct HeaderList {
    headers: Vec<Header>,
    set_cookie: Vec<Vec<u8>>,
    guard: u32,
}

const SET_COOKIE: &[u8] = b"set-cookie";

// "Normalize" a header value: its leading and trailing HTTP whitespace (tab, LF, CR, space) gone — None where what is
// left has a NUL, CR or LF in it, which no header value may (a mid-value newline is a smuggling vector).
pub(crate) fn normalized_value(value: &[u8]) -> Option<&[u8]> {
    let ws = |b: &u8| matches!(b, b'\t' | b'\n' | b'\r' | b' ');
    let start = value.iter().position(|b| !ws(b)).unwrap_or(value.len());
    let end = value.iter().rposition(|b| !ws(b)).map_or(start, |e| e + 1);
    let v = &value[start..end];
    (!v.iter().any(|b| matches!(b, 0 | b'\r' | b'\n'))).then_some(v)
}

impl HeaderList {
    fn find(&self, key: &[u8]) -> Option<usize> {
        self.headers.iter().position(|h| h.key == key)
    }
    // Whether the guard forbids writing `key` as `value` — `combined`, the value it would have once appended to, for the
    // no-CORS guard, which judges what the header would hold (Fetch "append" step 3).
    fn forbids(&self, key: &[u8], value: &[u8], combined: &[u8]) -> bool {
        match self.guard {
            GUARD_REQUEST => forbidden_request_header(key, value),
            GUARD_REQUEST_NO_CORS => !no_cors_safelisted_request_header(key, combined),
            GUARD_RESPONSE => forbidden_response_header(key),
            _ => false,
        }
    }
    // Headers' append(name, value) (Fetch "append"): the value combined with the name's — a `set-cookie` one a header of
    // its own — where the guard allows; the name it was first given kept.
    pub(crate) fn append(&mut self, name: &[u8], value: &[u8]) -> u32 {
        let Some((key, value)) = checked(name, value) else { return refused(name) };
        if self.guard == GUARD_IMMUTABLE {
            return IMMUTABLE;
        }
        if key == SET_COOKIE {
            if !self.forbids(&key, value, value) {
                self.set_cookie.push(value.to_vec());
            }
            return WRITTEN;
        }
        let at = self.find(&key);
        let combined = match at {
            Some(i) => [&self.headers[i].value[..], b", ", value].concat(),
            None => value.to_vec(),
        };
        if self.forbids(&key, value, &combined) {
            return WRITTEN;
        }
        match at {
            Some(i) => self.headers[i].value = combined,
            None => self.headers.push(Header { key, name: name.to_vec(), value: combined }),
        }
        WRITTEN
    }
    // …set(name, value): the name's values replaced by `value`, where the guard allows, its place and first name kept.
    pub(crate) fn set(&mut self, name: &[u8], value: &[u8]) -> u32 {
        let Some((key, value)) = checked(name, value) else { return refused(name) };
        if self.guard == GUARD_IMMUTABLE {
            return IMMUTABLE;
        }
        if self.forbids(&key, value, value) {
            return WRITTEN;
        }
        if key == SET_COOKIE {
            self.set_cookie = vec![value.to_vec()];
        } else if let Some(i) = self.find(&key) {
            self.headers[i].value = value.to_vec();
        } else {
            self.headers.push(Header { key, name: name.to_vec(), value: value.to_vec() });
        }
        WRITTEN
    }
    // …delete(name), where the guard allows: "validate" (name, ``) — a forbidden request-header or response-header name
    // not — and, under the no-CORS guard, a no-CORS-safelisted request-header name or `range` alone (Fetch §5.2).
    pub(crate) fn delete(&mut self, name: &[u8]) -> u32 {
        if !is_token(name) {
            return BAD_NAME;
        }
        if self.guard == GUARD_IMMUTABLE {
            return IMMUTABLE;
        }
        let key = name.to_ascii_lowercase();
        let refused = match self.guard {
            GUARD_REQUEST => forbidden_request_header(&key, b""),
            GUARD_RESPONSE => forbidden_response_header(&key),
            GUARD_REQUEST_NO_CORS => {
                !matches!(&key[..], b"accept" | b"accept-language" | b"content-language" | b"content-type" | b"range")
            }
            _ => false,
        };
        if refused {
            return WRITTEN;
        }
        if key == SET_COOKIE {
            self.set_cookie.clear();
        } else if let Some(i) = self.find(&key) {
            self.headers.remove(i);
        }
        WRITTEN
    }
    // "Get" a name (lowercased): its values combined, None where it has none.
    pub(crate) fn get(&self, key: &[u8]) -> Option<Vec<u8>> {
        if key == SET_COOKIE {
            return (!self.set_cookie.is_empty()).then(|| self.set_cookie.join(&b", "[..]));
        }
        self.find(key).map(|i| self.headers[i].value.clone())
    }
    // "Sort and combine": the list sorted by name, each `set-cookie` value a pair of its own in the order appended.
    pub(crate) fn sorted(&self) -> Vec<(&[u8], &[u8])> {
        let mut pairs: Vec<(&[u8], &[u8])> = self.headers.iter().map(|h| (&h.key[..], &h.value[..])).collect();
        pairs.extend(self.set_cookie.iter().map(|c| (SET_COOKIE, &c[..])));
        pairs.sort_by(|a, b| a.0.cmp(b.0));
        pairs
    }
    // The list as it goes on the wire: in the order the names were appended, each by the name it was first given, then
    // the `set-cookie` ones.
    fn wire(&self) -> Vec<(&[u8], &[u8])> {
        let mut pairs: Vec<(&[u8], &[u8])> = self.headers.iter().map(|h| (&h.name[..], &h.value[..])).collect();
        pairs.extend(self.set_cookie.iter().map(|c| (SET_COOKIE, &c[..])));
        pairs
    }
    // A copy of `from`'s list into this one — "filled" through this one's guard where `refill` (a non-empty RequestInit
    // empties a Request's headers and fills them again with the copy). Its values are valid already, so they go as they
    // are: normalized again, a combined value's empty last part would go ("x, " → "x,").
    fn copy_from(&mut self, from: &HeaderList, refill: bool) {
        for h in &from.headers {
            if !refill || !self.forbids(&h.key, &h.value, &h.value) {
                self.headers.push(Header { key: h.key.clone(), name: h.name.clone(), value: h.value.clone() });
            }
        }
        for c in &from.set_cookie {
            if !refill || !self.forbids(SET_COOKIE, c, c) {
                self.set_cookie.push(c.clone());
            }
        }
    }
    // Each name this list has that `from` has too given the name `from` first gave it: a Headers made from another, its
    // entries read through its iterator — lowercased — goes on the wire as the source would.
    fn take_names(&mut self, from: &HeaderList) {
        for h in &mut self.headers {
            if let Some(i) = from.find(&h.key) {
                h.name.clone_from(&from.headers[i].name);
            }
        }
    }
    // A response's list from the network's (name, value) pairs: the values VERBATIM — the HTTP stack stripped each field
    // before it combined duplicates with ", ", and normalizing the combined string again would cut one whose last part
    // is empty (two empty fields combine to ", ").
    // `filtered` a basic filtered response's (Fetch §2.2.6): its forbidden response-header names — the cookies — left out.
    fn from_network(&mut self, pairs: &[(Vec<u8>, Vec<u8>)], filtered: bool) {
        for (name, value) in pairs {
            let key = name.to_ascii_lowercase();
            if filtered && forbidden_response_header(&key) {
                continue;
            }
            if key == SET_COOKIE {
                self.set_cookie.push(value.clone());
            } else if let Some(i) = self.find(&key) {
                self.headers[i].value = value.clone();
            } else {
                self.headers.push(Header { key, name: name.clone(), value: value.clone() });
            }
        }
    }
}

// A name and value checked for a write: the name lowercased and the value normalized, None where either is none.
fn checked<'v>(name: &[u8], value: &'v [u8]) -> Option<(Vec<u8>, &'v [u8])> {
    let value = normalized_value(value).filter(|_| is_token(name))?;
    Some((name.to_ascii_lowercase(), value))
}
fn refused(name: &[u8]) -> u32 {
    if is_token(name) {
        BAD_VALUE
    } else {
        BAD_NAME
    }
}

pub(crate) struct HeadersHandle {
    list: RefCell<HeaderList>,
}

unsafe impl GarbageCollected for HeadersHandle {
    fn trace(&self, _visitor: &mut Visitor) {}
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"HeadersHandle"
    }
}

// The constructor a Headers object's list is made with (`__dom.HeadersBase(guard)`): branded, a wrapper of a fresh, empty
// list under `guard`.
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let guard = args.get(0).uint32_value(scope).unwrap_or(GUARD_NONE);
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let handle = HeadersHandle { list: RefCell::new(HeaderList { guard, ..HeaderList::default() }) };
    let heap = scope.get_cpp_heap().expect("HeadersBase is installed only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, HeadersHandle>(scope, obj, &ptr);
    }
}

// The list `value` wraps, or None for anything that is no header list's object (the brand first: `unwrap` reads garbage
// from an object it never wrapped).
fn list<'h>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'h RefCell<HeaderList>> {
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1)?;
    let field = obj.get_internal_field(scope, 0)?;
    let brand = v8::Local::<v8::Value>::try_from(field).ok().and_then(|v| v8::Local::<v8::External>::try_from(v).ok())?;
    if brand.value() as *const u8 != std::ptr::addr_of!(BRAND) {
        return None;
    }
    // SAFETY: a branded object was made by `construct`, which wrapped a HeadersHandle under TAG; the handle lives while
    // its object, the argument, does — through this op.
    let handle = unsafe { v8::Object::unwrap::<TAG, HeadersHandle>(scope, obj)? };
    Some(unsafe { &(*(handle.as_ref() as *const HeadersHandle)).list })
}

// `__dom.HeadersBase`: the constructor of the isolate's template, made once per isolate.
fn base_function<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    scope.get_cpp_heap()?;
    let kept = crate::dom::dom(scope).headers_template.clone();
    let template = match kept {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::FunctionTemplate::new(scope, construct);
            t.set_class_name(v8::String::new(scope, "HeadersBase")?);
            t.instance_template(scope).set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).headers_template = Some(global);
            t
        }
    };
    template.get_function(scope)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    if let (Some(base), Some(name)) = (base_function(scope), v8::String::new(scope, "HeadersBase")) {
        ns.set(scope, name.into(), base.into());
    }
    crate::dom::register(scope, ns, "headersAppend", append_op, context_id);
    crate::dom::register(scope, ns, "headersSet", set_op, context_id);
    crate::dom::register(scope, ns, "headersDelete", delete_op, context_id);
    crate::dom::register(scope, ns, "headersGet", get_op, context_id);
    crate::dom::register(scope, ns, "headersHas", has_op, context_id);
    crate::dom::register(scope, ns, "headersSetCookies", set_cookies_op, context_id);
    crate::dom::register(scope, ns, "headersPairs", pairs_op, context_id);
    crate::dom::register(scope, ns, "headersWire", wire_op, context_id);
    crate::dom::register(scope, ns, "headersGuard", guard_op, context_id);
    crate::dom::register(scope, ns, "headersCopy", copy_op, context_id);
    crate::dom::register(scope, ns, "headersFromNetwork", from_network_op, context_id);
    crate::dom::register(scope, ns, "headerValue", header_value_op, context_id);
    crate::dom::register(scope, ns, "headersForXhr", for_xhr_op, context_id);
}

// A ByteString argument's bytes (a code unit past 0xFF, which no ByteString has, as 0xFF), and bytes as a string again.
fn bytes(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Vec<u8> {
    crate::dom::utf16_arg(scope, value).iter().map(|&u| u8::try_from(u).unwrap_or(0xFF)).collect()
}
fn string<'s>(scope: &mut v8::PinScope<'s, '_>, bytes: &[u8]) -> v8::Local<'s, v8::Value> {
    let units: Vec<u16> = bytes.iter().map(|&b| u16::from(b)).collect();
    crate::dom::utf16_value(scope, &units)
}
fn flat<'s>(scope: &mut v8::PinScope<'s, '_>, pairs: &[(&[u8], &[u8])]) -> v8::Local<'s, v8::Value> {
    let items: Vec<v8::Local<v8::Value>> = pairs.iter().flat_map(|&(n, v)| [n, v]).map(|b| string(scope, b)).collect();
    v8::Array::new_with_elements(scope, &items).into()
}

// __dom.headersAppend(list, name, value) -> what it came to (`WRITTEN`, `BAD_NAME` …): `HeaderList::append`.
fn append_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (name, value) = (bytes(scope, args.get(1)), bytes(scope, args.get(2)));
    let Some(l) = list(scope, args.get(0)) else { return rv.set_uint32(WRITTEN) };
    rv.set_uint32(l.borrow_mut().append(&name, &value));
}
// __dom.headersSet(list, name, value) -> what it came to: `HeaderList::set`.
fn set_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (name, value) = (bytes(scope, args.get(1)), bytes(scope, args.get(2)));
    let Some(l) = list(scope, args.get(0)) else { return rv.set_uint32(WRITTEN) };
    rv.set_uint32(l.borrow_mut().set(&name, &value));
}
// __dom.headersDelete(list, name) -> what it came to: `HeaderList::delete`.
fn delete_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = bytes(scope, args.get(1));
    let Some(l) = list(scope, args.get(0)) else { return rv.set_uint32(WRITTEN) };
    rv.set_uint32(l.borrow_mut().delete(&name));
}
// __dom.headersGet(list, name) -> the name's values combined, null for none, undefined for a name that is no header
// name.
fn get_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = bytes(scope, args.get(1));
    if !is_token(&name) {
        return;
    }
    let Some(l) = list(scope, args.get(0)) else { return rv.set_null() };
    let got = l.borrow().get(&name.to_ascii_lowercase());
    match got {
        Some(v) => rv.set(string(scope, &v)),
        None => rv.set_null(),
    }
}
// __dom.headersHas(list, name) -> whether it has the name, undefined for a name that is no header name.
fn has_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = bytes(scope, args.get(1));
    if !is_token(&name) {
        return;
    }
    let Some(l) = list(scope, args.get(0)) else { return rv.set_bool(false) };
    rv.set_bool(l.borrow().get(&name.to_ascii_lowercase()).is_some());
}
// __dom.headersSetCookies(list) -> its `set-cookie` values, each its own (getSetCookie()).
fn set_cookies_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(l) = list(scope, args.get(0)) else { return };
    let cookies = l.borrow().set_cookie.clone();
    let items: Vec<v8::Local<v8::Value>> = cookies.iter().map(|c| string(scope, c)).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.headersPairs(list) -> [name, value, name, value …], sorted and combined.
fn pairs_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(l) = list(scope, args.get(0)) else { return };
    let l = l.borrow();
    let out = flat(scope, &l.sorted());
    rv.set(out);
}
// __dom.headersWire(list) -> [name, value …] as they go on the wire.
fn wire_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(l) = list(scope, args.get(0)) else { return };
    let l = l.borrow();
    let out = flat(scope, &l.wire());
    rv.set(out);
}
// __dom.headersGuard(list[, guard]) -> its guard — set to `guard` first where one is given.
fn guard_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let guard = (!args.get(1).is_undefined()).then(|| args.get(1).uint32_value(scope)).flatten();
    let Some(l) = list(scope, args.get(0)) else { return };
    let mut l = l.borrow_mut();
    if let Some(g) = guard {
        l.guard = g;
    }
    rv.set_uint32(l.guard);
}
// __dom.headersCopy(from, to, how): `HeaderList::copy_from` — refilled where `how` is COPY_REFILL — or, where it is
// COPY_NAMES, `HeaderList::take_names`.
const COPY_REFILL: u32 = 1;
const COPY_NAMES: u32 = 2;
fn copy_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let how = args.get(2).uint32_value(scope).unwrap_or(0);
    let (Some(from), Some(to)) = (list(scope, args.get(0)), list(scope, args.get(1))) else { return };
    if std::ptr::eq(from, to) {
        return;
    }
    if how == COPY_NAMES {
        to.borrow_mut().take_names(&from.borrow());
    } else {
        to.borrow_mut().copy_from(&from.borrow(), how == COPY_REFILL);
    }
}
// __dom.headersFromNetwork(list, [name, value …], filtered): `HeaderList::from_network`.
fn from_network_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(arr) = v8::Local::<v8::Array>::try_from(args.get(1)) else { return };
    let mut pairs = Vec::new();
    for i in (0..arr.length().saturating_sub(1)).step_by(2) {
        let (Some(n), Some(v)) = (arr.get_index(scope, i), arr.get_index(scope, i + 1)) else { continue };
        pairs.push((bytes(scope, n), bytes(scope, v)));
    }
    let Some(l) = list(scope, args.get(0)) else { return };
    l.borrow_mut().from_network(&pairs, args.get(2).boolean_value(scope));
}
// __dom.headersForXhr(list) -> XMLHttpRequest's getAllResponseHeaders() (XHR §3.6.5): the list sorted and combined, then
// by the names byte-uppercased — what browsers compare, which ranks `_` and `~` after the letters — each
// "name: value\r\n".
fn for_xhr_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(l) = list(scope, args.get(0)) else { return };
    let l = l.borrow();
    let mut pairs = l.sorted();
    pairs.sort_by_key(|&(n, _)| n.to_ascii_uppercase());
    let text: Vec<u8> = pairs.iter().flat_map(|&(n, v)| [n, b": ", v, b"\r\n"].concat()).collect();
    rv.set(string(scope, &text));
}
// __dom.headerValue(value) -> the value normalized, null for one that is none (`normalized_value`): what
// XMLHttpRequest's setRequestHeader() takes.
fn header_value_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let value = bytes(scope, args.get(0));
    match normalized_value(&value) {
        Some(v) => rv.set(string(scope, v)),
        None => rv.set_null(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(l: &HeaderList) -> Vec<(String, String)> {
        l.sorted().iter().map(|(n, v)| (String::from_utf8_lossy(n).into(), String::from_utf8_lossy(v).into())).collect()
    }

    #[test]
    fn combines_a_name_and_keeps_set_cookies_apart() {
        let mut l = HeaderList::default();
        assert_eq!(l.append(b"X-B", b" 1 "), WRITTEN);
        assert_eq!(l.append(b"x-b", b"2"), WRITTEN);
        assert_eq!(l.append(b"Set-Cookie", b"a=1"), WRITTEN);
        assert_eq!(l.append(b"set-cookie", b"b=2"), WRITTEN);
        assert_eq!(l.append(b"a", b""), WRITTEN);
        assert_eq!(pairs(&l), [("a", ""), ("set-cookie", "a=1"), ("set-cookie", "b=2"), ("x-b", "1, 2")].map(|(n, v)| (n.into(), v.into())));
        assert_eq!(l.wire()[0].0, b"X-B");
        assert_eq!(l.append(b"bad name", b"x"), BAD_NAME);
        assert_eq!(l.append(b"x", b"a\nb"), BAD_VALUE);
    }

    #[test]
    fn guards_what_a_script_may_write() {
        let mut l = HeaderList { guard: GUARD_REQUEST, ..HeaderList::default() };
        l.append(b"Cookie", b"x");
        l.append(b"X-HTTP-Method-Override", b"TRACE");
        assert!(l.sorted().is_empty());
        let mut l = HeaderList { guard: GUARD_REQUEST_NO_CORS, ..HeaderList::default() };
        l.append(b"accept", &[b'a'; 100]);
        l.append(b"accept", &[b'b'; 100]);
        assert_eq!(l.get(b"accept").map(|v| v.len()), Some(100));
        let mut l = HeaderList { guard: GUARD_IMMUTABLE, ..HeaderList::default() };
        assert_eq!(l.set(b"a", b"b"), IMMUTABLE);
    }
}
