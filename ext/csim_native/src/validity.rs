// HTML constraint validation over the arena: whether a control is a candidate (`willValidate`), which of its
// constraints it suffers from (`validity`), and the pseudo-classes read off those — `:valid`, `:invalid` (a form or a
// fieldset by its controls), `:user-valid`, `:user-invalid`, `:in-range`, `:out-of-range`. dom-nodes.js `validity`
// is the other engine; the two answer the same, CSIM_ARENA_VERIFY holds them together.
//
// `pattern` is an ECMAScript regular expression, compiled with the `v` flag: regress (a JS-syntax engine in Rust)
// evaluates it over the value's UTF-16 code units, as a page's RegExp does, from a cache of compiled patterns.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::dom::{
    NodeData, NodeId, NodeKind, RealmArena, STATE_CUSTOM_ERROR, STATE_DIRTY_BY_USER, STATE_FORM_ASSOCIATED,
    STATE_HAS_FILES, STATE_USER_INTERACTED,
};

// The ValidityState flags.
pub(crate) const VALUE_MISSING: u16 = 1;
pub(crate) const TYPE_MISMATCH: u16 = 1 << 1;
pub(crate) const PATTERN_MISMATCH: u16 = 1 << 2;
pub(crate) const TOO_LONG: u16 = 1 << 3;
pub(crate) const TOO_SHORT: u16 = 1 << 4;
pub(crate) const RANGE_UNDERFLOW: u16 = 1 << 5;
pub(crate) const RANGE_OVERFLOW: u16 = 1 << 6;
pub(crate) const STEP_MISMATCH: u16 = 1 << 7;
pub(crate) const BAD_INPUT: u16 = 1 << 8;
pub(crate) const CUSTOM_ERROR: u16 = 1 << 9;

// The `<input>` types `pattern` applies to.
const PATTERN_TYPES: [&str; 6] = ["text", "search", "url", "tel", "email", "password"];
// The `<input>` types `readonly` applies to (the mutability `required` needs).
const READONLY_TYPES: [&str; 12] = [
    "text", "search", "tel", "url", "email", "password", "number", "date", "month", "week", "time", "datetime-local",
];
// The `<input>` types `minlength` / `maxlength` apply to.
const LENGTH_TYPES: [&str; 6] = ["text", "search", "url", "tel", "email", "password"];

const MS_PER_DAY: f64 = 86_400_000.0;

fn is_ascii_ws(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\x0C' | '\r' | ' ')
}
fn trim_ascii_ws(s: &str) -> &str {
    s.trim_matches(is_ascii_ws)
}

// HTML "rules for parsing non-negative integers", or None.
pub(crate) fn parse_non_negative(s: &str) -> Option<u64> {
    let s = s.trim_start_matches(is_ascii_ws);
    let s = s.strip_prefix('+').unwrap_or(s);
    let digits: &str = &s[..s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len())];
    if digits.is_empty() {
        return None;
    }
    Some(digits.bytes().fold(0u64, |v, d| v.saturating_mul(10).saturating_add(u64::from(d - b'0'))))
}

// HTML "valid floating-point number" (and finite), as its number.
pub(crate) fn parse_float(s: &str) -> Option<f64> {
    crate::element_state::is_valid_floating_point(s).then(|| s.parse::<f64>().ok()).flatten()
}

