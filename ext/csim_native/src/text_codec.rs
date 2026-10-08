// The Encoding Standard's encodings, decoded and encoded by encoding_rs — Firefox's, and the standard's own reference
// implementation — for `TextDecoder` / `TextEncoder`, a form submitted in its document's legacy encoding, and the labels
// a `<meta charset>` or a Content-Type names. Every encoding the standard has: the single-byte tables, UTF-16, and the
// multibyte CJK decoders and their state machines.

use encoding_rs::{CoderResult, Decoder, DecoderResult, Encoding};

use crate::dom::{realm_id, register};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "encodingName", encoding_name, context_id);
    register(scope, ns, "textDecode", text_decode, context_id);
    register(scope, ns, "textDecoderOpen", text_decoder_open, context_id);
    register(scope, ns, "textDecoderPush", text_decoder_push, context_id);
    register(scope, ns, "textDecoderClose", text_decoder_close, context_id);
    register(scope, ns, "utf8Encode", utf8_encode, context_id);
    register(scope, ns, "utf8EncodeInto", utf8_encode_into, context_id);
    register(scope, ns, "legacyEncode", legacy_encode, context_id);
    register(scope, ns, "isSharedArrayBuffer", is_shared_array_buffer, context_id);
}

// __dom.isSharedArrayBuffer(value) -> whether it is a SharedArrayBuffer, any realm's (Web IDL's IsSharedArrayBuffer):
// the bindings' buffer-source conversions ask (webidl.js), which a realm with no SharedArrayBuffer constructor — every
// one here, none being cross-origin isolated — has no getter of its own to brand-check one with.
fn is_shared_array_buffer(_scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(args.get(0).is_shared_array_buffer());
}

// An encoding by its name (every name is one of its own labels).
fn encoding_arg(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'static Encoding> {
    Encoding::for_label(value.to_rust_string_lossy(scope).as_bytes())
}

// __dom.encodingName(label) -> the encoding's name, or null: the Encoding Standard's "get an encoding" (ASCII whitespace
// around the label trimmed, case-insensitively).
fn encoding_name(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let label = args.get(0).to_rust_string_lossy(scope);
    match Encoding::for_label(label.as_bytes()) {
        Some(e) => {
            if let Some(name) = v8::String::new(scope, e.name()) {
                rv.set(name.into());
            }
        }
        None => rv.set_null(),
    }
}

// A view whose buffer the page may resize — which no BufferSource argument here takes (WebIDL: none is
// `[AllowResizable]`). An on-heap view has no buffer of its own yet, and is never resizable.
fn resizable_view(view: v8::Local<'_, v8::ArrayBufferView>) -> bool {
    view.has_buffer() && view.get_backing_store().is_some_and(|store| store.is_resizable_by_user_javascript())
}

// The bytes of an `[AllowShared] BufferSource` argument (a copy: the page may change the buffer after the call), or
// None — after throwing the TypeError WebIDL's conversion throws — for anything else, a resizable buffer included.
// `undefined` is no bytes (an omitted argument).
fn bytes_arg(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<Vec<u8>> {
    if value.is_undefined() {
        return Some(Vec::new());
    }
    let (data, len) = if let Ok(view) = v8::Local::<v8::ArrayBufferView>::try_from(value) {
        if !resizable_view(view) {
            let mut out = vec![0u8; view.byte_length()];
            view.copy_contents(&mut out);
            return Some(out);
        }
        (None, None)
    } else if let Ok(buffer) = v8::Local::<v8::ArrayBuffer>::try_from(value) {
        let store = buffer.get_backing_store();
        (store.data(), (!store.is_resizable_by_user_javascript()).then(|| buffer.byte_length()))
    } else if let Ok(buffer) = v8::Local::<v8::SharedArrayBuffer>::try_from(value) {
        // (…a SharedArrayBuffer too — the WPT harness makes one of a WebAssembly.Memory)
        let store = buffer.get_backing_store();
        (store.data(), (!store.is_resizable_by_user_javascript()).then(|| buffer.byte_length()))
    } else {
        (None, None)
    };
    let Some(len) = len else {
        throw_type_error(scope, "The provided value is not an ArrayBuffer or ArrayBufferView, or is a resizable one.");
        return None;
    };
    let mut out = vec![0u8; len];
    if let Some(data) = data {
        // SAFETY: `data` points at the buffer's `len` bytes, which nothing frees while this callback runs.
        out.copy_from_slice(unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, len) });
    }
    Some(out)
}

