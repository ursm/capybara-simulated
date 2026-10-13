// Fetch's "data: URL processor" (§4.2): a `data:` URL's MIME type and body — percent-decoded, or forgiving-base64
// decoded where its type ends in `;base64` — or none, where it has no comma or its base64 is no base64. The `data-url`
// crate's (Servo's), which works from the URL's string as the processor does from the parsed URL. One answer for the
// page (fetch, XHR, a frame's or a media element's source — data-url.js) and the host (a worker's script, a source map),
// which each had its own. And its forgiving-base64 decoder is `atob`'s, beside the encoder `btoa`'s.

// The MIME type, serialized, and the body's bytes.
pub(crate) fn process(input: &str) -> Option<(String, Vec<u8>)> {
    let url = data_url::DataUrl::process(input).ok()?;
    let (body, _fragment) = url.decode_to_vec().ok()?;
    Some((url.mime_type().to_string(), body))
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "dataUrl", data_url_op, context_id);
    crate::dom::register(scope, ns, "base64Encode", base64_encode_op, context_id);
    crate::dom::register(scope, ns, "base64Decode", base64_decode_op, context_id);
}
// __dom.dataUrl(url) -> [mime type, body as a byte string (each byte a code unit)], or null for a failure.
fn data_url_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let input = args.get(0).to_rust_string_lossy(scope);
    let Some((mime, body)) = process(&input) else { return rv.set_null() };
    let mime = v8::String::new(scope, &mime).map_or_else(|| v8::undefined(scope).into(), Into::into);
    let body = v8::String::new_from_one_byte(scope, &body, v8::NewStringType::Normal).map_or_else(|| v8::undefined(scope).into(), Into::into);
    rv.set(v8::Array::new_with_elements(scope, &[mime, body]).into());
}

// Base64 (RFC 4648 §4, padded) of `bytes`.
pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for k in 0..4 {
            out.push(if k <= chunk.len() { char::from(ALPHABET[(n >> (18 - 6 * k)) as usize & 63]) } else { '=' });
        }
    }
    out
}
// __dom.base64Encode(data) -> `btoa`'s answer: `data`'s code units, each a byte, base64-encoded — null where one is above
// 0xFF (an InvalidCharacterError).
fn base64_encode_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let units = crate::dom::utf16_arg(scope, args.get(0));
    let Some(bytes) = units.iter().map(|&u| u8::try_from(u).ok()).collect::<Option<Vec<u8>>>() else { return rv.set_null() };
    let out = base64_encode(&bytes);
    rv.set(v8::String::new_from_one_byte(scope, out.as_bytes(), v8::NewStringType::Normal).map_or_else(|| v8::null(scope).into(), Into::into));
}
// __dom.base64Decode(data) -> `atob`'s answer: Infra's forgiving-base64 decode of `data`, its bytes a byte string — null
// for a failure (an InvalidCharacterError).
fn base64_decode_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let input = args.get(0).to_rust_string_lossy(scope);
    let Ok(bytes) = data_url::forgiving_base64::decode_to_vec(input.as_bytes()) else { return rv.set_null() };
    rv.set(v8::String::new_from_one_byte(scope, &bytes, v8::NewStringType::Normal).map_or_else(|| v8::null(scope).into(), Into::into));
}

// Capybara::Simulated::Native.data_url(url) -> [mime type, body bytes], or nil for a failure.
// (…the URL's bytes, in whatever encoding the string says, read as UTF-8 — a byte that is none replaced)
pub(crate) fn process_for_ruby(ruby: &magnus::Ruby, input: magnus::RString) -> Option<(String, magnus::RString)> {
    // SAFETY: copied at once, before anything could run Ruby code that moves or frees it.
    let input = String::from_utf8_lossy(unsafe { input.as_slice() }).into_owned();
    process(&input).map(|(mime, body)| (mime, ruby.str_from_slice(&body)))
}

#[cfg(test)]
mod tests {
    use super::{base64_encode, process};

    #[test]
    fn data_urls_decode_as_fetch_says() {
        assert_eq!(process("data:,a+b%20c"), Some(("text/plain;charset=US-ASCII".into(), b"a+b c".to_vec())));
        assert_eq!(process("data:text/HTML;base64,PGI+#frag"), Some(("text/html".into(), b"<b>".to_vec())));
        assert_eq!(process("data:;charset=utf-8,%E2%82%AC").map(|p| p.0), Some("text/plain;charset=utf-8".into()));
        assert_eq!(process("data:text/plain;base64,%%%"), None);
        assert_eq!([base64_encode(b""), base64_encode(b"a"), base64_encode(b"ab"), base64_encode(b"abc")], ["", "YQ==", "YWI=", "YWJj"]);
        assert_eq!(process("data:text/plain"), None);
    }
}