// The number a temporal `type` gives `s` — ms since the epoch for a date / datetime-local / week, ms since midnight for
// a time, months since 1970-01 for a month — or None when `s` is not a valid one (dom-nodes.js `temporalToNumber`).
fn temporal_number(ty: &str, s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let digits = |from: usize, to: usize| -> Option<i64> {
        let part = s.get(from..to)?;
        (!part.is_empty() && part.bytes().all(|c| c.is_ascii_digit())).then(|| part.parse().ok()).flatten()
    };
    // A year: four or more digits, then `-`.
    let year_end = b.iter().position(|&c| c == b'-')?;
    if year_end < 4 {
        return None;
    }
    let year = digits(0, year_end)?;
    if year < 1 {
        return None;
    }
    let rest = &s[year_end + 1..];
    match ty {
        "month" => {
            let m = (rest.len() == 2).then(|| digits(year_end + 1, s.len())).flatten()?;
            (1..=12).contains(&m).then(|| ((year - 1970) * 12 + (m - 1)) as f64)
        }
        "week" => {
            let w = (rest.len() == 3 && rest.starts_with('W')).then(|| digits(year_end + 2, s.len())).flatten()?;
            if w < 1 || w > iso_weeks_in_year(year) {
                return None;
            }
            let jan4 = days_from_civil(year, 1, 4);
            let dow = (jan4 + 3).rem_euclid(7); // 0 = Monday (1970-01-01 was a Thursday)
            Some((jan4 - dow + (w - 1) * 7) as f64 * MS_PER_DAY)
        }
        "date" => {
            if rest.len() != 5 || rest.as_bytes()[2] != b'-' {
                return None;
            }
            let (m, d) = (digits(year_end + 1, year_end + 3)?, digits(year_end + 4, s.len())?);
            valid_day(year, m, d).then(|| days_from_civil(year, m, d) as f64 * MS_PER_DAY)
        }
        "datetime-local" => {
            if rest.len() < 11 || rest.as_bytes()[2] != b'-' || !matches!(rest.as_bytes()[5], b'T' | b' ') {
                return None;
            }
            let (m, d) = (digits(year_end + 1, year_end + 3)?, digits(year_end + 4, year_end + 6)?);
            let time = time_of_day(&rest[6..])?;
            valid_day(year, m, d).then(|| days_from_civil(year, m, d) as f64 * MS_PER_DAY + time)
        }
        _ => None,
    }
}
// A time of day `HH:MM[:SS[.fff]]` (one to three fraction digits) in ms, or None.
fn time_of_day(s: &str) -> Option<f64> {
    let two = |p: &str| (p.len() == 2 && p.bytes().all(|c| c.is_ascii_digit())).then(|| p.parse::<u32>().ok()).flatten();
    let (hm, sec) = match s.len() {
        5 => (s, None),
        n if n >= 8 && s.as_bytes()[5] == b':' => (&s[..5], Some(&s[6..])),
        _ => return None,
    };
    if hm.as_bytes()[2] != b':' {
        return None;
    }
    let (h, mi) = (two(&hm[..2])?, two(&hm[3..])?);
    let (se, ms) = match sec {
        None => (0, 0),
        Some(sec) => {
            let se = two(sec.get(..2)?)?;
            let ms = match sec.get(2..) {
                Some("") => 0,
                Some(f) if f.starts_with('.') && (2..=4).contains(&f.len()) && f[1..].bytes().all(|c| c.is_ascii_digit()) => {
                    format!("{:0<3}", &f[1..]).parse::<u32>().ok()?
                }
                _ => return None,
            };
            (se, ms)
        }
    };
    (h <= 23 && mi <= 59 && se <= 59).then(|| f64::from(((h * 60 + mi) * 60 + se) * 1000 + ms))
}
fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}
fn valid_day(y: i64, m: i64, d: i64) -> bool {
    let days = [31, if is_leap(y) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    (1..=12).contains(&m) && d >= 1 && d <= days[(m - 1) as usize]
}
fn iso_weeks_in_year(y: i64) -> i64 {
    let jan1 = (days_from_civil(y, 1, 1) + 4).rem_euclid(7); // 0 = Sunday
    if jan1 == 4 || (is_leap(y) && jan1 == 3) { 53 } else { 52 }
}
// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's days_from_civil).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// A step range's scale and default step, and whether `ty` has one.
fn step_scale(ty: &str) -> Option<(f64, f64)> {
    Some(match ty {
        "number" | "range" => (1.0, 1.0),
        "date" => (MS_PER_DAY, 1.0),
        "datetime-local" | "time" => (1000.0, 60.0),
        "month" => (1.0, 1.0),
        "week" => (7.0 * MS_PER_DAY, 1.0),
        _ => return None,
    })
}
fn number_of(ty: &str, s: &str) -> Option<f64> {
    match ty {
        "number" | "range" => parse_float(s),
        "time" => time_of_day(s),
        _ => temporal_number(ty, s),
    }
}

// An exact decimal (coefficient, digits after the point), for a step check a double cannot resolve.
fn exact_decimal(s: &str) -> Option<(i128, i32)> {
    let s = trim_ascii_ws(s);
    let (mantissa, exp) = match s.find(['e', 'E']) {
        Some(i) => (&s[..i], s[i + 1..].parse::<i32>().ok()?),
        None => (s, 0),
    };
    let (neg, mantissa) = match mantissa.strip_prefix('-') {
        Some(m) => (true, m),
        None => (false, mantissa.strip_prefix('+').unwrap_or(mantissa)),
    };
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = format!("{int}{frac}");
    if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) || digits.len() > 36 {
        return None;
    }
    let mut coeff: i128 = digits.parse().ok()?;
    if neg {
        coeff = -coeff;
    }
    let mut scale = frac.len() as i32 - exp;
    if scale < 0 {
        coeff = coeff.checked_mul(10i128.checked_pow((-scale) as u32)?)?;
        scale = 0;
    }
    Some((coeff, scale))
}
fn decimal_step_mismatch(value: &str, step: &str, base: &str) -> Option<bool> {
    let (v, s, b) = (exact_decimal(value)?, exact_decimal(step)?, exact_decimal(base)?);
    if s.0 == 0 {
        return None;
    }
    let scale = v.1.max(s.1).max(b.1);
    let lift = |d: (i128, i32)| d.0.checked_mul(10i128.checked_pow((scale - d.1) as u32)?);
    Some((lift(v)? - lift(b)?) % lift(s)? != 0)
}

