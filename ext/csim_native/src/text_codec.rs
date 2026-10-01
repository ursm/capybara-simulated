// The Encoding Standard's encodings, decoded and encoded by encoding_rs — Firefox's, and the standard's own reference
// implementation — for `TextDecoder` / `TextEncoder`, a form submitted in its document's legacy encoding, and the labels
// a `<meta charset>` or a Content-Type names. Every encoding the standard has: the single-byte tables, UTF-16, and the
// multibyte CJK decoders and their state machines.

use encoding_rs::{CoderResult, Decoder, DecoderResult, Encoding};

use crate::dom::register;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "encodingName", encoding_name, context_id);
    register(scope, ns, "textDecode", text_decode, context_id);
    register(scope, ns, "textDecoderOpen", text_decoder_open, context_id);
    register(scope, ns, "textDecoderPush", text_decoder_push, context_id);
    register(scope, ns, "textDecoderClose", text_decoder_close, context_id);
    register(scope, ns, "utf8Encode", utf8_encode, context_id);
    register(scope, ns, "utf8EncodeInto", utf8_encode_into, context_id);
    register(scope, ns, "legacyEncode", legacy_encode, context_id);
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

// The bytes of a BufferSource argument (a copy: the page may change the buffer after the call).
fn bytes_arg(value: v8::Local<'_, v8::Value>) -> Vec<u8> {
    if let Ok(view) = v8::Local::<v8::ArrayBufferView>::try_from(value) {
        let mut out = vec![0u8; view.byte_length()];
        view.copy_contents(&mut out);
        return out;
    }
    let (data, len) = if let Ok(buffer) = v8::Local::<v8::ArrayBuffer>::try_from(value) {
        (buffer.data(), buffer.byte_length())
    } else if let Ok(buffer) = v8::Local::<v8::SharedArrayBuffer>::try_from(value) {
        // (…a SharedArrayBuffer too — the WPT harness makes one of a WebAssembly.Memory)
        (buffer.get_backing_store().data(), buffer.byte_length())
    } else {
        (None, 0)
    };
    let mut out = vec![0u8; len];
    if let Some(data) = data {
        // SAFETY: `data` points at the buffer's `len` bytes, which nothing frees while this callback runs.
        out.copy_from_slice(unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, len) });
    }
    out
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
    let bytes = bytes_arg(args.get(1));
    let mut decoder = new_decoder(encoding, args.get(2).boolean_value(scope));
    match decode_with(&mut decoder, &bytes, true, args.get(3).boolean_value(scope)) {
        Some(units) => {
            let text = utf16_string(scope, &units);
            rv.set(text);
        }
        None => rv.set_null(),
    }
}

// The decoders a streaming `TextDecoder` keeps between its calls, by id (the page side closes one when its stream ends,
// or when the decoder is collected).
#[derive(Default)]
struct Decoders {
    next: u32,
    live: std::collections::HashMap<u32, Decoder>,
}

fn decoders<'s>(scope: &'s mut v8::PinScope<'_, '_>) -> &'s mut Decoders {
    if scope.get_slot::<Decoders>().is_none() {
        scope.set_slot(Decoders::default());
    }
    scope.get_slot_mut::<Decoders>().expect("Decoders slot was just set")
}

// __dom.textDecoderOpen(encoding, ignoreBOM) -> a streaming decoder's id.
fn text_decoder_open(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(encoding) = encoding_arg(scope, args.get(0)) else { return rv.set_int32(0) };
    let decoder = new_decoder(encoding, args.get(1).boolean_value(scope));
    let all = decoders(scope);
    all.next += 1;
    let id = all.next;
    all.live.insert(id, decoder);
    rv.set_uint32(id);
}

// __dom.textDecoderPush(id, bytes, last, fatal) -> the text, or null where `fatal` met an error (the decoder is then
// spent, as it is after `last`).
fn text_decoder_push(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let bytes = bytes_arg(args.get(1));
    let last = args.get(2).boolean_value(scope);
    let fatal = args.get(3).boolean_value(scope);
    let Some(decoder) = decoders(scope).live.get_mut(&id) else { return rv.set_null() };
    let units = decode_with(decoder, &bytes, last, fatal);
    if last || units.is_none() {
        decoders(scope).live.remove(&id);
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
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    decoders(scope).live.remove(&id);
}

// A string argument as UTF-8, a lone surrogate U+FFFD (the Encoding Standard's UTF-8 encoder).
fn utf8(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> String {
    value.to_rust_string_lossy(scope)
}

fn uint8_array<'s>(scope: &mut v8::PinScope<'s, '_>, bytes: Vec<u8>) -> v8::Local<'s, v8::Value> {
    let len = bytes.len();
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
    let buffer = v8::ArrayBuffer::with_backing_store(scope, &store);
    v8::Uint8Array::new(scope, buffer, 0, len).map_or_else(|| v8::undefined(scope).into(), Into::into)
}

// __dom.utf8Encode(string) -> a Uint8Array of its UTF-8 (`TextEncoder.encode`).
fn utf8_encode(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = utf8(scope, args.get(0));
    let array = uint8_array(scope, text.into_bytes());
    rv.set(array);
}

// __dom.utf8EncodeInto(string, destination) -> [read, written]: `TextEncoder.encodeInto` — as many whole code points as
// fit, `read` counted in UTF-16 code units.
fn utf8_encode_into(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = utf8(scope, args.get(0));
    let Ok(destination) = v8::Local::<v8::Uint8Array>::try_from(args.get(1)) else { return };
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

// __dom.legacyEncode(encoding, string) -> its bytes in `encoding` as a byte string (a character per byte): HTML's
// "encode" for a form submitted in a legacy encoding, a character the encoding cannot encode written `&#N;`.
fn legacy_encode(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(encoding) = encoding_arg(scope, args.get(0)) else { return rv.set_null() };
    let text = utf8(scope, args.get(1));
    let (bytes, _, _) = encoding.encode(&text);
    if let Some(s) = v8::String::new_from_one_byte(scope, &bytes, v8::NewStringType::Normal) {
        rv.set(s.into());
    }
}
