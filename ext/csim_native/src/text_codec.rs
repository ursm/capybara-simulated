// The Encoding Standard's encodings, decoded and encoded by encoding_rs — Firefox's, and the standard's own reference
// implementation — for `TextDecoder` / `TextEncoder`, a form submitted in its document's legacy encoding, and the labels
// a `<meta charset>` or a Content-Type names. Every encoding the standard has: the single-byte tables, UTF-16, and the
// multibyte CJK decoders and their state machines.

use encoding_rs::{CoderResult, Decoder, DecoderResult, Encoding};

use crate::dom::{realm_id, register};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "encodingName", encoding_name, context_id);
    register(scope, ns, "textDecode", text_decode, context_id);
    register(scope, ns, "decodeBytes", decode_bytes, context_id);
    register(scope, ns, "textDecoderOpen", text_decoder_open, context_id);
    register(scope, ns, "textDecoderPush", text_decoder_push, context_id);
    register(scope, ns, "textDecoderClose", text_decoder_close, context_id);
    register(scope, ns, "utf8Encode", utf8_encode, context_id);
    register(scope, ns, "utf8EncodeInto", utf8_encode_into, context_id);
    register(scope, ns, "utf8EncodeChunk", utf8_encode_chunk, context_id);
    register(scope, ns, "legacyEncode", legacy_encode, context_id);
    register(scope, ns, "formRequest", form_request_op, context_id);
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

