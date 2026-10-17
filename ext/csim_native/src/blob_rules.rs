// File API's fixed rules for a Blob and its URL: a blob's `type` normalized (§3.1, the constructor's step 3), the range
// `slice()` takes (§3.3.3), and whether a realm may revoke a blob URL — one of its own origin's (§8.3.2, the URL
// partitioned by origin: FileAPI url/cross-global-revoke). The bytes and the URL store are elsewhere (blob.js,
// blob_urls.rs).

// A blob's type: `t` ASCII-lowercased — none where a code unit of it is outside U+0020..U+007E.
pub(crate) fn blob_type(t: &[u16]) -> String {
    if t.iter().all(|&u| (0x20..=0x7E).contains(&u)) {
        t.iter().map(|&u| (u as u8).to_ascii_lowercase() as char).collect()
    } else {
        String::new()
    }
}

// The bytes `slice(start, end)` of a blob of `size` takes, as (from, span): each index relative — a negative one from
// the end — and clamped to the blob, none past an end before the start.
pub(crate) fn slice_range(size: f64, start: Option<f64>, end: Option<f64>) -> (f64, f64) {
    let clamp = |i: f64| if i < 0.0 { (size + i).max(0.0) } else { i.min(size) };
    let from = start.map_or(0.0, clamp);
    let to = end.map_or(size, clamp);
    (from, (to - from).max(0.0))
}

// Whether a realm of origin `here` may revoke `url`: where either names an opaque origin — or none, a URL that does not
// parse, a realm that answers none — and else where the two are the same.
pub(crate) fn revocable(url: &str, here: &str) -> bool {
    let theirs = ada_url::Url::parse(url, None).ok().map(|u| u.origin().to_owned()).unwrap_or_default();
    let opaque = |o: &str| o.is_empty() || o == "null";
    opaque(&theirs) || opaque(here) || theirs == here
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "blobType", blob_type_op, context_id);
    crate::dom::register(scope, ns, "blobSliceRange", slice_range_op, context_id);
    crate::dom::register(scope, ns, "blobUrlRevocable", revocable_op, context_id);
}

// __dom.blobType(type) -> `blob_type` ('' for undefined).
fn blob_type_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let t = if args.get(0).is_undefined() { Vec::new() } else { crate::dom::utf16_arg(scope, args.get(0)) };
    let t = v8::String::new(scope, &blob_type(&t)).map_or_else(|| v8::undefined(scope).into(), Into::into);
    rv.set(t);
}
// __dom.blobSliceRange(size, start, end) -> [from, span] (`slice_range`; undefined indexes none).
fn slice_range_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let size = args.get(0).number_value(scope).unwrap_or(0.0);
    let index = |scope: &mut v8::PinScope<'_, '_>, v: v8::Local<'_, v8::Value>| (!v.is_undefined()).then(|| v.number_value(scope).unwrap_or(0.0));
    let (start, end) = (index(scope, args.get(1)), index(scope, args.get(2)));
    let (from, span) = slice_range(size, start, end);
    rv.set(crate::dom::f64_array(scope, &[from, span]).into());
}
// __dom.blobUrlRevocable(url) -> whether the calling realm may revoke `url` (`revocable`), by its document's origin.
fn revocable_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let url = args.get(0).to_rust_string_lossy(scope);
    let cid = crate::dom::realm_id(scope, &args);
    let here = crate::dom::realm(scope, cid).location.origin().to_owned();
    rv.set_bool(revocable(&url, &here));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_type_lowercases_printable_ascii_and_a_slice_clamps_its_relative_indexes() {
        let u = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
        assert_eq!(blob_type(&u("Text/HTML; Charset=UTF-8")), "text/html; charset=utf-8");
        assert_eq!(blob_type(&u("text/plain\u{0}")), "");
        assert_eq!(blob_type(&u("é")), "");
        assert_eq!(slice_range(10.0, None, None), (0.0, 10.0));
        assert_eq!(slice_range(10.0, Some(-3.0), None), (7.0, 3.0));
        assert_eq!(slice_range(10.0, Some(8.0), Some(2.0)), (8.0, 0.0));
        assert_eq!(slice_range(10.0, Some(-20.0), Some(20.0)), (0.0, 10.0));
        assert!(revocable("blob:http://a.test/x", "http://a.test"));
        assert!(!revocable("blob:http://a.test/x", "http://b.test"));
        assert!(revocable("blob:null/x", "http://b.test"));
        assert!(revocable("blob:http://a.test/x", "null"));
    }
}