// HTML's "valid e-mail address" (dom-nodes.js's `emailRe`): a local part of the permitted characters, `@`, and a
// domain of labels of letters, digits and inner hyphens (63 at most) — one label is enough. The JS side validates the
// value the `value` getter returns, whose domain is IDNA-converted to ASCII (`user@お.com` → `user@xn--t8j.com`);
// the arena has no UTS 46 tables yet, so a label with non-ASCII characters in it stands for its conversion — taken as
// one that converts (the ASCII among it still held to the rule), its length unchecked.
fn valid_email(s: &str) -> bool {
    let Some((local, domain)) = s.split_once('@') else { return false };
    let local_ok = !local.is_empty()
        && local.bytes().all(|c| c.is_ascii_alphanumeric() || b".!#$%&'*+/=?^_`{|}~-".contains(&c));
    let label_ok = |l: &str| {
        let unicode = !l.is_ascii();
        (unicode && !l.is_empty() || (1..=63).contains(&l.len()))
            && l.chars().all(|c| !c.is_ascii() || c.is_ascii_alphanumeric() || c == '-')
            && !l.starts_with('-')
            && !l.ends_with('-')
    };
    local_ok && domain.split('.').all(label_ok)
}

impl NodeData {
    fn is_html_element(&self, name: &str) -> bool {
        self.kind == NodeKind::Element && self.ns.is_empty() && self.local_name == name
    }
}

