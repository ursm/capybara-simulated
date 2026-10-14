// Subresource Integrity (SRI §3.3): whether a response's bytes match an `integrity` metadata string. The metadata is
// parsed — ASCII-whitespace-separated `alg-digest` tokens, each one's `?options` dropped, an algorithm the user agent
// does not know (sha256, sha384 and sha512 are what it does) passed over — and only its STRONGEST algorithm's entries
// count: the bytes match where their digest is any of those (padding ignored, base64url taken as base64, as browsers
// take them). Metadata with no entry it knows is no check at all.

use crate::webcrypto::Hash;

// The algorithms SRI knows, weakest first.
const ALGORITHMS: [(&str, Hash); 3] = [("sha256", Hash::Sha256), ("sha384", Hash::Sha384), ("sha512", Hash::Sha512)];

// "Do bytes match metadataList?"
pub(crate) fn bytes_match(bytes: &[u8], metadata: &str) -> bool {
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
    crate::dom::register(scope, ns, "integrityMatches", matches_op, context_id);
}
// __dom.integrityMatches(bytes, metadata) -> `bytes_match`: `bytes` a Uint8Array.
fn matches_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let metadata = args.get(1).to_rust_string_lossy(scope);
    let bytes = v8::Local::<v8::ArrayBufferView>::try_from(args.get(0)).map_or_else(|_| Vec::new(), |view| {
        let mut bytes = vec![0u8; view.byte_length()];
        view.copy_contents(&mut bytes);
        bytes
    });
    rv.set_bool(bytes_match(&bytes, &metadata));
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
}