fn throw_type_error(scope: &mut v8::PinScope<'_, '_>, message: &str) {
    if let Some(message) = v8::String::new(scope, message) {
        let error = v8::Exception::type_error(scope, message);
        scope.throw_exception(error);
    }
}

fn utf16_string<'s>(scope: &mut v8::PinScope<'s, '_>, units: &[u16]) -> v8::Local<'s, v8::Value> {
    v8::String::new_from_two_byte(scope, units, v8::NewStringType::Normal).map_or_else(|| v8::undefined(scope).into(), Into::into)
}

// Decode `bytes` with `decoder` into UTF-16: replacing what is malformed with U+FFFD, or — `fatal` — giving up (None)
// at the first error. `last`: the input ends here, and a partial sequence held over is malformed.
fn decode_with(decoder: &mut Decoder, bytes: &[u8], last: bool, fatal: bool) -> Option<Vec<u16>> {
    let mut out = vec![0u16; decoder.max_utf16_buffer_length(bytes.len()).unwrap_or(bytes.len() * 2 + 16)];
    if fatal {
        let (result, _, written) = decoder.decode_to_utf16_without_replacement(bytes, &mut out, last);
        match result {
            DecoderResult::InputEmpty => {
                out.truncate(written);
                Some(out)
            }
            DecoderResult::Malformed(_, _) | DecoderResult::OutputFull => None,
        }
    } else {
        let (result, _, written, _) = decoder.decode_to_utf16(bytes, &mut out, last);
        debug_assert!(matches!(result, CoderResult::InputEmpty));
        out.truncate(written);
        Some(out)
    }
}

fn new_decoder(encoding: &'static Encoding, ignore_bom: bool) -> Decoder {
    // (…a BOM is the encoding's own and is removed, unless `ignoreBOM`; it never switches the encoding, as BOM sniffing
    // would)
    if ignore_bom { encoding.new_decoder_without_bom_handling() } else { encoding.new_decoder_with_bom_removal() }
}

// __dom.textDecode(encoding, bytes, ignoreBOM, fatal) -> the text, or null where `fatal` met an error: `TextDecoder`'s
// decode of a whole input.
fn text_decode(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(encoding) = encoding_arg(scope, args.get(0)) else { return rv.set_null() };
    let Some(bytes) = bytes_arg(scope, args.get(1)) else { return };
    let mut decoder = new_decoder(encoding, args.get(2).boolean_value(scope));
    match decode_with(&mut decoder, &bytes, true, args.get(3).boolean_value(scope)) {
        Some(units) => {
            let text = utf16_string(scope, &units);
            rv.set(text);
        }
        None => rv.set_null(),
    }
}

// The decoders a streaming `TextDecoder` keeps between its calls, by realm and id (the page side closes one when its
// stream ends, or when the decoder is collected; a frame realm's go with it, `drop_realm`).
#[derive(Default)]
struct Decoders {
    next: u32,
    live: std::collections::HashMap<(i32, u32), Decoder>,
}

fn decoders<'s>(scope: &'s mut v8::PinScope<'_, '_>) -> &'s mut Decoders {
    if scope.get_slot::<Decoders>().is_none() {
        scope.set_slot(Decoders::default());
    }
    scope.get_slot_mut::<Decoders>().expect("Decoders slot was just set")
}

// Every decoder realm `realm` left open (it is being disposed).
pub(crate) fn drop_realm(scope: &mut v8::PinScope<'_, '_>, realm: i32) {
    if let Some(all) = scope.get_slot_mut::<Decoders>() {
        all.live.retain(|&(owner, _), _| owner != realm);
    }
}

// __dom.textDecoderOpen(encoding, ignoreBOM) -> a streaming decoder's id.
fn text_decoder_open(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(encoding) = encoding_arg(scope, args.get(0)) else { return rv.set_int32(0) };
    let decoder = new_decoder(encoding, args.get(1).boolean_value(scope));
    let realm = realm_id(scope, &args);
    let all = decoders(scope);
    all.next += 1;
    let id = all.next;
    all.live.insert((realm, id), decoder);
    rv.set_uint32(id);
}