impl RealmArena {
    // A control's value as its `value` getter reads it before sanitization: the live value once dirty, else the
    // `value` attribute — a `<textarea>`'s child text, newlines normalized.
    fn raw_value(&self, n: &NodeData) -> String {
        if let Some(v) = &n.value {
            return String::from_utf16_lossy(v);
        }
        if n.local_name == "textarea" {
            let text: Vec<u16> = n
                .children
                .iter()
                .filter_map(|&c| self.get(c))
                .filter(|t| t.kind == NodeKind::Text)
                .flat_map(|t| t.data.iter().copied())
                .collect();
            return String::from_utf16_lossy(&text).replace("\r\n", "\n").replace('\r', "\n");
        }
        n.plain_attr("value").unwrap_or("").to_string()
    }
    // An `<input>`'s value, sanitized for its type as the `value` getter returns it (dom-nodes.js
    // `sanitizeInputValue`) — for the types a constraint reads the value of.
    fn sanitized_value(&self, n: &NodeData, ty: &str) -> String {
        let raw = self.raw_value(n);
        let strip = |s: &str| s.chars().filter(|&c| c != '\r' && c != '\n').collect::<String>();
        match ty {
            "text" | "search" | "tel" | "password" => strip(&raw),
            "url" => trim_ascii_ws(&strip(&raw)).to_string(),
            "email" if n.plain_attr("multiple").is_some() => raw.split(',').map(trim_ascii_ws).collect::<Vec<_>>().join(","),
            "email" => trim_ascii_ws(&strip(&raw)).to_string(),
            "number" => if parse_float(&raw).is_some() { raw } else { String::new() },
            "date" | "month" | "week" | "datetime-local" => {
                if temporal_number(ty, &raw).is_some() { raw } else { String::new() }
            }
            "time" => if time_of_day(&raw).is_some() { raw } else { String::new() },
            _ => raw,
        }
    }

    // `willValidate`: a submittable control of a validating kind — an `<input>` but a hidden / reset / button one, a
    // Submit-state `<button>`, a `<select>`, a `<textarea>`, a form-associated custom element — that is not actually
    // disabled, not `readonly` (an input, a textarea, a form-associated custom element), and not in a `<datalist>`.
    pub(crate) fn will_validate(&self, id: NodeId) -> bool {
        let Some(n) = self.get(id).filter(|n| n.kind == NodeKind::Element && n.ns.is_empty()) else { return false };
        let face = n.state & STATE_FORM_ASSOCIATED != 0;
        let candidate = face
            || match n.local_name.as_str() {
                "input" => !matches!(n.input_type(), "hidden" | "reset" | "button"),
                "button" => n.is_submit_button(),
                "select" | "textarea" => true,
                _ => false,
            };
        if !candidate || self.is_actually_disabled(id) {
            return false;
        }
        if (face || matches!(n.local_name.as_str(), "input" | "textarea")) && n.plain_attr("readonly").is_some() {
            return false;
        }
        let mut cur = self.parent_of(id);
        while let Some(c) = cur {
            if self.get(c).is_some_and(|p| p.is_html_element("datalist")) {
                return false;
            }
            cur = self.parent_of(c);
        }
        true
    }