// __dom.decodeBytes(bytes, label[, type]) -> the Encoding Standard's "decode" of `bytes` with the fallback encoding
// `label`'s — else, where it is null or no encoding's, that of `type`'s `charset` parameter (a MIME type: a Blob's, a
// `data:` URL's), else UTF-8: a BOM's encoding over it, the BOM removed — a response's text (XHR), a FileReader's
// `readAsText` (File API §6.4.3 "package data").
fn decode_bytes(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(bytes) = bytes_arg(scope, args.get(0)) else { return };
    let label = args.get(1);
    let given = if label.is_null_or_undefined() { None } else { encoding_arg(scope, label) };
    let fallback = given.or_else(|| {
        let ty = args.get(2);
        let ty = (!ty.is_null_or_undefined()).then(|| ty.to_rust_string_lossy(scope))?;
        let mime = crate::mime::parse(&ty)?;
        let charset = mime.parameters.iter().find(|(n, _)| n == "charset")?;
        encoding_rs::Encoding::for_label(charset.1.as_bytes())
    });
    let (text, _, _) = fallback.unwrap_or(encoding_rs::UTF_8).decode(&bytes);
    let units: Vec<u16> = text.encode_utf16().collect();
    let text = utf16_string(scope, &units);
    rv.set(text);
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

// __dom.utf8EncodeChunk(chunk, leadingSurrogate, last) -> [bytes, leadingSurrogate]: a TextEncoderStream's "encode and
// enqueue a chunk" (Encoding §5.4.3), its leading surrogate (0 for none) the one an earlier chunk ended with — a lead
// this one ends with held as the next's, so a pair split across two encodes as its one code point; one no trail
// follows, or a trail no lead goes before, U+FFFD — and, `last` (its "encode and flush"), one still held U+FFFD too.
fn utf8_encode_chunk(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let chunk = match args.get(0).to_string(scope) {
        Some(s) => {
            let mut units = vec![0u16; s.length()];
            s.write_v2(scope, 0, &mut units, v8::WriteFlags::empty());
            units
        }
        None => Vec::new(),
    };
    let leading = args.get(1).uint32_value(scope).unwrap_or(0) as u16;
    let last = args.get(2).is_true();
    let (bytes, leading) = encode_chunk(leading, &chunk, last);
    let bytes = crate::dom::u8_array(scope, bytes);
    let leading = v8::Integer::new_from_unsigned(scope, u32::from(leading));
    rv.set(v8::Array::new_with_elements(scope, &[bytes.into(), leading.into()]).into());
}
fn encode_chunk(mut leading: u16, chunk: &[u16], last: bool) -> (Vec<u8>, u16) {
    let mut out = Vec::with_capacity(chunk.len());
    let mut push = |c: char| out.extend_from_slice(c.encode_utf8(&mut [0u8; 4]).as_bytes());
    for &unit in chunk {
        if leading != 0 {
            let lead = std::mem::take(&mut leading);
            if (0xDC00..=0xDFFF).contains(&unit) {
                let c = 0x10000 + ((u32::from(lead) - 0xD800) << 10) + (u32::from(unit) - 0xDC00);
                push(char::from_u32(c).expect("a surrogate pair is a scalar value"));
                continue;
            }
            push(char::REPLACEMENT_CHARACTER);
        }
        match unit {
            0xD800..=0xDBFF => leading = unit,
            0xDC00..=0xDFFF => push(char::REPLACEMENT_CHARACTER),
            _ => push(char::from_u32(u32::from(unit)).expect("a non-surrogate unit is a scalar value")),
        }
    }
    if last && std::mem::take(&mut leading) != 0 {
        push(char::REPLACEMENT_CHARACTER);
    }
    (out, leading)
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

// HTML's "encode the entry list" of `entries` (each name and value — a file entry's its filename) for a form submitted
// as `enctype`: `text/plain` (each entry `name=value` and a CRLF) or, for any other, application/x-www-form-urlencoded
// (the URL Standard's serializer, a space `+`) — each name and value's newlines CRLF first, in `encoding`'s bytes (a
// character a legacy one cannot encode `&#N;`; none for UTF-8) — and the Content-Type it is sent under.
pub(crate) fn encode_entries(enctype: &str, encoding: Option<&'static Encoding>, entries: &[(String, String)]) -> (Vec<u8>, &'static str) {
    let crlf = |s: &str| -> String {
        let mut out = String::with_capacity(s.len());
        let mut chars = s.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '\r' => {
                    chars.next_if_eq(&'\n');
                    out.push_str("\r\n");
                }
                '\n' => out.push_str("\r\n"),
                c => out.push(c),
            }
        }
        out
    };
    let encoding = encoding.filter(|e| *e != encoding_rs::UTF_8);
    if enctype.eq_ignore_ascii_case("text/plain") {
        let text: String = entries.iter().map(|(name, value)| format!("{}={}\r\n", crlf(name), crlf(value))).collect();
        return (form_bytes(encoding, &text), "text/plain");
    }
    let bytes = encoder(move |s| std::borrow::Cow::Owned(form_bytes(encoding, s)));
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.encoding_override(Some(&bytes));
    for (name, value) in entries {
        serializer.append_pair(&crlf(name), &crlf(value));
    }
    (serializer.finish().into_bytes(), "application/x-www-form-urlencoded")
}
// An entry of an entry list: a text value, or a file's filename, type and bytes — read where its body carries them.
pub(crate) enum Entry {
    Text(String),
    File { filename: String, kind: String, bytes: FileBytes },
}
// …a file entry's bytes: its own, or ones asked for only where they are sent — a file on disk, or the page side's.
pub(crate) enum FileBytes {
    Own(Vec<u8>),
    Path(String),
    Ask(usize),
}

