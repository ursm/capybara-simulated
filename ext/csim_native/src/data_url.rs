// Fetch's "data: URL processor" (§4.2): a `data:` URL's MIME type and body — percent-decoded, or forgiving-base64
// decoded where its type ends in `;base64` — or none, where it has no comma or its base64 is no base64. The `data-url`
// crate's (Servo's), which works from the URL's string as the processor does from the parsed URL. One answer for the
// page (fetch, XHR, a frame's or a media element's source — data-url.js) and the host (a worker's script, a source map),
// which each had its own.

// The MIME type, serialized, and the body's bytes.
pub(crate) fn process(input: &str) -> Option<(String, Vec<u8>)> {
    let url = data_url::DataUrl::process(input).ok()?;
    let (body, _fragment) = url.decode_to_vec().ok()?;
    Some((url.mime_type().to_string(), body))
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "dataUrl", data_url_op, context_id);
}
// __dom.dataUrl(url) -> [mime type, body as a byte string (each byte a code unit)], or null for a failure.
fn data_url_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let input = args.get(0).to_rust_string_lossy(scope);
    let Some((mime, body)) = process(&input) else { return rv.set_null() };
    let mime = v8::String::new(scope, &mime).map_or_else(|| v8::undefined(scope).into(), Into::into);
    let body = v8::String::new_from_one_byte(scope, &body, v8::NewStringType::Normal).map_or_else(|| v8::undefined(scope).into(), Into::into);
    rv.set(v8::Array::new_with_elements(scope, &[mime, body]).into());
}

// Capybara::Simulated::Native.data_url(url) -> [mime type, body bytes], or nil for a failure.
pub(crate) fn process_for_ruby(ruby: &magnus::Ruby, input: String) -> Option<(String, magnus::RString)> {
    process(&input).map(|(mime, body)| (mime, ruby.str_from_slice(&body)))
}

#[cfg(test)]
mod tests {
    use super::process;

    #[test]
    fn data_urls_decode_as_fetch_says() {
        assert_eq!(process("data:,a+b%20c"), Some(("text/plain;charset=US-ASCII".into(), b"a+b c".to_vec())));
        assert_eq!(process("data:text/HTML;base64,PGI+#frag"), Some(("text/html".into(), b"<b>".to_vec())));
        assert_eq!(process("data:;charset=utf-8,%E2%82%AC").map(|p| p.0), Some("text/plain;charset=utf-8".into()));
        assert_eq!(process("data:text/plain;base64,%%%"), None);
        assert_eq!(process("data:text/plain"), None);
    }
}