// __dom.textDecoderPush(id, bytes, last, fatal) -> the text, or null where `fatal` met an error. The decoder is spent
// after `last`; after an error mid-stream it carries on at the next call with the state it had — an ISO-2022-JP mode
// switch holds — and without the rest of this input (WPT textdecoder-mistakes "fatal stream", both halves).
fn text_decoder_push(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = (realm_id(scope, &args), args.get(0).uint32_value(scope).unwrap_or(0));
    let Some(bytes) = bytes_arg(scope, args.get(1)) else { return };
    let last = args.get(2).boolean_value(scope);
    let fatal = args.get(3).boolean_value(scope);
    let Some(decoder) = decoders(scope).live.get_mut(&key) else { return rv.set_null() };
    let units = decode_with(decoder, &bytes, last, fatal);
    if last {
        decoders(scope).live.remove(&key);
    }
    match units {
        Some(units) => {
            let text = utf16_string(scope, &units);
            rv.set(text);
        }
        None => rv.set_null(),
    }
}

// __dom.textDecoderClose(id): a streaming decoder the page side is done with.
fn text_decoder_close(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let key = (realm_id(scope, &args), args.get(0).uint32_value(scope).unwrap_or(0));
    decoders(scope).live.remove(&key);
}

// A string argument as UTF-8, a lone surrogate U+FFFD (the Encoding Standard's UTF-8 encoder).
fn utf8(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> String {
    value.to_rust_string_lossy(scope)
}

// __dom.utf8Encode(string) -> a Uint8Array of its UTF-8 (`TextEncoder.encode`).
fn utf8_encode(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = utf8(scope, args.get(0));
    let array = crate::dom::u8_array(scope, text.into_bytes());
    rv.set(array);
}

// __dom.utf8EncodeInto(string, destination) -> [read, written]: `TextEncoder.encodeInto` — as many whole code points as
// fit, `read` counted in UTF-16 code units.
fn utf8_encode_into(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = utf8(scope, args.get(0));
    // (…a Uint8Array of any realm, and on a shared buffer — `[AllowShared] Uint8Array` — but not a resizable one)
    let destination = match v8::Local::<v8::Uint8Array>::try_from(args.get(1)) {
        Ok(destination) if !resizable_view(destination.into()) => destination,
        _ => return throw_type_error(scope, "The provided value is not a Uint8Array, or is a resizable one."),
    };
    let capacity = destination.byte_length();
    let mut read = 0u32;
    let mut out = Vec::with_capacity(capacity.min(text.len()));
    for c in text.chars() {
        if out.len() + c.len_utf8() > capacity {
            break;
        }
        let mut buf = [0u8; 4];
        out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
        read += c.len_utf16() as u32;
    }
    let data = destination.data() as *mut u8;
    if !data.is_null() {
        // SAFETY: `data` is the view's first byte, `capacity` of them are its own, and `out` is no longer.
        unsafe { std::ptr::copy_nonoverlapping(out.as_ptr(), data, out.len()) };
    }
    let items: [v8::Local<v8::Value>; 2] = [v8::Integer::new_from_unsigned(scope, read).into(), v8::Integer::new_from_unsigned(scope, out.len() as u32).into()];
    let pair = v8::Array::new_with_elements(scope, &items);
    rv.set(pair.into());
}

// HTML's "encode" for a form submitted in a legacy encoding: `text`'s bytes in `encoding`, a character the encoding
// cannot encode written `&#N;` (an unknown encoding is UTF-8).
fn form_bytes(encoding: Option<&'static Encoding>, text: &str) -> Vec<u8> {
    encoding.map_or_else(|| text.as_bytes().to_vec(), |encoding| encoding.encode(text).0.into_owned())
}

// Capybara::Simulated::Native.form_encode(encoding, text) -> the bytes (BINARY): a form the host submits.
pub(crate) fn form_encode(ruby: &magnus::Ruby, encoding: String, text: String) -> magnus::RString {
    ruby.str_from_slice(&form_bytes(Encoding::for_label(encoding.as_bytes()), &text))
}

// __dom.legacyEncode(encoding, string) -> the bytes as a byte string (a character per byte): a form submitted from
// the page side.
fn legacy_encode(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(encoding) = encoding_arg(scope, args.get(0)) else { return rv.set_null() };
    let text = utf8(scope, args.get(1));
    let bytes = form_bytes(Some(encoding), &text);
    if let Some(s) = v8::String::new_from_one_byte(scope, &bytes, v8::NewStringType::Normal) {
        rv.set(s.into());
    }
}
