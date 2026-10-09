// The numeric IDL attributes that reflect a content attribute (HTML §2.6.1, "reflecting content attributes in IDL
// attributes"), read off the element as the engine holds it: a `long`'s, an `unsigned long`'s and a `double`'s getter
// steps, by the kind its [Reflect…] extended attributes make it. The setters stay the bindings' (reflect.js): writing
// an attribute runs a page's reactions.

use crate::dom::{nid_arg, realm, realm_id, register};
use crate::validity::{parse_html_integer, parse_non_negative};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "reflectNumber", reflect_number, context_id);
}

// The kinds, as reflect.js names them.
const LONG: u32 = 0; // `long`
const LONG_NON_NEGATIVE: u32 = 1; // `long`, [ReflectNonNegative]
const UNSIGNED: u32 = 2; // `unsigned long`
const UNSIGNED_POSITIVE: u32 = 3; // `unsigned long`, [ReflectPositive] / [ReflectPositiveWithFallback]
const UNSIGNED_RANGE: u32 = 4; // `unsigned long`, [ReflectRange=(min, max)]
const DOUBLE: u32 = 5; // `double`
const DOUBLE_POSITIVE: u32 = 6; // `double`, [ReflectPositive]

const MAX_LONG: i64 = 2_147_483_647;

// The getter steps: the content attribute's value parsed, or `default` where it is missing or out of the kind's range.
fn reflected(value: Option<&str>, kind: u32, default: f64, min: f64, max: f64) -> f64 {
    let Some(value) = value else { return default };
    match kind {
        LONG => parse_html_integer(value).filter(|v| (-MAX_LONG - 1..=MAX_LONG).contains(v)).map_or(default, |v| v as f64),
        LONG_NON_NEGATIVE | UNSIGNED => parse_non_negative(value).filter(|&v| v <= MAX_LONG as u64).map_or(default, |v| v as f64),
        UNSIGNED_POSITIVE => parse_non_negative(value).filter(|&v| (1..=MAX_LONG as u64).contains(&v)).map_or(default, |v| v as f64),
        UNSIGNED_RANGE => parse_non_negative(value).map_or(default, |v| (v as f64).clamp(min, max)),
        DOUBLE => parse_float_value(value).unwrap_or(default),
        DOUBLE_POSITIVE => parse_float_value(value).filter(|&v| v > 0.0).unwrap_or(default),
        _ => default,
    }
}

// HTML "rules for parsing floating-point number values": past leading ASCII whitespace, a sign, digits with a
// fraction, an exponent — as much of them as there is — or None; a zero is +0, and a value too large for a double none.
pub(crate) fn parse_float_value(s: &str) -> Option<f64> {
    let b = s.trim_start_matches(|c: char| matches!(c, '\t' | '\n' | '\x0C' | '\r' | ' ')).as_bytes();
    let mut i = 0;
    let mut sign = 1.0;
    match b.first() {
        Some(b'-') => {
            sign = -1.0;
            i += 1;
        }
        Some(b'+') => i += 1,
        _ => {}
    }
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        start..*i
    };
    let int = digits(&mut i);
    let mut text = String::from(if int.is_empty() { "0" } else { std::str::from_utf8(&b[int.clone()]).ok()? });
    if int.is_empty() && !(b.get(i) == Some(&b'.') && b.get(i + 1).is_some_and(u8::is_ascii_digit)) {
        return None;
    }
    if b.get(i) == Some(&b'.') {
        i += 1;
        let frac = digits(&mut i);
        if !frac.is_empty() {
            text.push('.');
            text.push_str(std::str::from_utf8(&b[frac]).ok()?);
        }
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        let mut j = i + 1;
        let negative = b.get(j) == Some(&b'-');
        if matches!(b.get(j), Some(b'-' | b'+')) {
            j += 1;
        }
        let exp = digits(&mut j);
        if !exp.is_empty() {
            text.push(if negative { 'e' } else { 'E' });
            if negative {
                text.push('-');
            }
            text.push_str(std::str::from_utf8(&b[exp]).ok()?);
        }
    }
    let v = sign * text.parse::<f64>().ok()?;
    if !v.is_finite() {
        return None;
    }
    Some(if v == 0.0 { 0.0 } else { v })
}

// __dom.reflectNumber(nid, name, kind, default, min, max) -> the numeric IDL attribute that reflects the element's
// `name` content attribute, by `kind`.
fn reflect_number(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let name = args.get(1).to_rust_string_lossy(scope);
    let kind = args.get(2).uint32_value(scope).unwrap_or(LONG);
    let [default, min, max] = [3, 4, 5].map(|i| args.get(i).number_value(scope).unwrap_or(0.0));
    let value = realm(scope, cid).get(id).and_then(|n| n.plain_attr(&name)).map(str::to_owned);
    rv.set_double(reflected(value.as_deref(), kind, default, min, max));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floating_point_values() {
        assert_eq!(parse_float_value("  1.5e2px"), Some(150.0));
        assert_eq!(parse_float_value(".5"), Some(0.5));
        assert_eq!(parse_float_value("-0"), Some(0.0));
        assert_eq!(parse_float_value("1e"), Some(1.0));
        assert_eq!(parse_float_value("."), None);
        assert_eq!(parse_float_value("x"), None);
        assert_eq!(parse_float_value("1e400"), None);
    }

    #[test]
    fn numeric_kinds() {
        assert_eq!(reflected(Some("2147483648"), LONG, 7.0, 0.0, 0.0), 7.0);
        assert_eq!(reflected(Some("-3"), LONG_NON_NEGATIVE, -1.0, 0.0, 0.0), -1.0);
        assert_eq!(reflected(Some("0"), UNSIGNED_POSITIVE, 1.0, 0.0, 0.0), 1.0);
        assert_eq!(reflected(Some("2000"), UNSIGNED_RANGE, 1.0, 1.0, 1000.0), 1000.0);
        assert_eq!(reflected(Some("0"), UNSIGNED_RANGE, 1.0, 1.0, 1000.0), 1.0);
        assert_eq!(reflected(Some("-1"), DOUBLE_POSITIVE, 4.0, 0.0, 0.0), 4.0);
        assert_eq!(reflected(None, LONG, 1.0, 0.0, 0.0), 1.0);
    }
}
