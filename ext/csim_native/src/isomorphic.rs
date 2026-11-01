// Infra's "isomorphic decode" and "isomorphic encode": a byte sequence as the string of the code points its bytes are
// (a header value as script reads it, a cookie-string as the jar keeps it), and back — a code point past U+00FF, which
// no byte is, `?`.

pub(crate) fn decode(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| char::from(b)).collect()
}

pub(crate) fn encode(text: &str) -> Vec<u8> {
    text.chars().map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?')).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_byte_is_the_code_point_it_is_and_back() {
        assert_eq!(super::decode(&[0x63, 0xC3, 0xA9]), "c\u{C3}\u{A9}");
        assert_eq!(super::encode("c\u{C3}\u{A9}"), vec![0x63, 0xC3, 0xA9]);
        assert_eq!(super::encode("\u{3042}"), b"?".to_vec());
    }
}