    // The constraints `id` suffers from (dom-nodes.js `validity`), as the flags above.
    pub(crate) fn validity(&self, id: NodeId) -> u16 {
        let Some(n) = self.get(id).filter(|n| n.kind == NodeKind::Element && n.ns.is_empty()) else { return 0 };
        let mut v = if n.state & STATE_CUSTOM_ERROR != 0 { CUSTOM_ERROR } else { 0 };
        let tag = n.local_name.as_str();
        if !matches!(tag, "input" | "textarea" | "select") {
            return v;
        }
        let ty = if tag == "input" { n.input_type() } else { "" };
        let dirty_by_user = n.state & STATE_DIRTY_BY_USER != 0;
        if tag == "select" {
            if n.plain_attr("required").is_some() && self.select_suffers_value_missing(id) {
                v |= VALUE_MISSING;
            }
            return v;
        }
        let val = if tag == "textarea" { self.raw_value(n) } else { self.sanitized_value(n, ty) };
        let checkable = matches!(ty, "checkbox" | "radio");
        let empty = match ty {
            "checkbox" | "radio" => !self.is_checked(id),
            "file" => n.state & STATE_HAS_FILES == 0,
            _ => val.is_empty(),
        };
        if tag == "input" && ty == "number" && dirty_by_user {
            let raw = self.raw_value(n);
            if !raw.is_empty() && crate::validity::parse_number_field(&raw).is_none() {
                v |= BAD_INPUT;
            }
        }
        // valueMissing: a radio by its GROUP — some member required, none checked; any other where `required`
        // applies, on a mutable control (disabled / readonly spare only the types readonly applies to), when empty.
        if ty == "radio" {
            if n.plain_attr("name").is_some_and(|name| !name.is_empty()) && self.radio_group_misses_required(id) {
                v |= VALUE_MISSING;
            }
        } else {
            let required_applies = tag == "textarea"
                || !matches!(ty, "submit" | "image" | "reset" | "button" | "hidden" | "range" | "color");
            let readonly_applies = tag == "textarea" || READONLY_TYPES.contains(&ty);
            let mutable = !(readonly_applies && (self.is_actually_disabled(id) || n.plain_attr("readonly").is_some()));
            if required_applies && n.plain_attr("required").is_some() && empty && mutable {
                v |= VALUE_MISSING;
            }
        }
        if checkable || tag != "input" && tag != "textarea" || empty {
            return v;
        }
        if tag == "input" && PATTERN_TYPES.contains(&ty) && self.pattern_mismatch(n, ty) {
            v |= PATTERN_MISMATCH;
        }
        if tag == "input" {
            let bad_type = match ty {
                "email" if n.plain_attr("multiple").is_some() => !val.split(',').map(trim_ascii_ws).all(valid_email),
                "email" => !valid_email(&val),
                "url" => {
                    let scheme = val.find("://").map(|i| &val[..i]);
                    !scheme.is_some_and(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_alphabetic()))
                }
                _ => false,
            };
            if bad_type {
                v |= TYPE_MISMATCH;
            }
        }
        if dirty_by_user && (tag == "textarea" || LENGTH_TYPES.contains(&ty)) {
            let len = val.encode_utf16().count() as u64;
            if n.plain_attr("minlength").and_then(parse_non_negative).is_some_and(|min| len < min) {
                v |= TOO_SHORT;
            }
            if n.plain_attr("maxlength").and_then(parse_non_negative).is_some_and(|max| len > max) {
                v |= TOO_LONG;
            }
        }
        // (A range's value is sanitized into its range and onto its step — it suffers from neither.)
        if tag == "input" && ty != "range" {
            v |= self.range_and_step(n, ty, &val);
        }
        v
    }

    // rangeUnderflow / rangeOverflow / stepMismatch of a numeric or temporal input with value `val`.
    fn range_and_step(&self, n: &NodeData, ty: &str, val: &str) -> u16 {
        let Some((scale, default_step)) = step_scale(ty) else { return 0 };
        let Some(num) = number_of(ty, val) else { return 0 };
        let mut v = 0;
        let min = n.plain_attr("min").and_then(|m| number_of(ty, m));
        let max = n.plain_attr("max").and_then(|m| number_of(ty, m));
        match (min, max) {
            // A reversed range accepts value <= max or >= min: a value between suffers both.
            (Some(lo), Some(hi)) if lo > hi => {
                if num > hi && num < lo {
                    v |= RANGE_UNDERFLOW | RANGE_OVERFLOW;
                }
            }
            _ => {
                if min.is_some_and(|lo| num < lo) {
                    v |= RANGE_UNDERFLOW;
                }
                if max.is_some_and(|hi| num > hi) {
                    v |= RANGE_OVERFLOW;
                }
            }
        }
        let step_attr = n.plain_attr("step");
        if step_attr.is_some_and(|s| s.eq_ignore_ascii_case("any")) {
            return v;
        }
        let explicit = step_attr.filter(|s| parse_float(s).is_some_and(|x| x > 0.0));
        let step = explicit.and_then(parse_float).unwrap_or(default_step);
        let step_value = step * scale;
        // The step base: `min`, else the `value` attribute, else the type's default.
        let base = min.or_else(|| n.plain_attr("value").and_then(|x| number_of(ty, x))).unwrap_or(if ty == "week" {
            temporal_number("week", "1970-W01").unwrap_or(0.0)
        } else {
            0.0
        });
        if step_value <= 0.0 {
            return v;
        }
        let exact = if matches!(ty, "number" | "range") {
            let step_str = explicit.map(str::to_string).unwrap_or_else(|| format!("{step}"));
            let base_str = n
                .plain_attr("min")
                .filter(|m| parse_float(m).is_some())
                .or_else(|| n.plain_attr("value").filter(|x| parse_float(x).is_some()))
                .unwrap_or("0");
            decimal_step_mismatch(val, &step_str, base_str)
        } else {
            None
        };
        let mismatch = exact.unwrap_or_else(|| {
            let rem = ((num - base) % step_value).abs();
            let tol = if matches!(ty, "number" | "range") { 1e-9 * step_value.abs().max(1.0) } else { 0.0 };
            rem > tol && (rem - step_value).abs() > tol
        });
        if mismatch {
            v |= STEP_MISMATCH;
        }
        v
    }

    // A `<select>`'s valueMissing (dom-nodes.js `selectSuffersValueMissing`): nothing selected — or, for a drop-down,
    // only its placeholder label option (an empty-valued first option, a child of the select).
    fn select_suffers_value_missing(&self, id: NodeId) -> bool {
        let options = self.list_of_options(id);
        let selected: Vec<NodeId> = options.iter().copied().filter(|&o| self.is_selected(o)).collect();
        let Some(n) = self.get(id) else { return false };
        let size = n.plain_attr("size").and_then(|s| crate::validity::parse_html_integer(s)).filter(|&s| s > 0);
        let dropdown = n.plain_attr("multiple").is_none() && size.unwrap_or(1) == 1;
        if !dropdown {
            return selected.is_empty();
        }
        let placeholder = options
            .first()
            .copied()
            .filter(|&o| self.parent_of(o) == Some(id) && self.option_value(o).is_empty());
        selected.is_empty() || (selected.len() == 1 && Some(selected[0]) == placeholder)
    }
    // The select's list of options: its option descendants in tree order past transparent wrappers, an optgroup's
    // (not a nested optgroup's), none under an `<hr>`, a `<datalist>` or a nested `<select>`.
    fn list_of_options(&self, select: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        self.collect_options(select, false, &mut out);
        out
    }
    fn collect_options(&self, node: NodeId, in_optgroup: bool, out: &mut Vec<NodeId>) {
        let Some(n) = self.get(node) else { return };
        for &c in &n.children {
            let Some(e) = self.get(c).filter(|e| e.kind == NodeKind::Element) else { continue };
            match e.local_name.as_str() {
                "option" => out.push(c),
                "hr" | "datalist" | "select" => {}
                "optgroup" if in_optgroup => {}
                "optgroup" => self.collect_options(c, true, out),
                _ => self.collect_options(c, in_optgroup, out),
            }
        }
    }
    // An option's value: its `value` attribute, else its text with ASCII whitespace stripped and collapsed.
    fn option_value(&self, id: NodeId) -> String {
        let Some(n) = self.get(id) else { return String::new() };
        if let Some(v) = n.plain_attr("value") {
            return v.to_string();
        }
        let mut text: Vec<u16> = Vec::new();
        self.collect_text(id, &mut text);
        String::from_utf16_lossy(&text).split(is_ascii_ws).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ")
    }
    fn collect_text(&self, id: NodeId, out: &mut Vec<u16>) {
        let Some(n) = self.get(id) else { return };
        for &c in &n.children {
            match self.get(c) {
                Some(t) if t.kind == NodeKind::Text => out.extend_from_slice(&t.data),
                Some(e) if e.kind == NodeKind::Element && e.local_name != "script" => self.collect_text(c, out),
                _ => {}
            }
        }
    }

    // `:valid` / `:invalid`: a candidate by its own constraints; a `<form>` / `<fieldset>` by whether an invalid
    // candidate sits in it.
    pub(crate) fn is_valid_pseudo(&self, id: NodeId) -> Option<bool> {
        let n = self.get(id)?;
        if n.is_html_element("form") || n.is_html_element("fieldset") {
            return Some(!self.contains_invalid(id));
        }
        self.will_validate(id).then(|| self.validity(id) == 0)
    }
    // `:user-valid` / `:user-invalid`: the same, once the user has interacted with the control.
    pub(crate) fn is_user_valid_pseudo(&self, id: NodeId) -> Option<bool> {
        let n = self.get(id)?;
        if n.state & STATE_USER_INTERACTED == 0 || !self.will_validate(id) {
            return None;
        }
        Some(self.validity(id) == 0)
    }
    // `:in-range` / `:out-of-range`: a candidate whose type has a range and which has a `min` or a `max`, by whether it
    // suffers an underflow or an overflow.
    pub(crate) fn is_in_range(&self, id: NodeId) -> Option<bool> {
        let n = self.get(id).filter(|n| n.is_html_element("input"))?;
        let ty = n.input_type();
        step_scale(ty)?;
        if n.plain_attr("min").is_none() && n.plain_attr("max").is_none() || !self.will_validate(id) {
            return None;
        }
        Some(self.validity(id) & (RANGE_UNDERFLOW | RANGE_OVERFLOW) == 0)
    }
}