// A form's submission (HTML "submit" steps 14, 20-25) — none where its action is no URL: its method — POST where
// `method` says so (ASCII case-insensitively), else GET — the URL it navigates to, and for a POST its body and the exact Content-Type it is sent under. A GET's URL
// is `action` with its query the entry list urlencoded ("mutate action URL", a file entry its filename), a POST's body
// the entry list encoded by `enctype` (`application/x-www-form-urlencoded` where it names none): multipart/form-data
// under a boundary of its own (multipart.rs `encode`, a file part its bytes), else as `encode_entries` does — each in
// `encoding`, a file's bytes asked of `read` only there (an error, its own, ends the submission).
pub(crate) struct FormRequest {
    pub(crate) post: bool,
    pub(crate) url: String,
    pub(crate) body: Option<(Vec<u8>, String)>,
}
pub(crate) fn form_request<E>(
    action: &str,
    method: &str,
    enctype: &str,
    encoding: Option<&'static Encoding>,
    entries: &[(String, Entry)],
    read: &mut dyn FnMut(&FileBytes) -> Result<Vec<u8>, E>,
) -> Result<Option<FormRequest>, E> {
    if url::Url::parse(action).is_err() {
        return Ok(None);
    }
    let encoding = encoding.filter(|e| *e != encoding_rs::UTF_8);
    let named = || -> Vec<(String, String)> {
        entries
            .iter()
            .map(|(name, value)| match value {
                Entry::Text(text) => (name.clone(), text.clone()),
                Entry::File { filename, .. } => (name.clone(), filename.clone()),
            })
            .collect()
    };
    if !method.eq_ignore_ascii_case("post") {
        let (query, _) = encode_entries("application/x-www-form-urlencoded", encoding, &named());
        return Ok(Some(FormRequest { post: false, url: crate::url_ops::mutated_action_url(action, &String::from_utf8_lossy(&query)), body: None }));
    }
    let body = if enctype.to_ascii_lowercase().starts_with("multipart/form-data") {
        let boundary = format!("----csimFormBoundary{}", crate::webcrypto::random_hex(16));
        let mut asked: Vec<Option<Vec<u8>>> = Vec::with_capacity(entries.len());
        for (_, value) in entries {
            asked.push(match value {
                Entry::File { bytes: bytes @ (FileBytes::Path(_) | FileBytes::Ask(_)), .. } => Some(read(bytes)?),
                _ => None,
            });
        }
        let parts: Vec<(String, crate::multipart::Value<'_>)> = entries
            .iter()
            .zip(&asked)
            .map(|((name, value), asked)| {
                let value = match value {
                    Entry::Text(text) => crate::multipart::Value::Text(text.clone()),
                    Entry::File { filename, kind, bytes } => {
                        let bytes = match bytes {
                            FileBytes::Own(own) => own.as_slice(),
                            FileBytes::Path(_) | FileBytes::Ask(_) => asked.as_deref().unwrap_or_default(),
                        };
                        crate::multipart::Value::File { name: filename.clone(), kind, bytes }
                    }
                };
                (name.clone(), value)
            })
            .collect();
        (crate::multipart::encode(&parts, encoding, &boundary), format!("multipart/form-data; boundary={boundary}"))
    } else {
        let (body, content_type) = encode_entries(enctype, encoding, &named());
        (body, content_type.to_owned())
    };
    Ok(Some(FormRequest { post: true, url: action.to_owned(), body: Some(body) }))
}

// Capybara::Simulated::Native.form_request(action, method, enctype, encoding, entries) -> [method, url, body, contentType]
// of a form the host submits (`form_request`), or nil where it submits nothing: `entries` each `[name, value]` or, a
// file's, `[name, filename, type, path, bytes]` — its bytes read from `path` where it has one (a file gone since it was
// picked an IOError: Chrome's upload fails too) — the body and its type nil for a GET.
pub(crate) fn form_request_for_ruby(
    ruby: &magnus::Ruby,
    action: String,
    method: String,
    enctype: String,
    encoding: String,
    entries: magnus::RArray,
) -> Result<Option<(String, String, Option<magnus::RString>, Option<String>)>, magnus::Error> {
    use magnus::TryConvert;
    let mut list: Vec<(String, Entry)> = Vec::new();
    for entry in entries.into_iter() {
        let entry = magnus::RArray::try_convert(entry)?;
        let name = String::try_convert(entry.entry(0)?)?;
        let value = if entry.len() >= 5 {
            let path: Option<String> = entry.entry(3)?;
            let bytes = match path {
                Some(path) => FileBytes::Path(path),
                None => {
                    let own: Option<magnus::RString> = entry.entry(4)?;
                    // SAFETY: the bytes are copied out before anything can run Ruby code.
                    FileBytes::Own(own.map_or_else(Vec::new, |s| unsafe { s.as_slice() }.to_vec()))
                }
            };
            Entry::File { filename: String::try_convert(entry.entry(1)?)?, kind: String::try_convert(entry.entry(2)?)?, bytes }
        } else {
            Entry::Text(String::try_convert(entry.entry(1)?)?)
        };
        list.push((name, value));
    }
    let mut read = |bytes: &FileBytes| match bytes {
        FileBytes::Path(path) => std::fs::read(path).map_err(|e| magnus::Error::new(ruby.exception_io_error(), format!("{path}: {e}"))),
        _ => Ok(Vec::new()),
    };
    let Some(request) = form_request(&action, &method, &enctype, Encoding::for_label(encoding.as_bytes()), &list, &mut read)? else { return Ok(None) };
    let (body, content_type) = match request.body {
        Some((body, content_type)) => (Some(ruby.str_from_slice(&body)), Some(content_type)),
        None => (None, None),
    };
    Ok(Some((if request.post { "POST" } else { "GET" }.to_owned(), request.url, body, content_type)))
}

// __dom.formRequest(action, method, enctype, encoding, list, bytesOf) -> `[method, url, body, contentType]` of a form
// submitted (`form_request`), or null where it submits nothing: `list` flat `[name, value, …]`, a file entry's value
// `[filename, type]`, its bytes asked of `bytesOf(k)` (`k` the entry's place) only where the body carries them; the
// body a byte string (a character per byte), it and its type null for a GET.
fn form_request_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let [action, method, enctype] = [0, 1, 2].map(|k| args.get(k).to_rust_string_lossy(scope));
    let encoding = encoding_arg(scope, args.get(3));
    let Ok(flat) = v8::Local::<v8::Array>::try_from(args.get(4)) else { return };
    let mut list: Vec<(String, Entry)> = Vec::new();
    for k in (0..flat.length().saturating_sub(1)).step_by(2) {
        let name = flat.get_index(scope, k).map(|v| v.to_rust_string_lossy(scope)).unwrap_or_default();
        let value = flat.get_index(scope, k + 1);
        let entry = match value.and_then(|v| v8::Local::<v8::Array>::try_from(v).ok()) {
            Some(file) => {
                let text = |scope: &mut v8::PinScope<'_, '_>, i: u32| file.get_index(scope, i).map(|v| v.to_rust_string_lossy(scope)).unwrap_or_default();
                let (filename, kind) = (text(scope, 0), text(scope, 1));
                Entry::File { filename, kind, bytes: FileBytes::Ask(list.len()) }
            }
            None => Entry::Text(value.map(|v| v.to_rust_string_lossy(scope)).unwrap_or_default()),
        };
        list.push((name, entry));
    }
    let bytes_of = v8::Local::<v8::Function>::try_from(args.get(5)).ok();
    let mut read = |bytes: &FileBytes| -> Result<Vec<u8>, ()> {
        let (FileBytes::Ask(k), Some(f)) = (bytes, bytes_of) else { return Ok(Vec::new()) };
        let k = v8::Integer::new_from_unsigned(scope, *k as u32).into();
        let undefined = v8::undefined(scope).into();
        // (…a throw the op's own: nothing is submitted)
        let got = f.call(scope, undefined, &[k]).ok_or(())?;
        Ok(crate::blob_data::bytes_arg(scope, got))
    };
    let Ok(request) = form_request(&action, &method, &enctype, encoding, &list, &mut read) else { return };
    let Some(request) = request else { return rv.set_null() };
    let mut items: Vec<v8::Local<v8::Value>> = vec![
        v8::String::new(scope, if request.post { "POST" } else { "GET" }).unwrap().into(),
        v8::String::new(scope, &request.url).map_or_else(|| v8::null(scope).into(), Into::into),
    ];
    match request.body {
        Some((body, content_type)) => {
            items.push(v8::String::new_from_one_byte(scope, &body, v8::NewStringType::Normal).map_or_else(|| v8::null(scope).into(), Into::into));
            items.push(v8::String::new(scope, &content_type).map_or_else(|| v8::null(scope).into(), Into::into));
        }
        None => {
            let null: v8::Local<v8::Value> = v8::null(scope).into();
            items.extend([null, null]);
        }
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// (…an encoder as the serializer takes one: its bytes borrowing from the text they encode, as they may)
fn encoder<F: for<'a> Fn(&'a str) -> std::borrow::Cow<'a, [u8]>>(f: F) -> F {
    f
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

#[cfg(test)]
mod tests {
    use super::{encode_chunk, encode_entries, form_request, Encoding, Entry, FileBytes};

    #[test]
    fn a_form_request_is_a_get_unless_its_method_is_post() {
        let entries = [
            ("a".to_owned(), Entry::Text("1 2".to_owned())),
            ("f".to_owned(), Entry::File { filename: "x.txt".to_owned(), kind: String::new(), bytes: FileBytes::Own(b"hi".to_vec()) }),
            ("g".to_owned(), Entry::File { filename: "y.txt".to_owned(), kind: "text/plain".to_owned(), bytes: FileBytes::Ask(2) }),
        ];
        // (…a file's bytes asked for only where a multipart body carries them)
        let asked = std::cell::Cell::new(0);
        let request = |action: &str, method: &str, enctype: &str| {
            let mut read = |_: &FileBytes| {
                asked.set(asked.get() + 1);
                Ok::<_, ()>(b"asked".to_vec())
            };
            form_request(action, method, enctype, None, &entries, &mut read).unwrap()
        };
        assert!(request("http://[x", "get", "").is_none());
        let get = request("http://h/p?old#frag", "dialog", "").unwrap();
        assert_eq!((get.post, get.url.as_str(), get.body.is_none()), (false, "http://h/p?a=1+2&f=x.txt&g=y.txt#frag", true));
        let post = request("http://h/p", "POST", "").unwrap();
        assert_eq!(post.body, Some((b"a=1+2&f=x.txt&g=y.txt".to_vec(), "application/x-www-form-urlencoded".to_owned())));
        assert_eq!(asked.get(), 0);
        let multipart = request("http://h/p", "post", "Multipart/Form-Data").unwrap().body.unwrap();
        let text = String::from_utf8(multipart.0).unwrap();
        assert!(multipart.1.starts_with("multipart/form-data; boundary=----csimFormBoundary"));
        assert!(text.contains("name=\"f\"; filename=\"x.txt\"\r\nContent-Type: application/octet-stream\r\n\r\nhi\r\n"));
        assert!(text.contains("name=\"g\"; filename=\"y.txt\"\r\nContent-Type: text/plain\r\n\r\nasked\r\n"));
        assert_eq!(asked.get(), 1);
    }

    #[test]
    fn an_entry_list_encodes_by_its_enctype() {
        let entries = [("a b".to_owned(), "x~*\r\ny".to_owned()), ("名".to_owned(), "😀".to_owned())];
        assert_eq!(encode_entries("application/x-www-form-urlencoded", None, &entries).0, b"a+b=x%7E*%0D%0Ay&%E5%90%8D=%F0%9F%98%80".to_vec());
        assert_eq!(encode_entries("TEXT/PLAIN", None, &entries), ("a b=x~*\r\ny\r\n名=😀\r\n".as_bytes().to_vec(), "text/plain"));
        let sjis = Encoding::for_label(b"shift_jis");
        assert_eq!(encode_entries("application/x-www-form-urlencoded", sjis, &entries[1..]).0, b"%96%BC=%26%23128512%3B".to_vec());
    }

    #[test]
    fn a_chunk_keeps_a_lead_it_ends_with_for_the_next() {
        let fffd = "\u{FFFD}".as_bytes();
        // (…a pair split across two chunks one code point)
        assert_eq!(encode_chunk(0, &[0x61, 0xD83D], false), (b"a".to_vec(), 0xD83D));
        assert_eq!(encode_chunk(0xD83D, &[0xDE00], false), ("\u{1F600}".as_bytes().to_vec(), 0));
        // (…a held lead no trail follows U+FFFD, the unit after it still itself)
        assert_eq!(encode_chunk(0xD83D, &[0x62], false), ([fffd, b"b"].concat(), 0));
        assert_eq!(encode_chunk(0xD83D, &[0xD83D], false), (fffd.to_vec(), 0xD83D));
        // (…a lone trail U+FFFD; a lead held as the stream closes U+FFFD)
        assert_eq!(encode_chunk(0, &[0xDC00], false), (fffd.to_vec(), 0));
        assert_eq!(encode_chunk(0xD800, &[], true), (fffd.to_vec(), 0));
        assert_eq!(encode_chunk(0, &[0xD800], true), (fffd.to_vec(), 0));
    }
}
