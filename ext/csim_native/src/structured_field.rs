// Structured field values (RFC 9651) as a response header carries them: an Item, its bare item's text — the value its
// header names — with what parameters follow it parsed and set aside. Not a List or a Dictionary: no header read here
// is one. A header of more than one field combines them with ", " first, which no Item has — two fields are none.

// The bare item a structured header item is (RFC 9651 "get a structured field value", item), as written — none for a
// header that is no item, parameters that do not parse among it: Chrome and Firefox alike take `same-origin;` and a
// repeated header for none (WPT header-parsing-failures, header-parsing-repeated).
pub(crate) fn item(header: &str) -> Option<&str> {
    let item = header.trim_matches(' ');
    let after = bare_item(item)?;
    let value = &item[..item.len() - after.len()];
    let mut rest = after;
    while !rest.is_empty() {
        rest = rest.strip_prefix(';')?.trim_start_matches(' ');
        rest = parameter(rest)?;
    }
    Some(value)
}
// …one whose bare item is a token (a cross-origin opener or embedder policy's).
pub(crate) fn token(header: &str) -> Option<&str> {
    item(header).filter(|value| value.starts_with(|c: char| c.is_ascii_alphabetic() || c == '*'))
}
// …one whose bare item is the Boolean true, `?1`.
pub(crate) fn is_true(header: &str) -> bool {
    item(header) == Some("?1")
}

// …one parameter off `input`, what is left of it: a key, and a bare item where it has `=`.
fn parameter(input: &str) -> Option<&str> {
    let first = input.chars().next()?;
    if !first.is_ascii_lowercase() && first != '*' {
        return None;
    }
    let end = input.find(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || "_-.*".contains(c))).unwrap_or(input.len());
    match input[end..].strip_prefix('=') {
        Some(value) => bare_item(value),
        None => Some(&input[end..]),
    }
}

// …a bare item off `input`, what is left of it: a string, a byte sequence, a boolean, a number, a date, a display string or
// a token (RFC 9651 §4.2.3.1).
fn bare_item(input: &str) -> Option<&str> {
    let first = input.chars().next()?;
    match first {
        '"' => string(&input[1..]),
        ':' => byte_sequence(&input[1..]),
        '?' => input[1..].strip_prefix(['0', '1']),
        '-' | '0'..='9' => number(input, true),
        '@' => number(&input[1..], false),
        '%' => display_string(input[1..].strip_prefix('"')?),
        c if c.is_ascii_alphabetic() || c == '*' => {
            let end = input.find(|c: char| !(c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~:/".contains(c))).unwrap_or(input.len());
            Some(&input[end..])
        }
        _ => None,
    }
}

// A string's body, after its opening quote.
fn string(input: &str) -> Option<&str> {
    let mut chars = input.char_indices();
    while let Some((at, c)) = chars.next() {
        match c {
            '"' => return Some(&input[at + 1..]),
            '\\' => {
                chars.next().filter(|(_, c)| matches!(c, '"' | '\\'))?;
            }
            ' '..='~' => {}
            _ => return None,
        }
    }
    None
}

// A byte sequence's body, after its opening colon: base64, padded only at its end, of no more than two, and a length no base64
// can't have. Unpadded is fine: RFC 9651, "parsers SHOULD NOT fail when "=" padding is not present".
fn byte_sequence(input: &str) -> Option<&str> {
    let end = input.find(':')?;
    let body = &input[..end];
    let data = body.trim_end_matches('=');
    let valid = data.len() % 4 != 1 && body.len() - data.len() <= 2 && data.chars().all(|c| c.is_ascii_alphanumeric() || "+/".contains(c));
    valid.then(|| &input[end + 1..])
}

// An integer of at most 15 digits, or, where `decimal` allows, a decimal of at most 12 before its point and 1 to 3 after.
fn number(input: &str, decimal: bool) -> Option<&str> {
    let body = input.strip_prefix('-').unwrap_or(input);
    let digits = |s: &str| s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    let whole = digits(body);
    if whole == 0 {
        return None;
    }
    match body[whole..].strip_prefix('.') {
        Some(rest) if decimal => {
            let fraction = digits(rest);
            (whole <= 12 && (1..=3).contains(&fraction)).then(|| &rest[fraction..])
        }
        Some(_) => None,
        None => (whole <= 15).then(|| &body[whole..]),
    }
}

// A display string's body, after its opening `%"`: printable ASCII, a `%` and two lowercase hex digits for a byte of UTF-8.
fn display_string(input: &str) -> Option<&str> {
    let mut bytes = Vec::new();
    let mut chars = input.char_indices();
    while let Some((at, c)) = chars.next() {
        match c {
            '"' => return std::str::from_utf8(&bytes).is_ok().then(|| &input[at + 1..]),
            '%' => {
                let hex = |c: char| c.to_digit(16).filter(|_| !c.is_ascii_uppercase());
                let high = hex(chars.next()?.1)?;
                let low = hex(chars.next()?.1)?;
                bytes.push((high * 16 + low) as u8);
            }
            ' '..='~' => bytes.push(c as u8),
            _ => return None,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_item_is_its_bare_item_with_its_parameters_parsed() {
        assert_eq!(item(" ?1 "), Some("?1"));
        assert_eq!(item("?1;a=1;b"), Some("?1"));
        assert_eq!(item("\"a,b\";x"), Some("\"a,b\""));
        assert!(is_true("?1") && is_true("?1;x=\"a,b\""));
        for bad in ["?1;", "?1;X=1", "?1, ?1", "?0", "?10", "?1 ;a", "1", "", "?1;a=", "\t?1"] {
            assert!(!is_true(bad), "{bad:?}");
        }
        assert_eq!(token("same-origin; report-to=\"x\""), Some("same-origin"));
        assert_eq!(token("?1"), None);
    }
}