// HTML "rules for parsing integers", or None.
pub(crate) fn parse_html_integer(s: &str) -> Option<i64> {
    let s = s.trim_start_matches(is_ascii_ws);
    let (neg, s) = match s.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let digits = &s[..s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len())];
    if digits.is_empty() {
        return None;
    }
    let v = digits.bytes().fold(0i64, |v, d| v.saturating_mul(10).saturating_add(i64::from(d - b'0')));
    Some(if neg { -v } else { v })
}
// A number field's text as a user may type it (dom-nodes.js `parseNumberFieldValue`): a sign, digits with a point, an
// exponent — or None when it converts to no finite number (badInput).
pub(crate) fn parse_number_field(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let mut i = usize::from(matches!(b.first(), Some(b'-' | b'+')));
    let start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - start;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let f0 = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if int_digits == 0 && i == f0 {
            return None;
        }
    } else if int_digits == 0 {
        return None;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let e0 = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == e0 {
            return None;
        }
    }
    if i != b.len() {
        return None;
    }
    s.parse::<f64>().ok().filter(|x| x.is_finite())
}

// The compiled form of a `pattern` (by its UTF-16 text): anchored — `^(?:pattern)$` — with the `v` flag, or None when
// the pattern does not compile ON ITS OWN (HTML: a pattern that fails to compile is ignored — and the wrapper must not
// balance an unbalanced one like `a)(b`). A page has a handful of patterns; the cache is dropped whole past a bound.
thread_local! {
    static PATTERNS: RefCell<HashMap<Vec<u16>, Option<Rc<regress::Regex>>>> = RefCell::new(HashMap::new());
    // …and whether a value fails a pattern, by (pattern, value): a style read asks again for an unchanged field, and a
    // backtracking pattern (`(a+)+b`) takes time exponential in the value to answer.
    static PATTERN_RESULTS: RefCell<HashMap<(Vec<u16>, Vec<u16>), bool>> = RefCell::new(HashMap::new());
}
const PATTERN_CACHE_LIMIT: usize = 256;
fn compiled_pattern(pattern: &[u16]) -> Option<Rc<regress::Regex>> {
    if let Some(hit) = PATTERNS.with_borrow(|c| c.get(pattern).cloned()) {
        return hit;
    }
    // Code points, a lone surrogate as itself (regress parses from u32s).
    let points = |u: &[u16]| -> Vec<u32> {
        char::decode_utf16(u.iter().copied()).map(|r| r.map_or_else(|e| u32::from(e.unpaired_surrogate()), u32::from)).collect()
    };
    let alone = points(pattern);
    let compiled = regress::Regex::from_unicode(alone.iter().copied(), "v").ok().and_then(|_| {
        let mut anchored: Vec<u32> = "^(?:".chars().map(u32::from).collect();
        anchored.extend(alone.iter().copied());
        anchored.extend(")$".chars().map(u32::from));
        regress::Regex::from_unicode(anchored.iter().copied(), "v").ok().map(Rc::new)
    });
    PATTERNS.with_borrow_mut(|c| {
        if c.len() >= PATTERN_CACHE_LIMIT {
            c.clear();
        }
        c.insert(pattern.to_vec(), compiled.clone());
    });
    compiled
}
fn is_ascii_ws_unit(u: u16) -> bool {
    matches!(u, 0x09 | 0x0A | 0x0C | 0x0D | 0x20)
}
fn trim_ascii_ws_units(u: &[u16]) -> &[u16] {
    let start = u.iter().position(|&c| !is_ascii_ws_unit(c)).unwrap_or(u.len());
    let end = u.iter().rposition(|&c| !is_ascii_ws_unit(c)).map_or(start, |e| e + 1);
    &u[start..end]
}

