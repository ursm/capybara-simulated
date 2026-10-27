// Subresource Integrity (SRI §3.3): whether a response's bytes match an `integrity` metadata string. The metadata is
// parsed — ASCII-whitespace-separated `alg-digest` tokens, each one's `?options` dropped, an algorithm the user agent
// does not know (sha256, sha384 and sha512 are what it does) passed over — and only its STRONGEST algorithm's entries
// count: the bytes match where their digest is any of those (padding ignored, base64url taken as base64, as browsers
// take them). Metadata with no entry it knows is no check at all.

use crate::webcrypto::Hash;

// The algorithms SRI knows, weakest first.
const ALGORITHMS: [(&str, Hash); 3] = [("sha256", Hash::Sha256), ("sha384", Hash::Sha384), ("sha512", Hash::Sha512)];

// Fetch "main fetch": whether a response a request of integrity metadata `metadata` gets is refused — a network error —
// by it: where it has any, a response whose body is null (an opaque filtered response's: "if response's body is null,
// then run processBodyError", which SRI's matching never reaches — Chrome and Firefox refuse a no-cors fetch's opaque
// response whatever the metadata), or one whose bytes do not match it.
pub(crate) fn integrity_refuses(bytes: &[u8], metadata: &str, opaque: bool) -> bool {
    !metadata.is_empty() && (opaque || !bytes_match(bytes, metadata))
}
// SRI §3.3.5 "do bytes match metadataList?": metadata with no entry it knows matches whatever the bytes; otherwise the
// bytes are matched.
fn bytes_match(bytes: &[u8], metadata: &str) -> bool {
    let entries: Vec<(usize, &str)> = metadata
        .split(|c: char| c.is_ascii_whitespace())
        .filter_map(|token| {
            let expression = token.split('?').next()?;
            let (alg, digest) = expression.split_once('-')?;
            let strength = ALGORITHMS.iter().position(|(name, _)| name.eq_ignore_ascii_case(alg))?;
            (!digest.is_empty()).then_some((strength, digest))
        })
        .collect();
    let Some(strongest) = entries.iter().map(|&(s, _)| s).max() else { return true };
    let actual = normalized(&crate::data_url::base64_encode(&ALGORITHMS[strongest].1.digest(bytes)));
    entries.iter().any(|&(s, digest)| s == strongest && normalized(digest) == actual)
}
// A digest's base64 with base64url's two letters taken as base64's and its padding gone.
fn normalized(digest: &str) -> String {
    digest.trim_end_matches('=').replace('-', "+").replace('_', "/")
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "integrityRefuses", refuses_op, context_id);
}
// __dom.integrityRefuses(bytes, metadata, opaque) -> `integrity_refuses` of a response of `bytes` — a body's bytes
// object, or a view (blob_data.rs `bytes_arg`) — opaque or not.
fn refuses_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let metadata = args.get(1).to_rust_string_lossy(scope);
    let bytes = crate::blob_data::bytes_arg(scope, args.get(0));
    let opaque = args.get(2).boolean_value(scope);
    rv.set_bool(integrity_refuses(&bytes, &metadata, opaque));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_strongest_algorithm_counts() {
        // sha256("alert('Hello, world.');") and sha384 of it, from the SRI spec's examples.
        let body = b"alert('Hello, world.');";
        let sha256 = "sha256-qznLcsROx4GACP2dm0UCKCzCG+HiZ1guq6ZZDob/Tng=";
        let sha384 = "sha384-H8BRh8j48O9oYatfu5AZzq6A9RINhZO5H16dQZngK7T62em8MUt1FLm52t+eX6xO";
        assert!(bytes_match(body, sha256));
        assert!(bytes_match(body, "SHA256-qznLcsROx4GACP2dm0UCKCzCG-HiZ1guq6ZZDob_Tng?opt"));
        assert!(bytes_match(body, &format!("{sha256} {sha384}")));
        assert!(!bytes_match(body, &format!("{sha256} sha384-AAAA")));
        assert!(bytes_match(body, "md5-AAAA sha1-AAAA"));
        assert!(bytes_match(body, ""));
        assert!(!bytes_match(b"other", sha256));
    }

    #[test]
    fn an_opaque_response_is_refused_by_any_metadata() {
        // (…its body null: Fetch's main fetch refuses it before SRI's matching, metadata of no known algorithm too)
        assert!(integrity_refuses(b"", "sha999-abc", true));
        assert!(!integrity_refuses(b"x", "sha999-abc", false));
        assert!(!integrity_refuses(b"", "", true));
        assert!(integrity_refuses(b"other", "sha256-qznLcsROx4GACP2dm0UCKCzCG+HiZ1guq6ZZDob/Tng=", false));
    }
}
