// The numeric IDL attributes that reflect a content attribute (HTML §2.6.1, "reflecting content attributes in IDL
// attributes"), read off the element as the engine holds it: a `long`'s, an `unsigned long`'s and a `double`'s getter
// steps, by the kind its [Reflect…] extended attributes make it — and a `<meter>`'s and a `<progress>`'s numbers, which
// their content attributes make the same way — and a form control's `autocomplete`, the autofill detail tokens its
// attribute holds. The setters stay the bindings' (reflect.js): writing an attribute runs a page's reactions.

use crate::dom::{nid_arg, realm, realm_id, register};
use crate::validity::{parse_html_integer, parse_non_negative};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "reflectNumber", reflect_number, context_id);
    register(scope, ns, "meterValue", meter_value, context_id);
    register(scope, ns, "progressValue", progress_value, context_id);
    register(scope, ns, "autofill", autofill_op, context_id);
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
fn parse_float_value(s: &str) -> Option<f64> {
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

// A `<meter>`'s values (HTML §4.10.14), by `which` — its actual value, minimum, maximum, low, high and optimum points:
// each its content attribute parsed as a floating-point number, or its default, the minimum 0 and the maximum 1 (but
// never below the minimum); the others clamped into the range — the high boundary above the low — the low defaulting to
// the minimum, the high to the maximum, the optimum to the midpoint and the actual value to 0.
fn meter_values(attr: impl Fn(&str) -> Option<f64>) -> [f64; 6] {
    let min = attr("min").unwrap_or(0.0);
    let max = attr("max").unwrap_or(1.0).max(min);
    let clamp = |v: f64, lo: f64| v.max(lo).min(max);
    let value = clamp(attr("value").unwrap_or(0.0), min);
    let low = clamp(attr("low").unwrap_or(min), min);
    let high = clamp(attr("high").unwrap_or(max), low);
    let optimum = clamp(attr("optimum").unwrap_or((min + max) / 2.0), min);
    [value, min, max, low, high, optimum]
}

// A `<progress>`'s values (HTML §4.10.13), by `which` — its current value, maximum value and position: the maximum its
// `max` content attribute where that parses to a number above zero, else 1; the current value its `value` one where
// that parses to a number not below zero, at most the maximum, else 0; the position −1 for an indeterminate progress
// bar (no `value` attribute), else the current value over the maximum.
fn progress_values(attr: impl Fn(&str) -> Option<f64>, determinate: bool) -> [f64; 3] {
    let max = attr("max").filter(|&v| v > 0.0).unwrap_or(1.0);
    let value = attr("value").filter(|&v| v >= 0.0).map_or(0.0, |v| v.min(max));
    [value, max, if determinate { value / max } else { -1.0 }]
}

// __dom.meterValue(nid, which) / __dom.progressValue(nid, which) -> one of those values.
fn meter_value(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let which = args.get(1).uint32_value(scope).unwrap_or(0) as usize;
    let realm = realm(scope, cid);
    let Some(n) = realm.get(id) else { return };
    let values = meter_values(|name| n.plain_attr(name).and_then(parse_float_value));
    rv.set_double(values.get(which).copied().unwrap_or(f64::NAN));
}
fn progress_value(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let which = args.get(1).uint32_value(scope).unwrap_or(0) as usize;
    let realm = realm(scope, cid);
    let Some(n) = realm.get(id) else { return };
    let values = progress_values(|name| n.plain_attr(name).and_then(parse_float_value), n.plain_attr("value").is_some());
    rv.set_double(values.get(which).copied().unwrap_or(f64::NAN));
}

// HTML §4.10.18.7.1 autofill: the field names, the ones a contact token (home, work, …) may precede, and those tokens.
const AUTOFILL_FIELD_NAMES: [&str; 55] = [
    "name", "honorific-prefix", "given-name", "additional-name", "family-name", "honorific-suffix", "nickname", "username",
    "new-password", "current-password", "one-time-code", "organization-title", "organization", "street-address",
    "address-line1", "address-line2", "address-line3", "address-level4", "address-level3", "address-level2",
    "address-level1", "country", "country-name", "postal-code", "cc-name", "cc-given-name", "cc-additional-name",
    "cc-family-name", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-type", "transaction-currency",
    "transaction-amount", "language", "bday", "bday-day", "bday-month", "bday-year", "sex", "url", "photo", "tel",
    "tel-country-code", "tel-national", "tel-area-code", "tel-local", "tel-local-prefix", "tel-local-suffix",
    "tel-extension", "email", "impp", "webauthn",
];
const AUTOFILL_CONTACT_FIELDS: [&str; 10] =
    ["tel", "tel-country-code", "tel-national", "tel-area-code", "tel-local", "tel-local-prefix", "tel-local-suffix", "tel-extension", "email", "impp"];
const AUTOFILL_CONTACT: [&str; 5] = ["home", "work", "mobile", "fax", "pager"];

// The `autocomplete` IDL attribute's getter (§4.10.18.7.1, "the autofill processing model"): the attribute's tokens,
// ASCII-lowercased, read from the end — an optional `webauthn`, a field name, a contact token where the field takes
// one, `shipping` / `billing`, a `section-*` — and serialized canonically; a lone `on` / `off` as it is, but for a
// control wearing the autofill ANCHOR mantle (a hidden input), whose is empty; anything else, or a token left over,
// empty.
pub(crate) fn autofill(value: &str, anchor_mantle: bool) -> String {
    let tokens: Vec<String> = value.split(|c| matches!(c, '\t' | '\n' | '\x0C' | '\r' | ' ')).filter(|t| !t.is_empty()).map(|t| t.to_ascii_lowercase()).collect();
    if let [only] = &tokens[..] {
        if only == "on" || only == "off" {
            return if anchor_mantle { String::new() } else { only.clone() };
        }
    }
    let mut rest = &tokens[..];
    let mut take = |accept: &dyn Fn(&str) -> bool| -> Option<String> {
        let (last, before) = rest.split_last()?;
        accept(last).then(|| {
            rest = before;
            last.clone()
        })
    };
    let credential = if tokens.len() > 1 { take(&|t| t == "webauthn") } else { None };
    let Some(field) = take(&|t| AUTOFILL_FIELD_NAMES.contains(&t)) else { return String::new() };
    let contact = take(&|t| AUTOFILL_CONTACT.contains(&t) && AUTOFILL_CONTACT_FIELDS.contains(&field.as_str()));
    let mode = take(&|t| t == "shipping" || t == "billing");
    let section = take(&|t| t.starts_with("section-"));
    if !rest.is_empty() {
        return String::new();
    }
    [section, mode, contact, Some(field), credential].into_iter().flatten().collect::<Vec<_>>().join(" ")
}

// __dom.autofill(nid) -> the control's `autocomplete` (`autofill`), a hidden input wearing the anchor mantle.
fn autofill_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let Some(n) = arena.get(id) else { return };
    let anchor = n.is_html_named("input") && n.input_type() == "hidden";
    let value = autofill(n.plain_attr("autocomplete").unwrap_or(""), anchor);
    if let Some(s) = v8::String::new(scope, &value) {
        rv.set(s.into());
    }
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

    fn attrs<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<f64> + 'a {
        move |name| pairs.iter().find(|(n, _)| *n == name).and_then(|(_, v)| parse_float_value(v))
    }

    #[test]
    fn meter() {
        assert_eq!(meter_values(attrs(&[])), [0.0, 0.0, 1.0, 0.0, 1.0, 0.5]);
        assert_eq!(meter_values(attrs(&[("min", "5"), ("max", "2"), ("value", "9")])), [5.0, 5.0, 5.0, 5.0, 5.0, 5.0]);
        assert_eq!(meter_values(attrs(&[("max", "10"), ("low", "6"), ("high", "3"), ("optimum", "x")])), [0.0, 0.0, 10.0, 6.0, 6.0, 5.0]);
    }

    #[test]
    fn progress() {
        assert_eq!(progress_values(attrs(&[]), false), [0.0, 1.0, -1.0]);
        assert_eq!(progress_values(attrs(&[("value", "3"), ("max", "4")]), true), [3.0, 4.0, 0.75]);
        assert_eq!(progress_values(attrs(&[("value", "-1"), ("max", "0")]), true), [0.0, 1.0, 0.0]);
        assert_eq!(progress_values(attrs(&[("value", "9")]), true), [1.0, 1.0, 1.0]);
    }

    #[test]
    fn autofill_tokens() {
        assert_eq!(autofill(" Section-A  Shipping HOME tel webauthn", false), "section-a shipping home tel webauthn");
        assert_eq!(autofill("on", false), "on");
        assert_eq!(autofill("off", true), "");
        assert_eq!(autofill("home name", false), "");
        assert_eq!(autofill("billing email", false), "billing email");
        assert_eq!(autofill("webauthn", false), "webauthn");
        assert_eq!(autofill("x email", false), "");
        assert_eq!(autofill("", false), "");
    }
}