impl RealmArena {
    // patternMismatch of a non-empty input of a type `pattern` applies to: its sanitized value — each of a multiple
    // email's non-empty tokens — does not match the whole pattern. Over UTF-16, as the value getter returns it.
    fn pattern_mismatch(&self, n: &NodeData, ty: &str) -> bool {
        let Some(pattern) = n.plain_attr_units("pattern") else { return false };
        let raw: Vec<u16> = match &n.value {
            Some(v) => v.to_vec(),
            None => n.plain_attr_units("value").unwrap_or_default(),
        };
        // (The type decides how the value is cut and trimmed, so it is part of the value's key.)
        let mut key_value = raw.clone();
        key_value.extend(ty.encode_utf16());
        key_value.push(u16::from(n.plain_attr("multiple").is_some()));
        let key = (pattern, key_value);
        if let Some(hit) = PATTERN_RESULTS.with_borrow(|c| c.get(&key).copied()) {
            return hit;
        }
        let answer = self.pattern_mismatch_uncached(n, ty, &key.0, &raw);
        PATTERN_RESULTS.with_borrow_mut(|c| {
            if c.len() >= PATTERN_CACHE_LIMIT {
                c.clear();
            }
            c.insert(key, answer);
        });
        answer
    }
    fn pattern_mismatch_uncached(&self, n: &NodeData, ty: &str, pattern: &[u16], raw: &[u16]) -> bool {
        let Some(re) = compiled_pattern(pattern) else { return false };
        let fails = |s: &[u16]| re.find_from_utf16(s, 0).next().is_none();
        let strip = |u: &[u16]| u.iter().copied().filter(|&c| c != 0x0D && c != 0x0A).collect::<Vec<u16>>();
        match ty {
            "email" if n.plain_attr("multiple").is_some() => raw
                .split(|&c| c == u16::from(b','))
                .map(trim_ascii_ws_units)
                .filter(|t| !t.is_empty())
                .any(fails),
            "url" | "email" => fails(trim_ascii_ws_units(&strip(raw))),
            _ => fails(&strip(raw)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::compiled_pattern;

    fn units(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }
    fn matches(pattern: &str, value: &str) -> Option<bool> {
        compiled_pattern(&units(pattern)).map(|re| re.find_from_utf16(&units(value), 0).next().is_some())
    }

    #[test]
    fn a_pattern_matches_the_whole_value_with_the_v_flag() {
        assert_eq!(matches("[a-z]{3}", "abc"), Some(true));
        assert_eq!(matches("[a-z]{3}", "abcd"), Some(false));
        assert_eq!(matches("a|b", "ab"), Some(false)); // anchored around the whole alternation
        assert_eq!(matches("a.b", "a\u{1D306}b"), Some(true)); // code points, not code units
        assert_eq!(matches(r"\p{RGI_Emoji}+", "\u{1F618}\u{1F48B}"), Some(true));
        assert_eq!(matches(r"[\p{L}--[a-z]]+", "ÄÖ"), Some(true));
    }

    #[test]
    fn a_pattern_that_does_not_compile_alone_is_ignored() {
        assert_eq!(matches("(", "x"), None);
        assert_eq!(matches("a)(b", "a)(b"), None); // the anchoring wrapper would balance it
        assert_eq!(matches("[(]", "("), None); // a reserved class-set character under `v`
    }

    #[test]
    fn a_lone_surrogate_is_a_character_of_its_own() {
        let value = vec![0x61, 0xD800, 0x62];
        let re = compiled_pattern(&units("a.b")).unwrap();
        assert!(re.find_from_utf16(&value, 0).next().is_some());
    }
}
